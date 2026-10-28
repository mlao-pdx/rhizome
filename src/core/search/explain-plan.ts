import { initEngineConfig } from './config';
import {
	buildRegex101Url,
	describeScopeSemantics,
	escapeMarkdownTableCell,
	formatAuthoredFilter,
	formatDateIntervalWindow,
	formatEpochTimestamp,
	formatInlineCode,
	formatLeafMatcher,
	formatScopeRhsDisplay,
	formatSourceCaretSnippet,
	resolvePropertyTypeWithOrigin,
} from './explain-helpers';
import { renderExplainMermaid } from './explain-mermaid';
import { lintQueryAST } from './linter';
import { validateRegexLiteral } from './literals';
import { parseAndLowerQuery } from './parser';
import { FORBIDDEN_KEYS, STRICT_NUMBER_RE } from './property-coercion';
import { normalizeTagBody } from './scopes';
import { isValidReferenceTimeMs, parseTemporalExpr } from './temporal';
import {
	isValidPropertyType,
	type EngineConfig,
	type LeafMatcher,
	type ObsidianPropertyType,
	type PropertyFilterNode,
	type PropertyOperator,
	type PropertyTypeRegistry,
	type ResolvedEngineConfig,
	type ScopedFilterNode,
	type SearchAST,
	type SearchDiagnostic,
	type ValueExprAST,
} from './types';
import { suggestScopeHint, validateQueryAST } from './validator';

interface RegexReferenceEntry {
	readonly literal: string;
	readonly contextDesc: string;
	readonly valid: boolean;
	readonly url: string;
}

function isResolvedEngineConfig(
	cfg: ResolvedEngineConfig | EngineConfig,
): cfg is ResolvedEngineConfig {
	return (
		typeof cfg === 'object' &&
		cfg !== null &&
		'__brand' in cfg &&
		cfg.__brand === 'ResolvedEngineConfig'
	);
}

function buildFallbackResolvedConfig(raw: EngineConfig): ResolvedEngineConfig {
	const cleanTypes = Object.create(null) as PropertyTypeRegistry;
	for (const [rawKey, val] of Object.entries(raw?.propertyTypes ?? {})) {
		const key = rawKey.trim().toLowerCase();
		if (!key || FORBIDDEN_KEYS.has(key) || FORBIDDEN_KEYS.has(rawKey)) continue;
		if (isValidPropertyType(val) && !Object.prototype.hasOwnProperty.call(cleanTypes, key)) {
			cleanTypes[key] = val;
		}
	}
	const rawTz = typeof raw?.timeZone === 'string' ? raw.timeZone.trim() : '';
	const withTz = initEngineConfig({ timeZone: rawTz || 'UTC', propertyTypes: cleanTypes });
	if (withTz.ok) return withTz.config;
	const fallbackUtc = initEngineConfig({ timeZone: 'UTC', propertyTypes: cleanTypes });
	if (fallbackUtc.ok) return fallbackUtc.config;
	const minimal = initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
	if (!minimal.ok) throw new Error('Unreachable: UTC empty config must succeed');
	return minimal.config;
}

function formatRegexLink(matcher: Extract<LeafMatcher, { kind: 'regex' }>): string {
	const literal = formatLeafMatcher(matcher);
	const url = buildRegex101Url(matcher.pattern, matcher.flags);
	return `${formatInlineCode(literal)} ([Explain on regex101 ↗](${url}))`;
}

