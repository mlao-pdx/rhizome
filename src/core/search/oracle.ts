import { collectReferencedPropertyKeys } from './ast-utils';
import { coerceHostScalarForProperty, resolveThisReference } from './host-reference';
import { testRegex } from './literals';
import { getInternalFileEpochMs } from './metadata-normalizer';
import { resolveQueryPropertyType, STRICT_NUMBER_RE } from './property-coercion';
import {
	normalizeScopeComparisonOperands,
	scopeTargetsMatchComparison,
	substringStringMatch,
} from './scopes';
import { compareDateIntervals, parseTemporalExpr } from './temporal';
import {
	isVirtualFileKey,
	type DocumentDiagnostic,
	type NormalizedDocument,
	type ObsidianPropertyType,
	type PreparedQuery,
	type PropertyOperator,
	type ResolvedEngineConfig,
	type ScopeDefinition,
	type SearchAST,
	type TypedPropertyValue,
	type ValueExprAST,
	type VaultEvaluationReport,
} from './types';

function resolveDocTimeZone(normalizationFingerprint: string): string {
	try {
		const parsed = JSON.parse(normalizationFingerprint) as { tz?: unknown };
		if (typeof parsed.tz === 'string' && parsed.tz.length > 0) {
			return parsed.tz;
		}
	} catch {
		// Fall back to 'UTC'
	}
	return 'UTC';
}

export function hasPropertyOccurrence(doc: NormalizedDocument, lowerKey: string): boolean {
	if (isVirtualFileKey(lowerKey)) return true;
	return doc.propertyOccurrences.some((occ) => occ.key === lowerKey);
}

export function getTypedPropertyEntries(
	doc: NormalizedDocument,
	lowerKey: string,
): TypedPropertyValue[] {
	if (lowerKey === 'file.modified' || lowerKey === 'file.created') {
		const isModified = lowerKey === 'file.modified';
		const rawIso = String(doc.file[isModified ? 'modified' : 'created']);
		const statMs = getInternalFileEpochMs(doc.file)?.[isModified ? 'mtime' : 'ctime'];
		if (typeof statMs === 'number') {
			return [
				{
					kind: 'datetime',
					interval: { start: statMs, end: statMs + 1, grain: 'ms', raw: rawIso },
					raw: rawIso,
				},
			];
		}
		const parsed = parseTemporalExpr(rawIso, {
			allowYearOnly: true,
			allowRelative: false,
			timeZone: resolveDocTimeZone(doc.normalizationFingerprint),
		});
		if (parsed.ok) {
			return [
				{
					kind: 'datetime',
					interval: {
						start: parsed.interval.start,
						end: parsed.interval.start + 1,
						grain: 'ms',
						raw: rawIso,
					},
					raw: rawIso,
				},
			];
		}
		return [{ kind: 'null' }];
	}
	if (lowerKey === 'file.size') {
		const s = doc.file.size;
		return [{ kind: 'number', value: s, raw: String(s) }];
	}
	if (lowerKey === 'file.extension') {
		return doc.file.extension === ''
			? [{ kind: 'null' }]
			: [{ kind: 'text', value: doc.file.extension }];
	}
	if (lowerKey === 'file.name') {
		return doc.file.name === '' ? [{ kind: 'null' }] : [{ kind: 'text', value: doc.file.name }];
	}
	if (lowerKey === 'file.basename') {
		return doc.file.basename === ''
			? [{ kind: 'null' }]
			: [{ kind: 'text', value: doc.file.basename }];
	}
	if (lowerKey === 'file.path') {
		return doc.file.path === '' ? [{ kind: 'null' }] : [{ kind: 'text', value: doc.file.path }];
	}
	if (lowerKey === 'file.parent') {
		return doc.file.parent === ''
			? [{ kind: 'null' }]
			: [{ kind: 'text', value: doc.file.parent }];
	}
	return doc.propertyOccurrences
		.filter((occ) => occ.key === lowerKey)
		.flatMap((occ) => occ.typedValues);
}

function evalValueExprOnTarget(
	target: string,
	expr: ValueExprAST,
	scopeDef: Pick<ScopeDefinition, 'matchString'>,
	hostDoc: NormalizedDocument | null | undefined,
): boolean {
	switch (expr.type) {
		case 'VALUE_LOGICAL':
			return expr.operator === 'AND'
				? expr.children.every((c) => evalValueExprOnTarget(target, c, scopeDef, hostDoc))
				: expr.children.some((c) => evalValueExprOnTarget(target, c, scopeDef, hostDoc));
		case 'VALUE_NOT':
			return !evalValueExprOnTarget(target, expr.child, scopeDef, hostDoc);
		case 'VALUE_LEAF': {
			if (expr.matcher.kind === 'regex') {
				return testRegex(target, expr.matcher);
			}
			if (expr.matcher.kind === 'this') {
				const res = resolveThisReference(hostDoc, expr.matcher.segments);
				return res.values.some((v) => scopeDef.matchString(target, String(v), true));
			}
			return scopeDef.matchString(target, expr.matcher.value, expr.matcher.quoted);
		}
	}
}

