import { resolveQueryPropertyType } from './property-coercion';
import { BUILT_IN_SCOPES } from './scopes';
import type {
	LeafMatcher,
	PropertyFilterNode,
	ResolvedEngineConfig,
	ScopeDefinition,
	SearchAST,
	SearchDiagnostic,
	SourceSpan,
	TextMatchNode,
	ValueExprAST,
} from './types';

const DEFAULT_SCOPE_MAP: ReadonlyMap<string, ScopeDefinition> = (() => {
	const map = new Map<string, ScopeDefinition>();
	for (const def of BUILT_IN_SCOPES) {
		map.set(def.canonicalName.trim().toLowerCase(), def);
		for (const alias of def.aliases) {
			map.set(alias.trim().toLowerCase(), def);
		}
	}
	return map;
})();

type SingleValuedField =
	'file.extension' | 'file.name' | 'file.basename' | 'file.path' | 'file.parent';

interface SingleValueEquality {
	readonly field: SingleValuedField;
	readonly normalized: string;
	readonly raw: string;
}

/**
 * Builds the `HINT_WIKILINK_BRACKETS_IN_SCOPE` diagnostic emitted when `[[...]]` is used in a scope or property RHS.
 */
export function createWikilinkBracketsHint(span: SourceSpan | null): SearchDiagnostic {
	return {
		code: 'HINT_WIKILINK_BRACKETS_IN_SCOPE',
		severity: 'hint',
		issue: 'Wikilink brackets "[[...]]" are not needed.',
		hint: 'Stripped "[[...]]" automatically.',
		span,
	};
}

/**
 * Builds the `WARN_UNQUOTED_MULTIWORD_SCOPE` diagnostic emitted when an unquoted scoped filter is followed by a bare term on the same line without an explicit `AND`.
 */
export function createUnquotedMultiwordScopeWarning(
	scope: string,
	leftVal: string,
	nextVal: string,
	span: SourceSpan | null,
): SearchDiagnostic {
	return {
		code: 'WARN_UNQUOTED_MULTIWORD_SCOPE',
		severity: 'warning',
		issue: `"${nextVal}" is searched as a separate term, not inside "${scope}:".`,
		hint: `Use ${scope}:"${leftVal} ${nextVal}"`,
		span,
	};
}

/**
 * Builds the `HINT_UNCLOSED_REGEX` diagnostic emitted when an unquoted string leaf starts with `/`.
 */
export function createUnclosedRegexHint(
	rawValue: string,
	span: SourceSpan | null,
): SearchDiagnostic {
	return {
		code: 'HINT_UNCLOSED_REGEX',
		severity: 'hint',
		issue: `Unquoted "${rawValue}" starts with "/" and is searched as literal text.`,
		hint: 'Add a closing "/" for a regular expression, or wrap in quotes for literal text.',
		span,
	};
}

function isUnclosedRegexMatcher(
	matcher: LeafMatcher,
): matcher is Extract<LeafMatcher, { kind: 'string' }> {
	return (
		matcher.kind === 'string' &&
		!matcher.quoted &&
		matcher.value.startsWith('/') &&
		matcher.value !== '//'
	);
}

function lintUnclosedRegexInValueExpr(
	expr: ValueExprAST,
	span: SourceSpan | null,
	diagnostics: SearchDiagnostic[],
): void {
	switch (expr.type) {
		case 'VALUE_LEAF':
			if (isUnclosedRegexMatcher(expr.matcher)) {
				diagnostics.push(createUnclosedRegexHint(expr.matcher.value, span));
			}
			return;
		case 'VALUE_NOT':
			lintUnclosedRegexInValueExpr(expr.child, span, diagnostics);
			return;
		case 'VALUE_LOGICAL':
			for (const child of expr.children) {
				lintUnclosedRegexInValueExpr(child, span, diagnostics);
			}
			return;
	}
}

