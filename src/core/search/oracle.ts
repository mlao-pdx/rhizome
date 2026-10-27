import { collectReferencedPropertyKeys } from './ast-utils';
import { testRegex } from './literals';
import { resolveQueryPropertyType, STRICT_NUMBER_RE } from './property-coercion';
import { hierarchicalTagMatch, normalizeTagBody, substringStringMatch } from './scopes';
import { compareDateIntervals, parseTemporalExpr } from './temporal';
import type {
	DocumentDiagnostic,
	NormalizedDocument,
	ObsidianPropertyType,
	PreparedQuery,
	PropertyOperator,
	ResolvedEngineConfig,
	ScopeDefinition,
	SearchAST,
	TypedPropertyValue,
	ValueExprAST,
	VaultEvaluationReport,
} from './types';

export function getTypedPropertyEntries(
	doc: NormalizedDocument,
	lowerKey: string,
): TypedPropertyValue[] {
	if (lowerKey === 'file.modified' || lowerKey === 'file.created') {
		const t = doc.file[lowerKey === 'file.modified' ? 'modified' : 'created'];
		return [
			{
				kind: 'datetime',
				interval: { start: t, end: t + 1, grain: 'ms', raw: String(t) },
				raw: String(t),
			},
		];
	}
	if (lowerKey === 'file.size') {
		const s = doc.file.size;
		return [{ kind: 'number', value: s, raw: String(s) }];
	}
	if (lowerKey === 'file.extension') {
		return [{ kind: 'text', value: doc.file.extension }];
	}
	if (lowerKey === 'file.name') return [{ kind: 'text', value: doc.file.name }];
	if (lowerKey === 'file.basename') return [{ kind: 'text', value: doc.file.basename }];
	if (lowerKey === 'file.path') return [{ kind: 'text', value: doc.file.path }];
	if (lowerKey === 'file.parent') return [{ kind: 'text', value: doc.file.parent }];
	return doc.propertyOccurrences
		.filter((occ) => occ.key === lowerKey)
		.flatMap((occ) => occ.typedValues);
}

function evalValueExprOnTarget(
	target: string,
	expr: ValueExprAST,
	scopeDef: Pick<ScopeDefinition, 'matchString'>,
): boolean {
	switch (expr.type) {
		case 'VALUE_LOGICAL':
			return expr.operator === 'AND'
				? expr.children.every((c) => evalValueExprOnTarget(target, c, scopeDef))
				: expr.children.some((c) => evalValueExprOnTarget(target, c, scopeDef));
		case 'VALUE_NOT':
			return !evalValueExprOnTarget(target, expr.child, scopeDef);
		case 'VALUE_LEAF':
			return expr.matcher.kind === 'regex'
				? testRegex(target, expr.matcher)
				: scopeDef.matchString(target, expr.matcher.value, expr.matcher.quoted);
	}
}