function evalColonExprOnEntry(
	entry: Exclude<TypedPropertyValue, { kind: 'null' } | { kind: 'invalid' }>,
	propType: ObsidianPropertyType,
	expr: ValueExprAST,
	timeZone: string,
	referenceTimeMs: number,
	hostDoc: NormalizedDocument | null | undefined,
): boolean {
	switch (expr.type) {
		case 'VALUE_LOGICAL':
			return expr.operator === 'AND'
				? expr.children.every((c) =>
						evalColonExprOnEntry(
							entry,
							propType,
							c,
							timeZone,
							referenceTimeMs,
							hostDoc,
						),
					)
				: expr.children.some((c) =>
						evalColonExprOnEntry(
							entry,
							propType,
							c,
							timeZone,
							referenceTimeMs,
							hostDoc,
						),
					);
		case 'VALUE_NOT':
			return !evalColonExprOnEntry(
				entry,
				propType,
				expr.child,
				timeZone,
				referenceTimeMs,
				hostDoc,
			);
		case 'VALUE_LEAF': {
			if (expr.matcher.kind === 'regex') {
				if (propType === 'checkbox' || entry.kind === 'checkbox') return false;
				const target = entry.kind === 'text' ? entry.value : entry.raw;
				return testRegex(target, expr.matcher);
			}
			if (expr.matcher.kind === 'this') {
				const res = resolveThisReference(hostDoc, expr.matcher.segments);
				return res.values.some((val) => {
					const coerced = coerceHostScalarForProperty(
						val,
						propType,
						timeZone,
						referenceTimeMs,
					);
					if (!coerced.ok) return false;
					switch (coerced.kind) {
						case 'number':
							return entry.kind === 'number' && entry.value === coerced.rhsNum;
						case 'checkbox':
							return entry.kind === 'checkbox' && entry.value === coerced.rhsBool;
						case 'temporal':
							return (
								(entry.kind === 'date' || entry.kind === 'datetime') &&
								compareDateIntervals(entry.interval, '=', coerced.rhsInterval)
							);
						case 'text':
							return (
								entry.kind === 'text' &&
								substringStringMatch(entry.value, coerced.rhsRaw)
							);
					}
				});
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
	hostDoc: NormalizedDocument | null | undefined,
): boolean {
	if (entry.kind === 'null' || entry.kind === 'invalid') return false;
	if (op === ':') {
		return evalColonExprOnEntry(entry, propType, expr, timeZone, referenceTimeMs, hostDoc);
	}
	if (expr.type !== 'VALUE_LEAF' || expr.matcher.kind === 'regex') return false;
	if (expr.matcher.kind === 'this') {
		const res = resolveThisReference(hostDoc, expr.matcher.segments);
		return res.values.some((val) => {
			const coerced = coerceHostScalarForProperty(val, propType, timeZone, referenceTimeMs);
			if (!coerced.ok) return false;
			switch (coerced.kind) {
				case 'number': {
					if (entry.kind !== 'number') return false;
					const rhsNum = coerced.rhsNum;
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
					if (entry.kind !== 'checkbox') return false;
					if (op === '=') return entry.value === coerced.rhsBool;
					if (op === '!=') return entry.value !== coerced.rhsBool;
					return false;
				}
				case 'temporal': {
					if (entry.kind !== 'date' && entry.kind !== 'datetime') return false;
					return compareDateIntervals(entry.interval, op, coerced.rhsInterval);
				}
				case 'text': {
					if (entry.kind !== 'text') return false;
					const a = entry.value.toLowerCase();
					const b = coerced.rhsLower;
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
		});
	}
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
	hostDoc: NormalizedDocument | null | undefined,
): boolean {
	switch (ast.type) {
		case 'MATCH_ALL':
			return true;
		case 'LOGICAL':
			return ast.operator === 'AND'
				? ast.children.every((c) =>
						evalAstNode(doc, c, resolvedConfig, referenceTimeMs, hostDoc),
					)
				: ast.children.some((c) =>
						evalAstNode(doc, c, resolvedConfig, referenceTimeMs, hostDoc),
					);
		case 'NOT':
			return !evalAstNode(doc, ast.child, resolvedConfig, referenceTimeMs, hostDoc);
		case 'SCOPED_FILTER': {
			const def =
				ast.rawScope === '#'
					? resolvedConfig.getScope('tag')
					: resolvedConfig.getScope(ast.scope);
			if (!def) throw new Error(`Unresolved scope in AST: ${ast.scope}`);
			const targets = def.extract(doc);
			const op = ast.operator ?? ':';
			if (op === ':') {
				return targets.some((target) =>
					evalValueExprOnTarget(target, ast.expr, def, hostDoc),
				);
			}
			if (ast.expr.type !== 'VALUE_LEAF' || ast.expr.matcher.kind === 'regex') return false;
			const canonical = def.canonicalName;
			const rawValues =
				ast.expr.matcher.kind === 'this'
					? resolveThisReference(hostDoc, ast.expr.matcher.segments).values.map(String)
					: [ast.expr.matcher.value];
			return scopeTargetsMatchComparison(
				canonical,
				targets,
				op,
				normalizeScopeComparisonOperands(canonical, rawValues),
			);
		}
		case 'PROPERTY_FILTER': {
			const lowerKey = ast.key.trim().toLowerCase();
			if (ast.operator === 'EXISTS') {
				return hasPropertyOccurrence(doc, lowerKey);
			}
			if (ast.operator === 'EMPTY') {
				if (!hasPropertyOccurrence(doc, lowerKey)) return false;
				const entries = getTypedPropertyEntries(doc, lowerKey);
				return entries.every((e) => e.kind === 'null');
			}
			const entries = getTypedPropertyEntries(doc, lowerKey);
			const validEntries = entries.filter((e) => e.kind !== 'null' && e.kind !== 'invalid');
			if (validEntries.length === 0) return false;
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
					hostDoc,
				),
			);
		}
	}
}

export function oracleEvaluateDoc(doc: NormalizedDocument, prepared: PreparedQuery): boolean {
	if (doc.normalizationFingerprint !== prepared.resolvedConfig.normalizationFingerprint) {
		throw new Error(`Document "${doc.file.path}" normalizationFingerprint mismatch.`);
	}
	return evalAstNode(
		doc,
		prepared.ast,
		prepared.resolvedConfig,
		prepared.referenceTimeMs,
		prepared.hostDoc,
	);
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