function extractSingleValueEquality(child: SearchAST): SingleValueEquality | null {
	if (
		child.type === 'SCOPED_FILTER' &&
		child.scope === 'ext' &&
		child.expr.type === 'VALUE_LEAF' &&
		child.expr.matcher.kind === 'string'
	) {
		const raw = child.expr.matcher.value;
		return {
			field: 'file.extension',
			normalized: raw.trim().toLowerCase().replace(/^\./, ''),
			raw,
		};
	}

	if (
		child.type === 'PROPERTY_FILTER' &&
		child.operator === '=' &&
		child.valueExpr?.type === 'VALUE_LEAF' &&
		child.valueExpr.matcher.kind === 'string'
	) {
		const raw = child.valueExpr.matcher.value;
		if (child.key === 'file.extension') {
			return {
				field: 'file.extension',
				normalized: raw.trim().toLowerCase().replace(/^\./, ''),
				raw,
			};
		}
		if (
			child.key === 'file.name' ||
			child.key === 'file.basename' ||
			child.key === 'file.path' ||
			child.key === 'file.parent'
		) {
			return {
				field: child.key,
				normalized: raw.toLowerCase(),
				raw,
			};
		}
	}

	return null;
}

export function encodeDoubleQuoted(value: string): string {
	let out = '"';
	for (const ch of value) {
		if (ch === '\\') out += '\\\\';
		else if (ch === '"') out += '\\"';
		else if (ch === '\n') out += '\\n';
		else if (ch === '\r') out += '\\r';
		else if (ch === '\t') out += '\\t';
		else out += ch;
	}
	return out + '"';
}

export function formatLeafMatcher(matcher: LeafMatcher): string {
	if (matcher.kind === 'regex') {
		return `/${matcher.pattern}/${matcher.flags}`;
	}
	return matcher.quoted ? encodeDoubleQuoted(matcher.value) : matcher.value;
}

export function formatValueExprInner(expr: ValueExprAST, parentOp?: 'AND' | 'OR' | 'NOT'): string {
	switch (expr.type) {
		case 'VALUE_LEAF':
			return formatLeafMatcher(expr.matcher);
		case 'VALUE_NOT': {
			const child =
				expr.child.type === 'VALUE_LOGICAL'
					? `(${formatValueExprInner(expr.child)})`
					: formatValueExprInner(expr.child, 'NOT');
			return expr.syntax === '!' ? `!${child}` : `NOT ${child}`;
		}
		case 'VALUE_LOGICAL': {
			const joined = expr.children
				.map((child) => formatValueExprInner(child, expr.operator))
				.join(` ${expr.operator} `);
			return parentOp && parentOp !== expr.operator ? `(${joined})` : joined;
		}
	}
}

export function formatScopeRhsDisplay(valueExpr: ValueExprAST): string {
	if (valueExpr.type === 'VALUE_LEAF') {
		return formatLeafMatcher(valueExpr.matcher);
	}
	return `(${formatValueExprInner(valueExpr)})`;
}

export function formatRhsDisplay(valueExpr: ValueExprAST | undefined): string {
	if (!valueExpr || valueExpr.type !== 'VALUE_LEAF') return '...';
	if (valueExpr.matcher.kind === 'regex') {
		return `/${valueExpr.matcher.pattern}/${valueExpr.matcher.flags}`;
	}
	return valueExpr.matcher.quoted ? `"${valueExpr.matcher.value}"` : valueExpr.matcher.value;
}

/**
 * Runs the non-blocking AST linter pass (Section 4.3) and returns warnings and hints.
 */