function describePropertyLeafCoercion(
	matcher: LeafMatcher,
	propType: ObsidianPropertyType,
	operator: PropertyOperator,
	timeZone: string,
	referenceTimeMs: number,
	validRefTime: boolean,
): string {
	if (matcher.kind === 'regex') {
		const valid = validateRegexLiteral(matcher.pattern, matcher.flags) !== null;
		const link = formatRegexLink(matcher);
		if (operator !== ':' || propType === 'checkbox') {
			return `❌ ${link} — regular expressions cannot be used with operator \`${operator}\` on \`${propType}\``;
		}
		const targetDesc =
			propType === 'number' || propType === 'date' || propType === 'datetime'
				? `raw authored string (\`entry.raw\`) of \`${propType}\``
				: `\`${propType}\` value`;
		return `${valid ? '' : '❌ Invalid regex: '}${link} tested against ${targetDesc}`;
	}

	const rawLit = formatInlineCode(formatLeafMatcher(matcher));
	switch (propType) {
		case 'number': {
			const trimmed = matcher.value.trim();
			const ok =
				!matcher.quoted &&
				STRICT_NUMBER_RE.test(trimmed) &&
				Number.isFinite(Number(trimmed));
			return ok
				? `${rawLit} → numeric \`${Number(trimmed)}\` (\`entry.value ${operator === ':' ? '=' : operator} ${Number(trimmed)}\`)`
				: `❌ ${rawLit} (not a valid unquoted finite number)`;
		}
		case 'checkbox': {
			if (operator === '<' || operator === '>' || operator === '<=' || operator === '>=') {
				return `❌ ${rawLit} — ordering operator \`${operator}\` cannot be used on \`checkbox\` properties`;
			}
			const lower = matcher.value.trim().toLowerCase();
			const ok = !matcher.quoted && (lower === 'true' || lower === 'false');
			return ok
				? `${rawLit} → boolean \`${lower}\` (\`entry.value ${operator === ':' ? '=' : operator} ${lower}\`)`
				: `❌ ${rawLit} (checkbox requires unquoted \`true\` or \`false\`)`;
		}
		case 'date':
		case 'datetime': {
			const res = parseTemporalExpr(matcher.value, {
				allowYearOnly: true,
				allowRelative: true,
				timeZone,
				referenceTimeMs,
			});
			if (!res.ok) {
				return `❌ ${rawLit} (invalid ${propType} expression: \`${res.reason}\`)`;
			}
			const win = formatDateIntervalWindow(res.interval, operator, timeZone);
			const fallbackNote =
				!validRefTime && /(?:^|\.\.)\s*@/.test(matcher.value.trim())
					? ' *(resolved against fallback epoch `0` because `referenceTimeMs` is invalid)*'
					: '';
			return `${rawLit} → \`${win.grain}\` window \`${win.localWindow}\` (UTC \`${win.utcWindow}\`; matches when \`${win.inequality}\`, i.e. ${win.description})${fallbackNote}`;
		}
		case 'tags': {
			const normTag = normalizeTagBody(matcher.value);
			return operator === ':'
				? `${rawLit} → hierarchical tag match on \`#${normTag}\` (matches \`#${normTag}\` or \`#${normTag}/...\`)`
				: `${rawLit} → normalized tag \`${normTag}\` compared with \`${operator}\``;
		}
		case 'text':
		case 'multitext':
			return operator === ':'
				? `${rawLit} → case-insensitive substring match`
				: `${rawLit} → case-insensitive lexicographical comparison (\`${operator}\`)`;
	}
}

function renderValueExprBullets(
	expr: ValueExprAST,
	indent: string,
	leafFormatter: (matcher: LeafMatcher) => string,
	out: string[],
): void {
	switch (expr.type) {
		case 'VALUE_LEAF':
			out.push(`${indent}- ${leafFormatter(expr.matcher)}`);
			return;
		case 'VALUE_NOT':
			out.push(
				`${indent}- **Exclude value (\`${expr.syntax}\`)**: Value must **not** match:`,
			);
			renderValueExprBullets(expr.child, `${indent}  `, leafFormatter, out);
			return;
		case 'VALUE_LOGICAL': {
			const opDesc =
				expr.operator === 'AND'
					? '**All value conditions (`AND`)**: The **same** extracted value must satisfy:'
					: '**Any value condition (`OR`)**: The extracted value must satisfy at least one of:';
			out.push(`${indent}- ${opDesc}`);
			for (const child of expr.children) {
				renderValueExprBullets(child, `${indent}  `, leafFormatter, out);
			}
			return;
		}
	}
}

/**
 * Generates a 3-section Diátaxis Markdown explanation plan for a search query without scanning vault notes.
 */