function evalColonExprOnEntry(
	entry: Exclude<TypedPropertyValue, { kind: 'null' } | { kind: 'invalid' }>,
	propType: ObsidianPropertyType,
	expr: ValueExprAST,
	timeZone: string,
	referenceTimeMs: number,
): boolean {
	switch (expr.type) {
		case 'VALUE_LOGICAL':
			return expr.operator === 'AND'
				? expr.children.every((c) =>
						evalColonExprOnEntry(entry, propType, c, timeZone, referenceTimeMs),
					)
				: expr.children.some((c) =>
						evalColonExprOnEntry(entry, propType, c, timeZone, referenceTimeMs),
					);
		case 'VALUE_NOT':
			return !evalColonExprOnEntry(entry, propType, expr.child, timeZone, referenceTimeMs);
		case 'VALUE_LEAF': {
			if (expr.matcher.kind === 'regex') {
				if (propType === 'checkbox' || entry.kind === 'checkbox') return false;
				if (propType === 'tags') {
					return entry.kind === 'text' && testRegex(entry.value, expr.matcher);
				}
				const target = entry.kind === 'text' ? entry.value : entry.raw;
				return testRegex(target, expr.matcher);
			}
			const { value: rhsRaw, quoted } = expr.matcher;
			switch (propType) {
				case 'number': {
					if (entry.kind !== 'number') return false;
					const trimmed = rhsRaw.trim();
					if (quoted || !STRICT_NUMBER_RE.test(trimmed)) return false;
					const rhsNum = Number(trimmed);
					if (!Number.isFinite(rhsNum)) return false;
					return entry.value === rhsNum;
				}
				case 'checkbox': {
					if (entry.kind !== 'checkbox') return false;
					if (quoted) return false;
					const lower = rhsRaw.trim().toLowerCase();
					if (lower !== 'true' && lower !== 'false') return false;
					return entry.value === (lower === 'true');
				}
				case 'date':
				case 'datetime': {
					if (entry.kind !== 'date' && entry.kind !== 'datetime') return false;
					const res = parseTemporalExpr(rhsRaw, {
						allowYearOnly: true,
						allowRelative: true,
						timeZone,
						referenceTimeMs,
					});
					if (!res.ok) {
						throw new Error(
							`Unvalidated temporal literal reached evaluator: ${rhsRaw}`,
						);
					}
					return compareDateIntervals(entry.interval, '=', res.interval);
				}
				case 'tags':
					return entry.kind === 'text' && hierarchicalTagMatch(entry.value, rhsRaw);
				case 'text':
				case 'multitext':
					return entry.kind === 'text' && substringStringMatch(entry.value, rhsRaw);
			}
		}
	}
}

function evalPropertyEntry(
	entry: TypedPropertyValue,
	propType: ObsidianPropertyType,
	op: PropertyOperator,
	expr: ValueExprAST,
	timeZone: string,
	referenceTimeMs: number,
): boolean {
	if (entry.kind === 'null' || entry.kind === 'invalid') return false;
	if (op === ':') {
		return evalColonExprOnEntry(entry, propType, expr, timeZone, referenceTimeMs);
	}
	if (expr.type !== 'VALUE_LEAF' || expr.matcher.kind === 'regex') return false;
	const { value: rhsRaw, quoted } = expr.matcher;

	switch (entry.kind) {
		case 'number': {
			if (quoted || !STRICT_NUMBER_RE.test(rhsRaw.trim())) return false;
			const rhsNum = Number(rhsRaw.trim());
			if (!Number.isFinite(rhsNum)) return false;
			switch (op) {
				case '=':
					return entry.value === rhsNum;
				case '!=':
					return entry.value !== rhsNum;
				case '<':
					return entry.value < rhsNum;
				case '>':
					return entry.value > rhsNum;
				case '<=':
					return entry.value <= rhsNum;
				case '>=':
					return entry.value >= rhsNum;
				default:
					return false;
			}
		}
		case 'checkbox': {
			if (quoted) return false;
			const lower = rhsRaw.trim().toLowerCase();
			if (lower !== 'true' && lower !== 'false') return false;
			const rhsBool = lower === 'true';
			if (op === '=') return entry.value === rhsBool;
			if (op === '!=') return entry.value !== rhsBool;
			return false;
		}
		case 'date':
		case 'datetime': {
			const res = parseTemporalExpr(rhsRaw, {
				allowYearOnly: true,
				allowRelative: true,
				timeZone,
				referenceTimeMs,
			});
			if (!res.ok) {
				throw new Error(`Unvalidated temporal literal reached evaluator: ${rhsRaw}`);
			}
			return compareDateIntervals(entry.interval, op, res.interval);
		}
		case 'text': {
			const a =
				propType === 'tags' ? normalizeTagBody(entry.value) : entry.value.toLowerCase();
			const b = propType === 'tags' ? normalizeTagBody(rhsRaw) : rhsRaw.toLowerCase();
			switch (op) {
				case '=':
					return a === b;
				case '!=':
					return a !== b;
				case '<':
					return a < b;
				case '>':
					return a > b;
				case '<=':
					return a <= b;
				case '>=':
					return a >= b;
				default:
					return false;
			}
		}
	}
}

