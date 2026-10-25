import { collectReferencedPropertyKeys, containsRegexLeaf } from './ast-utils';
import { testRegex } from './literals';
import { STRICT_NUMBER_RE } from './property-coercion';
import { substringStringMatch } from './scopes';
import { compareDateIntervals, parseTemporalExpr } from './temporal';
import type {
	DocumentDiagnostic,
	NormalizedDocument,
	PreparedQuery,
	PropertyOperator,
	ResolvedEngineConfig,
	ScopeDefinition,
	SearchAST,
	TypedPropertyValue,
	ValueExprAST,
	VaultEvaluationReport,
} from './types';

const PROPERTY_COLON_MATCHER: Pick<ScopeDefinition, 'matchString'> = {
	matchString: substringStringMatch,
};

export function getTypedPropertyEntries(
	doc: NormalizedDocument,
	lowerKey: string,
): TypedPropertyValue[] {
	if (lowerKey === 'file.mtime' || lowerKey === 'file.ctime') {
		const t = doc.file.stat[lowerKey === 'file.mtime' ? 'mtime' : 'ctime'];
		return [
			{
				kind: 'datetime',
				interval: { start: t, end: t + 1, grain: 'ms', raw: String(t) },
				raw: String(t),
			},
		];
	}
	if (lowerKey === 'file.size') {
		const s = doc.file.stat.size;
		return [{ kind: 'number', value: s, raw: String(s) }];
	}
	if (lowerKey === 'file.ext' || lowerKey === 'file.extension') {
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

function evalPropertyEntry(
	entry: TypedPropertyValue,
	op: PropertyOperator,
	expr: ValueExprAST,
	timeZone: string,
	referenceTimeMs: number,
): boolean {
	if (entry.kind === 'null' || entry.kind === 'invalid') return false;
	if (op === ':') {
		if (entry.kind === 'checkbox' && containsRegexLeaf(expr)) return false;
		const rawStr =
			entry.kind === 'text'
				? entry.value
				: entry.kind === 'checkbox'
					? String(entry.value)
					: entry.raw;
		return evalValueExprOnTarget(rawStr, expr, PROPERTY_COLON_MATCHER);
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
			const a = entry.value.toLowerCase();
			const b = rhsRaw.toLowerCase();
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
			const entries = getTypedPropertyEntries(doc, ast.key.trim().toLowerCase());
			const validEntries = entries.filter((e) => e.kind !== 'null' && e.kind !== 'invalid');
			if (validEntries.length === 0) return false;
			if (ast.operator === 'EXISTS') return true;
			const valueExpr = ast.valueExpr;
			if (!valueExpr) return false;
			return validEntries.some((entry) =>
				evalPropertyEntry(
					entry,
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