export function explainQuery(
	input: string,
	configOrResolved: ResolvedEngineConfig | EngineConfig,
	referenceTimeMs: number,
): string {
	const configDiagnostics: SearchDiagnostic[] = [];
	let resolvedConfig: ResolvedEngineConfig | null = null;
	let displayTimeZone: string;

	let effectiveConfig: ResolvedEngineConfig;
	if (isResolvedEngineConfig(configOrResolved)) {
		resolvedConfig = configOrResolved;
		effectiveConfig = configOrResolved;
		displayTimeZone = configOrResolved.timeZone;
	} else {
		displayTimeZone =
			typeof configOrResolved?.timeZone === 'string'
				? configOrResolved.timeZone.trim() || String(configOrResolved.timeZone)
				: String(configOrResolved?.timeZone ?? '');
		const cfgRes = initEngineConfig(configOrResolved);
		if (cfgRes.ok) {
			resolvedConfig = cfgRes.config;
			effectiveConfig = cfgRes.config;
		} else {
			configDiagnostics.push(...cfgRes.diagnostics);
			effectiveConfig = buildFallbackResolvedConfig(configOrResolved);
		}
	}
	const validRefTime = isValidReferenceTimeMs(referenceTimeMs);
	const refTimeDiagnostics: SearchDiagnostic[] = validRefTime
		? []
		: [
				{
					code: 'ERROR_INVALID_CONFIG',
					severity: 'error',
					issue: `Invalid referenceTimeMs "${String(referenceTimeMs)}". Must be a safe integer within [-8640000000000000, 8640000000000000].`,
					hint: 'Provide a valid UTC epoch millisecond timestamp (e.g. Date.now()).',
					span: null,
				},
			];
	const effectiveRefTimeMs = validRefTime ? referenceTimeMs : 0;

	const parsed = parseAndLowerQuery(input);
	let resolvedAst: SearchAST | null = null;
	let valDiagnostics: SearchDiagnostic[] = [];
	let lintDiagnostics: SearchDiagnostic[] = [];
	let invalidPropertyNodes: ReadonlySet<PropertyFilterNode> = parsed.invalidPropertyNodes;
	const unknownScopeNodes = new Set<ScopedFilterNode>();
	const invalidRegexNodes = new Set<SearchAST>();

	if (parsed.ast !== null) {
		const valRes = validateQueryAST(
			parsed.ast,
			effectiveConfig,
			effectiveRefTimeMs,
			parsed.invalidPropertyNodes,
		);
		resolvedAst = valRes.ast;
		valDiagnostics = valRes.diagnostics;
		invalidPropertyNodes = valRes.invalidPropertyNodes;
		lintDiagnostics = lintQueryAST(resolvedAst, invalidPropertyNodes, effectiveConfig);
	}

	const regexEntries: RegexReferenceEntry[] = [];
	const filterNodes: Array<ScopedFilterNode | PropertyFilterNode> = [];

	function collectAstMetadata(node: SearchAST): void {
		switch (node.type) {
			case 'MATCH_ALL':
				return;
			case 'LOGICAL':
				for (const child of node.children) collectAstMetadata(child);
				return;
			case 'NOT':
				collectAstMetadata(node.child);
				return;
			case 'TEXT_MATCH':
				if (node.matcher.kind === 'regex') {
					const valid =
						validateRegexLiteral(node.matcher.pattern, node.matcher.flags) !== null;
					if (!valid) invalidRegexNodes.add(node);
					regexEntries.push({
						literal: formatLeafMatcher(node.matcher),
						contextDesc:
							'Bare regex — tested against `file.basename`, `file.path`, `aliases`, and `tags` (note body is never searched)',
						valid,
						url: buildRegex101Url(node.matcher.pattern, node.matcher.flags),
					});
				}
				return;
			case 'SCOPED_FILTER': {
				filterNodes.push(node);
				if (node.rawScope !== '#' && !effectiveConfig.getScope(node.rawScope)) {
					unknownScopeNodes.add(node);
				}
				const sem = describeScopeSemantics(node.scope);
				const visitExpr = (expr: ValueExprAST): void => {
					if (expr.type === 'VALUE_LEAF') {
						if (expr.matcher.kind === 'regex') {
							const valid =
								validateRegexLiteral(expr.matcher.pattern, expr.matcher.flags) !==
								null;
							if (!valid) invalidRegexNodes.add(node);
							regexEntries.push({
								literal: formatLeafMatcher(expr.matcher),
								contextDesc: `Scope \`${node.scope}\` — tested against ${sem.targetsDescription}`,
								valid,
								url: buildRegex101Url(expr.matcher.pattern, expr.matcher.flags),
							});
						}
					} else if (expr.type === 'VALUE_NOT') {
						visitExpr(expr.child);
					} else {
						for (const c of expr.children) visitExpr(c);
					}
				};
				visitExpr(node.expr);
				return;
			}
			case 'PROPERTY_FILTER': {
				filterNodes.push(node);
				if (!node.valueExpr) return;
				const typeInfo = resolvePropertyTypeWithOrigin(
					node.key,
					effectiveConfig.propertyTypes,
				);
				const visitExpr = (expr: ValueExprAST): void => {
					if (expr.type === 'VALUE_LEAF') {
						if (expr.matcher.kind === 'regex') {
							const valid =
								validateRegexLiteral(expr.matcher.pattern, expr.matcher.flags) !==
								null;
							if (!valid) invalidRegexNodes.add(node);
							let targetNote: string;
							if (node.operator !== ':' || typeInfo.type === 'checkbox') {
								targetNote = `Property \`${node.key}\` (\`${typeInfo.type}\`) — ❌ unsupported with operator \`${node.operator}\` on \`${typeInfo.type}\``;
							} else if (
								typeInfo.type === 'number' ||
								typeInfo.type === 'date' ||
								typeInfo.type === 'datetime'
							) {
								targetNote = `Property \`${node.key}\` (\`${typeInfo.type}\`) — tested against raw authored string \`entry.raw\``;
							} else {
								targetNote = `Property \`${node.key}\` (\`${typeInfo.type}\`) — tested against normalized string \`entry.value\``;
							}
							regexEntries.push({
								literal: formatLeafMatcher(expr.matcher),
								contextDesc: targetNote,
								valid:
									valid && node.operator === ':' && typeInfo.type !== 'checkbox',
								url: buildRegex101Url(expr.matcher.pattern, expr.matcher.flags),
							});
						}
					} else if (expr.type === 'VALUE_NOT') {
						visitExpr(expr.child);
					} else {
						for (const c of expr.children) visitExpr(c);
					}
				};
				visitExpr(node.valueExpr);
				return;
			}
		}
	}

	if (resolvedAst !== null) {
		collectAstMetadata(resolvedAst);
	}

	const allDiagnostics: SearchDiagnostic[] = [
		...configDiagnostics,
		...refTimeDiagnostics,
		...parsed.diagnostics,
		...valDiagnostics,
		...lintDiagnostics,
	];
	const errorCount = allDiagnostics.filter((d) => d.severity === 'error').length;
	const warningCount = allDiagnostics.filter((d) => d.severity === 'warning').length;
	const hintCount = allDiagnostics.filter((d) => d.severity === 'hint').length;
	const executable = resolvedAst !== null && errorCount === 0;

	const lines: string[] = ['# Query Explain Plan', ''];

	// =========================================================================
	// SECTION 1: Explanation — How This Query Matches Notes
	// =========================================================================
	lines.push('## Explanation — How This Query Matches Notes', '');
	const queryDisplay = input.trim().length === 0 ? '_(empty query)_' : formatInlineCode(input);
	const statusBadge = executable
		? '**Executable**'
		: `**Not Executable** (${errorCount} error${errorCount === 1 ? '' : 's'})`;
	lines.push(`- **Query**: ${queryDisplay}`);
	lines.push(
		`- **Status**: ${statusBadge} — ${errorCount} error${errorCount === 1 ? '' : 's'}, ${warningCount} warning${warningCount === 1 ? '' : 's'}, ${hintCount} hint${hintCount === 1 ? '' : 's'}.`,
	);

	if (resolvedAst === null) {
		lines.push(
			'',
			'This query could not be parsed into an execution tree because of a syntax or query-length error. See **Troubleshooting & Diagnostics** below for the exact location and fix.',
			'',
		);
	} else {
		lines.push('');
		lines.push('### Plain-English Logic Breakdown', '');
		lines.push(
			'> Operator precedence: negation (`-` / `NOT`) binds tightest, followed by conjunction (`AND`, including implicit whitespace `AND`), and finally disjunction (`OR`). Parentheses `(...)` override default precedence.',
			'',
		);

		const bulletLines: string[] = [];
		const renderAstBullets = (node: SearchAST, indent: string, isRoot: boolean): void => {
			switch (node.type) {
				case 'MATCH_ALL':
					bulletLines.push(
						`${indent}- **Match All Notes (\`MATCH_ALL\`)**: Because the query is empty or whitespace-only, every Markdown note in the vault matches.`,
					);
					return;
				case 'LOGICAL': {
					const groupNote = node.parenthesized
						? ' (explicitly parenthesized group)'
						: isRoot
							? ' (top-level)'
							: '';
					if (node.operator === 'AND') {
						bulletLines.push(
							`${indent}- **Match ALL of the following (\`AND\`${groupNote})**: A note matches only if every condition below is satisfied (adjacent terms without \`OR\` are combined with implicit \`AND\`):`,
						);
					} else {
						bulletLines.push(
							`${indent}- **Match ANY of the following (\`OR\`${groupNote})**: A note matches if at least one branch below is satisfied:`,
						);
					}
					for (const child of node.children) {
						renderAstBullets(child, `${indent}  `, false);
					}
					return;
				}
				case 'NOT':
					bulletLines.push(
						`${indent}- **Exclude (\`${node.syntax}\`)**: Matches a note only when the child condition below does **not** match:`,
					);
					renderAstBullets(node.child, `${indent}  `, false);
					return;
				case 'TEXT_MATCH': {
					const authored = formatInlineCode(node.rawText);
					if (node.matcher.kind === 'regex') {
						const valid = !invalidRegexNodes.has(node);
						const prefix = valid ? '' : '❌ **Invalid Regex** — ';
						bulletLines.push(
							`${indent}- ${prefix}**Bare Regular Expression** ${formatRegexLink(node.matcher)}: Tests against the note's \`file.basename\`, \`file.path\`, \`aliases\`, and \`tags\` (note body content is not indexed).`,
						);
					} else {
						const quoteKind = node.matcher.quoted ? 'quoted phrase' : 'unquoted term';
						bulletLines.push(
							`${indent}- **Bare Text Match** ${authored} (${quoteKind}, value ${formatInlineCode(node.matcher.value)}): Case-insensitive substring search across \`file.basename\`, \`file.path\`, \`aliases\`, and \`tags\` (note body content is not indexed).`,
						);
					}
					return;
				}
				case 'SCOPED_FILTER': {
					const authored = formatInlineCode(formatAuthoredFilter(node));
					if (unknownScopeNodes.has(node)) {
						const suggestion = suggestScopeHint(node.rawScope, effectiveConfig);
						bulletLines.push(
							`${indent}- ❌ **Unknown Scope Filter** ${authored}: Scope \`${node.rawScope}:\` is not registered.${suggestion ? ` ${suggestion}` : ''}`,
						);
						return;
					}
					const sem = describeScopeSemantics(node.scope);
					const aliasNote =
						node.rawScope === '#'
							? `tag shorthand \`#\`, lowered to canonical scope \`tag\``
							: node.rawScope.trim().toLowerCase() !== node.scope.toLowerCase()
								? `scope alias \`${node.rawScope}:\`, resolved to canonical scope \`${node.scope}\``
								: `canonical scope \`${node.scope}\``;
					const invalidPrefix = invalidRegexNodes.has(node) ? '❌ ' : '';

					if (node.expr.type === 'VALUE_LEAF') {
						const m = node.expr.matcher;
						const leafDesc =
							m.kind === 'regex'
								? `regular expression ${formatRegexLink(m)}`
								: `${m.quoted ? 'quoted' : 'unquoted'} value ${formatInlineCode(m.value)} (${sem.matchRuleDescription})`;
						bulletLines.push(
							`${indent}- ${invalidPrefix}**Scoped Filter** ${authored} (${aliasNote}): Extracts ${sem.targetsDescription} and matches if at least one extracted value matches ${leafDesc}.`,
						);
					} else {
						bulletLines.push(
							`${indent}- ${invalidPrefix}**Compound Scoped Filter** ${authored} (${aliasNote}): Extracts ${sem.targetsDescription} and requires **a single extracted target value** on the note to satisfy the inner value expression:`,
						);
						renderValueExprBullets(
							node.expr,
							`${indent}  `,
							(m) =>
								m.kind === 'regex'
									? `Regular expression ${formatRegexLink(m)}`
									: `${m.quoted ? 'Quoted' : 'Unquoted'} string ${formatInlineCode(m.value)} (${sem.matchRuleDescription})`,
							bulletLines,
						);
					}
					return;
				}
				case 'PROPERTY_FILTER': {
					const authored = formatInlineCode(formatAuthoredFilter(node));
					const typeInfo = resolvePropertyTypeWithOrigin(
						node.key,
						effectiveConfig.propertyTypes,
					);
					const isInvalid = invalidPropertyNodes.has(node) || invalidRegexNodes.has(node);
					const prefix = isInvalid ? '❌ ' : '';

					if (node.operator === 'EXISTS') {
						bulletLines.push(
							`${indent}- ${prefix}**Property Existence Filter** ${authored}: Property \`${node.key}\` (resolved type \`${typeInfo.type}\`, ${typeInfo.originLabel}) must exist on the note with at least one non-null, type-valid value.`,
						);
						return;
					}

					const neqNote =
						node.operator === '!='
							? ` *(Note: \`[${node.key} != ...]\` requires \`${node.key}\` to exist on the note; use \`-[${node.key} = ...]\` to also match notes missing \`${node.key}\`.)*`
							: '';

					if (node.valueExpr && node.valueExpr.type === 'VALUE_LEAF') {
						const leafCoercion = describePropertyLeafCoercion(
							node.valueExpr.matcher,
							typeInfo.type,
							node.operator,
							effectiveConfig.timeZone,
							effectiveRefTimeMs,
							validRefTime,
						);
						bulletLines.push(
							`${indent}- ${prefix}**Property Filter** ${authored} (property \`${node.key}\`, type \`${typeInfo.type}\` [${typeInfo.originLabel}], operator \`${node.operator}\`): Matches when the note has at least one \`${node.key}\` entry satisfying ${leafCoercion}.${neqNote}`,
						);
					} else if (node.valueExpr) {
						bulletLines.push(
							`${indent}- ${prefix}**Compound Property Filter** ${authored} (property \`${node.key}\`, type \`${typeInfo.type}\` [${typeInfo.originLabel}], operator \`:\`): Matches when **a single property entry** on \`${node.key}\` satisfies the inner value expression:`,
						);
						renderValueExprBullets(
							node.valueExpr,
							`${indent}  `,
							(m) =>
								describePropertyLeafCoercion(
									m,
									typeInfo.type,
									node.operator,
									effectiveConfig.timeZone,
									effectiveRefTimeMs,
									validRefTime,
								),
							bulletLines,
						);
					}
					return;
				}
			}
		};

		renderAstBullets(resolvedAst, '', true);
		lines.push(...bulletLines, '');

		lines.push('### Logic Flowchart', '');
		lines.push(
			renderExplainMermaid(resolvedAst, {
				propertyTypes: effectiveConfig.propertyTypes,
				invalidPropertyNodes,
				unknownScopeNodes,
				invalidRegexNodes,
			}),
			'',
		);
	}

	// =========================================================================
	// SECTION 2: Reference — Execution Context & Resolution
	// =========================================================================
	lines.push('## Reference — Execution Context & Resolution', '');
	lines.push('### Environment Context', '');
	lines.push('| Setting | Value | Resolution Details |');
	lines.push('| :--- | :--- | :--- |');

	const tzValid = resolvedConfig !== null;
	lines.push(
		`| \`timeZone\` | ${escapeMarkdownTableCell(formatInlineCode(displayTimeZone))} | ${tzValid ? 'Valid IANA timezone used for date/datetime wall-clock conversion' : '❌ Invalid IANA timezone (fell back to `UTC` for best-effort analysis)'} |`,
	);

	if (validRefTime) {
		const ts = formatEpochTimestamp(referenceTimeMs, effectiveConfig.timeZone);
		lines.push(
			`| \`referenceTimeMs\` | \`${referenceTimeMs}\` | UTC: \`${escapeMarkdownTableCell(ts.utcIso)}\` · Local: \`${escapeMarkdownTableCell(ts.localFormatted)}\` |`,
		);
	} else {
		lines.push(
			`| \`referenceTimeMs\` | ${escapeMarkdownTableCell(formatInlineCode(String(referenceTimeMs)))} | ❌ Invalid reference timestamp (must be safe integer within \`[-8.64e15, 8.64e15]\`) |`,
		);
	}

	const fpCell =
		resolvedConfig !== null
			? escapeMarkdownTableCell(formatInlineCode(resolvedConfig.normalizationFingerprint))
			: '_Unavailable (invalid configuration)_';
	lines.push(
		`| \`normalizationFingerprint\` | ${fpCell} | Deterministic fingerprint of \`timeZone\` + sorted \`propertyTypes\` |`,
	);
	lines.push(
		`| \`executable\` | \`${String(executable)}\` | ${executable ? 'Query can be evaluated against the vault' : 'Query execution blocked by diagnostic error(s)'} |`,
	);
	lines.push('');

	lines.push('### Queried Scopes & Properties', '');
	if (filterNodes.length === 0) {
		lines.push('_No scoped or property filters in this query._', '');
	} else {
		lines.push(
			'| # | Authored Filter | Normalized Target | Resolved Type & Origin | Operator & Coerced Value / Temporal Window |',
		);
		lines.push('| :--- | :--- | :--- | :--- | :--- |');
		filterNodes.forEach((node, idx) => {
			const authoredCell = escapeMarkdownTableCell(
				formatInlineCode(formatAuthoredFilter(node)),
			);
			if (node.type === 'SCOPED_FILTER') {
				const isUnknown = unknownScopeNodes.has(node);
				const targetCell = isUnknown
					? `❌ Unknown scope ${escapeMarkdownTableCell(formatInlineCode(node.rawScope))}`
					: node.rawScope === '#'
						? `scope \`tag\` (from \`#\`)`
						: node.rawScope.trim().toLowerCase() !== node.scope.toLowerCase()
							? `scope \`${escapeMarkdownTableCell(node.scope)}\` (alias \`${escapeMarkdownTableCell(node.rawScope)}:\`)`
							: `scope \`${escapeMarkdownTableCell(node.scope)}\``;
				const sem = describeScopeSemantics(node.scope);
				const originCell = isUnknown
					? 'Unregistered scope'
					: escapeMarkdownTableCell(`scope (${sem.targetsDescription})`);
				const rhsCode = formatInlineCode(formatScopeRhsDisplay(node.expr));
				const ruleDesc =
					node.expr.type === 'VALUE_LEAF' && node.expr.matcher.kind === 'regex'
						? `${invalidRegexNodes.has(node) ? '❌ invalid ' : ''}regular expression match; rhs: ${rhsCode}`
						: node.expr.type === 'VALUE_LEAF'
							? `${sem.matchRuleDescription}; rhs: ${rhsCode}`
							: `${invalidRegexNodes.has(node) ? '❌ ' : ''}compound value expression (evaluated per extracted target); rhs: ${rhsCode}`;
				const detailsCell = isUnknown
					? escapeMarkdownTableCell(
							suggestScopeHint(node.rawScope, effectiveConfig) ?? 'Unknown scope',
						)
					: escapeMarkdownTableCell(ruleDesc);
				lines.push(
					`| ${idx + 1} | ${authoredCell} | ${targetCell} | ${originCell} | ${detailsCell} |`,
				);
			} else {
				const typeInfo = resolvePropertyTypeWithOrigin(
					node.key,
					effectiveConfig.propertyTypes,
				);
				const targetCell = `property ${escapeMarkdownTableCell(formatInlineCode(node.key))}`;
				const originCell = `\`${typeInfo.type}\` (${escapeMarkdownTableCell(typeInfo.originLabel)})`;
				let details: string;
				if (node.operator === 'EXISTS') {
					details = 'Operator `EXISTS`: requires non-null, valid typed property entry';
				} else if (node.valueExpr && node.valueExpr.type === 'VALUE_LEAF') {
					details = `Operator \`${node.operator}\`: ${describePropertyLeafCoercion(
						node.valueExpr.matcher,
						typeInfo.type,
						node.operator,
						effectiveConfig.timeZone,
						effectiveRefTimeMs,
						validRefTime,
					)}`;
				} else {
					const prefix =
						invalidPropertyNodes.has(node) || invalidRegexNodes.has(node) ? '❌ ' : '';
					details = `${prefix}Operator \`:\` with compound value expression (evaluated per property entry)`;
				}
				lines.push(
					`| ${idx + 1} | ${authoredCell} | ${targetCell} | ${originCell} | ${escapeMarkdownTableCell(details)} |`,
				);
			}
		});
		lines.push('');
	}

	lines.push('### Active Property Type Registry', '');
	const sortedRegistryKeys = Object.keys(effectiveConfig.propertyTypes).sort();
	if (sortedRegistryKeys.length === 0) {
		lines.push(
			'_None configured (all non-built-in user properties default to `text`; virtual `file.*` and built-in `tags`/`aliases` always use their fixed types)._',
			'',
		);
	} else {
		lines.push('| Property Key | Configured Type |');
		lines.push('| :--- | :--- |');
		for (const k of sortedRegistryKeys) {
			const t = effectiveConfig.propertyTypes[k]!;
			lines.push(
				`| ${escapeMarkdownTableCell(formatInlineCode(k))} | \`${escapeMarkdownTableCell(t)}\` |`,
			);
		}
		lines.push('');
	}

	if (regexEntries.length > 0) {
		lines.push('### Regular Expressions', '');
		lines.push('| # | Literal | Target & Evaluation Rules | Status | regex101 |');
		lines.push('| :--- | :--- | :--- | :--- | :--- |');
		regexEntries.forEach((entry, idx) => {
			const litCell = escapeMarkdownTableCell(formatInlineCode(entry.literal));
			const ctxCell = escapeMarkdownTableCell(entry.contextDesc);
			const statusCell = entry.valid ? 'Valid' : '❌ Invalid';
			const linkCell = `[Open in regex101 ↗](${entry.url})`;
			lines.push(`| ${idx + 1} | ${litCell} | ${ctxCell} | ${statusCell} | ${linkCell} |`);
		});
		lines.push('');
	}

	// =========================================================================
	// SECTION 3: Troubleshooting & Diagnostics
	// =========================================================================
	lines.push('## Troubleshooting & Diagnostics', '');
	if (allDiagnostics.length === 0) {
		lines.push('> [!tip] No issues found');
		lines.push('> This query compiled cleanly with 0 errors, 0 warnings, and 0 lint hints.');
	} else {
		allDiagnostics.forEach((diag, idx) => {
			if (idx > 0) lines.push('');
			const calloutType =
				diag.severity === 'error'
					? '[!danger]'
					: diag.severity === 'warning'
						? '[!warning]'
						: '[!info]';
			const locText = diag.span
				? ` (line ${diag.span.startLine}, column ${diag.span.startColumn})`
				: '';
			lines.push(
				`> ${calloutType} ${diag.severity.toUpperCase()}: \`${diag.code}\`${locText}`,
			);
			lines.push(`> ${diag.issue}`);
			if (diag.span !== null) {
				const snippet = formatSourceCaretSnippet(input, diag.span);
				lines.push('> ```text');
				for (const sLine of snippet.split('\n')) {
					lines.push(`> ${sLine}`);
				}
				lines.push('> ```');
			}
			if (diag.hint !== null) {
				lines.push(`> **How to fix**: ${diag.hint}`);
			}
		});
	}

	return lines.join('\n');
}