function evalAstNode(
	doc: NormalizedDocument,
	ast: SearchAST,
	resolvedConfig: ResolvedEngineConfig,
	referenceTimeMs: number,
): boolean {
	switch (ast.type) {
		case 'MATCH_ALL':
			return true;
		case 'LOGICAL':
			return ast.operator === 'AND'
				? ast.children.every((c) => evalAstNode(doc, c, resolvedConfig, referenceTimeMs))
				: ast.children.some((c) => evalAstNode(doc, c, resolvedConfig, referenceTimeMs));
		case 'NOT':
			return !evalAstNode(doc, ast.child, resolvedConfig, referenceTimeMs);
		case 'TEXT_MATCH': {
			const targets = [doc.file.basename, doc.file.path, ...doc.aliases, ...doc.tags];
			return targets.some((t) =>
				ast.matcher.kind === 'regex'
					? testRegex(t, ast.matcher)
					: substringStringMatch(t, ast.matcher.value),
			);
		}
		case 'SCOPED_FILTER': {
			const def =
				ast.rawScope === '#'
					? resolvedConfig.getScope('tag')
					: resolvedConfig.getScope(ast.scope);
			if (!def) throw new Error(`Unresolved scope in AST: ${ast.scope}`);
			const targets = def.extract(doc);
			return targets.some((target) => evalValueExprOnTarget(target, ast.expr, def));
		}
		case 'PROPERTY_FILTER': {
			const lowerKey = ast.key.trim().toLowerCase();
			const entries = getTypedPropertyEntries(doc, lowerKey);
			const validEntries = entries.filter((e) => e.kind !== 'null' && e.kind !== 'invalid');
			if (validEntries.length === 0) return false;
			if (ast.operator === 'EXISTS') return true;
			const valueExpr = ast.valueExpr;
			if (!valueExpr) return false;
			const propType = resolveQueryPropertyType(lowerKey, resolvedConfig.propertyTypes);
			return validEntries.some((entry) =>
				evalPropertyEntry(
					entry,
					propType,
					ast.operator,
					valueExpr,
					resolvedConfig.timeZone,
					referenceTimeMs,
				),
			);
		}
	}
}

export function oracleEvaluateDoc(doc: NormalizedDocument, prepared: PreparedQuery): boolean {
	if (doc.normalizationFingerprint !== prepared.resolvedConfig.normalizationFingerprint) {
		throw new Error(`Document "${doc.file.path}" normalizationFingerprint mismatch.`);
	}
	return evalAstNode(doc, prepared.ast, prepared.resolvedConfig, prepared.referenceTimeMs);
}

export function oracleEvaluateVault(
	docs: readonly NormalizedDocument[],
	prepared: PreparedQuery,
): VaultEvaluationReport {
	const { ast, resolvedConfig } = prepared;
	const expectedFp = resolvedConfig.normalizationFingerprint;
	const queriedKeys = collectReferencedPropertyKeys(ast);
	const matches: NormalizedDocument[] = [];
	const propertyDiagnostics: DocumentDiagnostic[] = [];

	for (const doc of docs) {
		if (doc.normalizationFingerprint !== expectedFp) {
			throw new Error(
				`Document "${doc.file.path}" normalizationFingerprint mismatch: expected ${expectedFp}, got ${doc.normalizationFingerprint}`,
			);
		}
		if (oracleEvaluateDoc(doc, prepared)) {
			matches.push(doc);
		}
		if (queriedKeys.size > 0 && doc.diagnostics.length > 0) {
			for (const diag of doc.diagnostics) {
				if (queriedKeys.has(diag.propertyKey)) {
					propertyDiagnostics.push(diag);
				}
			}
		}
	}

	return { matches, propertyDiagnostics };
}