export function lintQueryAST(
	ast: SearchAST,
	invalidPropertyNodes?: ReadonlySet<PropertyFilterNode>,
	resolvedConfig?: ResolvedEngineConfig,
): SearchDiagnostic[] {
	const diagnostics: SearchDiagnostic[] = [];
	const flaggedTextNodes = new Set<TextMatchNode>();
	const getScope = (nameOrAlias: string): ScopeDefinition | undefined =>
		resolvedConfig
			? resolvedConfig.getScope(nameOrAlias)
			: DEFAULT_SCOPE_MAP.get(nameOrAlias.trim().toLowerCase());

	function traverse(node: SearchAST): void {
		switch (node.type) {
			case 'MATCH_ALL':
				return;

			case 'SCOPED_FILTER':
				lintUnclosedRegexInValueExpr(node.expr, node.span ?? null, diagnostics);
				return;

			case 'PROPERTY_FILTER': {
				if (!invalidPropertyNodes?.has(node)) {
					if (node.operator === '!=') {
						const rhsDisplay = formatRhsDisplay(node.valueExpr);
						diagnostics.push({
							code: 'HINT_PROP_NEQ_EXISTENCE',
							severity: 'hint',
							issue: `"[${node.key}:!=${rhsDisplay}]" requires "${node.key}" to exist.`,
							hint: `To exclude notes (including notes missing "${node.key}"), use "![${node.key}:=${rhsDisplay}]".`,
							span: node.span ?? null,
						});
					} else if (node.operator === ':' && node.valueExpr !== undefined) {
						const scopeDef = getScope(node.key);
						if (scopeDef !== undefined) {
							const canonical = scopeDef.canonicalName;
							const rhsDisplay = formatScopeRhsDisplay(node.valueExpr);
							const isCanonicalMatch = node.key === canonical.toLowerCase();
							diagnostics.push({
								code: 'HINT_PROPERTY_MATCHES_SCOPE',
								severity: 'hint',
								issue: isCanonicalMatch
									? `The property "${node.key}" matches the name of scope "${canonical}".`
									: `The property "${node.key}" matches an alias of scope "${canonical}".`,
								hint: `Did you mean "${canonical}:${rhsDisplay}" instead?`,
								span: node.span ?? null,
							});
						}
						const propType = resolveQueryPropertyType(
							node.key,
							resolvedConfig?.propertyTypes ?? {},
						);
						if (propType !== 'checkbox') {
							lintUnclosedRegexInValueExpr(
								node.valueExpr,
								node.span ?? null,
								diagnostics,
							);
						}
					}
				}
				return;
			}

			case 'TEXT_MATCH': {
				if (node.matcher.kind === 'string' && !node.matcher.quoted) {
					const lower = node.rawText.toLowerCase();
					if (
						(lower === 'and' || lower === 'or' || lower === 'not') &&
						node.rawText !== node.rawText.toUpperCase()
					) {
						flaggedTextNodes.add(node);
						diagnostics.push({
							code: 'WARN_LOWERCASE_BOOLEAN',
							severity: 'warning',
							issue: `Lowercase "${node.rawText}" is searched as literal text.`,
							hint: `Use uppercase "${node.rawText.toUpperCase()}".`,
							span: node.span ?? null,
						});
					}
				}
				if (!flaggedTextNodes.has(node) && isUnclosedRegexMatcher(node.matcher)) {
					flaggedTextNodes.add(node);
					diagnostics.push(
						createUnclosedRegexHint(node.matcher.value, node.span ?? null),
					);
				}
				if (!flaggedTextNodes.has(node)) {
					diagnostics.push({
						code: 'HINT_BARE_TEXT_NO_BODY',
						severity: 'hint',
						issue: 'Bare terms only search filenames, paths, aliases, and tags (note body is not indexed).',
						hint: null,
						span: node.span ?? null,
					});
				}
				return;
			}

			case 'NOT':
				traverse(node.child);
				return;

			case 'LOGICAL': {
				if (node.operator === 'AND') {
					const seenByField = new Map<
						SingleValuedField,
						{ normalized: string; raw: string }
					>();
					const contradictedFields = new Set<SingleValuedField>();
					for (const child of node.children) {
						const eq = extractSingleValueEquality(child);
						if (!eq) continue;
						const prev = seenByField.get(eq.field);
						if (!prev) {
							seenByField.set(eq.field, { normalized: eq.normalized, raw: eq.raw });
						} else if (
							prev.normalized !== eq.normalized &&
							!contradictedFields.has(eq.field)
						) {
							contradictedFields.add(eq.field);
							const childSpan = 'span' in child ? child.span : undefined;
							diagnostics.push({
								code: 'WARN_SINGLE_VALUE_CONTRADICTION',
								severity: 'warning',
								issue: `A single file cannot match both "${prev.raw}" and "${eq.raw}" on the same single-valued field.`,
								hint: 'Did you mean "OR"?',
								span: node.span ?? childSpan ?? null,
							});
						}
					}
				} else if (node.operator === 'OR') {
					for (const child of node.children) {
						if (
							child.type === 'LOGICAL' &&
							child.operator === 'AND' &&
							child.parenthesized !== true
						) {
							diagnostics.push({
								code: 'HINT_AMBIGUOUS_PRECEDENCE',
								severity: 'hint',
								issue: 'Evaluated as "(A AND B) OR C".',
								hint: 'Add parentheses to make precedence explicit.',
								span: child.span ?? node.span ?? null,
							});
						}
					}
				}

				for (const child of node.children) {
					traverse(child);
				}
				return;
			}
		}
	}

	traverse(ast);
	return diagnostics;
}
