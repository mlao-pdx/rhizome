import {
	getExecutionPlan,
	type CompiledPropertyColonNode,
	type CompiledPropertyComparison,
	type CompiledSearchNode,
	type CompiledValueExprNode,
} from './execution-plan';
import { getTypedPropertyEntries } from './oracle';
import { hierarchicalTagMatch, normalizeTagBody, substringStringMatch } from './scopes';
import { compareDateIntervals } from './temporal';
import type {
	DocumentDiagnostic,
	NormalizedDocument,
	PreparedQuery,
	ScopeDefinition,
	TypedPropertyValue,
	VaultEvaluationReport,
} from './types';

function evalCompiledValueExpr(
	target: string,
	expr: CompiledValueExprNode,
	scopeDef: Pick<ScopeDefinition, 'matchString'>,
): boolean {
	switch (expr.type) {
		case 'VALUE_LOGICAL':
			return expr.operator === 'AND'
				? expr.children.every((c) => evalCompiledValueExpr(target, c, scopeDef))
				: expr.children.some((c) => evalCompiledValueExpr(target, c, scopeDef));
		case 'VALUE_NOT':
			return !evalCompiledValueExpr(target, expr.child, scopeDef);
		case 'VALUE_LEAF_REGEX':
			return expr.regex.test(target);
		case 'VALUE_LEAF_STRING':
			return scopeDef.matchString(target, expr.value, expr.quoted);
	}
}

function evalCompiledColonExpr(
	entry: Exclude<TypedPropertyValue, { kind: 'null' } | { kind: 'invalid' }>,
	expr: CompiledPropertyColonNode,
): boolean {
	switch (expr.type) {
		case 'COLON_LOGICAL':
			return expr.operator === 'AND'
				? expr.children.every((c) => evalCompiledColonExpr(entry, c))
				: expr.children.some((c) => evalCompiledColonExpr(entry, c));
		case 'COLON_NOT':
			return !evalCompiledColonExpr(entry, expr.child);
		case 'COLON_REGEX': {
			if (expr.propType === 'checkbox' || entry.kind === 'checkbox') return false;
			if (expr.propType === 'tags') {
				return entry.kind === 'text' && expr.regex.test(entry.value);
			}
			const target = entry.kind === 'text' ? entry.value : entry.raw;
			return expr.regex.test(target);
		}
		case 'COLON_NUMBER':
			return entry.kind === 'number' && entry.value === expr.rhsNum;
		case 'COLON_CHECKBOX':
			return entry.kind === 'checkbox' && entry.value === expr.rhsBool;
		case 'COLON_TEMPORAL':
			return (
				(entry.kind === 'date' || entry.kind === 'datetime') &&
				compareDateIntervals(entry.interval, '=', expr.rhsInterval)
			);
		case 'COLON_TAG':
			return entry.kind === 'text' && hierarchicalTagMatch(entry.value, expr.rhsRaw);
		case 'COLON_TEXT':
			return entry.kind === 'text' && substringStringMatch(entry.value, expr.value);
	}
}

function evalCompiledComparisonOnEntry(
	entry: TypedPropertyValue,
	comparison: CompiledPropertyComparison,
): boolean {
	if (entry.kind === 'null' || entry.kind === 'invalid') return false;

	switch (comparison.kind) {
		case 'number': {
			if (entry.kind !== 'number') return false;
			const { operator: op, rhsNum } = comparison;
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
			const { operator: op, rhsBool } = comparison;
			if (op === '=') return entry.value === rhsBool;
			if (op === '!=') return entry.value !== rhsBool;
			return false;
		}
		case 'temporal': {
			if (entry.kind !== 'date' && entry.kind !== 'datetime') return false;
			return compareDateIntervals(
				entry.interval,
				comparison.operator,
				comparison.rhsInterval,
			);
		}
		case 'tags': {
			if (entry.kind !== 'text') return false;
			const a = normalizeTagBody(entry.value);
			const b = comparison.rhsTag;
			switch (comparison.operator) {
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
		case 'text': {
			if (entry.kind !== 'text') return false;
			const a = entry.value.toLowerCase();
			const b = comparison.rhsLower;
			switch (comparison.operator) {
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

function evalCompiledSearchNode(doc: NormalizedDocument, node: CompiledSearchNode): boolean {
	switch (node.type) {
		case 'MATCH_ALL':
			return true;
		case 'LOGICAL':
			return node.operator === 'AND'
				? node.children.every((c) => evalCompiledSearchNode(doc, c))
				: node.children.some((c) => evalCompiledSearchNode(doc, c));
		case 'NOT':
			return !evalCompiledSearchNode(doc, node.child);
		case 'TEXT_MATCH_REGEX': {
			const targets = [doc.file.basename, doc.file.path, ...doc.aliases, ...doc.tags];
			return targets.some((t) => node.regex.test(t));
		}
		case 'TEXT_MATCH_STRING': {
			const targets = [doc.file.basename, doc.file.path, ...doc.aliases, ...doc.tags];
			return targets.some((t) => substringStringMatch(t, node.value));
		}
		case 'SCOPED_FILTER': {
			const targets = node.scopeDef.extract(doc);
			return targets.some((t) => evalCompiledValueExpr(t, node.expr, node.scopeDef));
		}
		case 'PROPERTY_EXISTS': {
			const entries = getTypedPropertyEntries(doc, node.lowerKey);
			return entries.some((e) => e.kind !== 'null' && e.kind !== 'invalid');
		}
		case 'PROPERTY_COLON': {
			const entries = getTypedPropertyEntries(doc, node.lowerKey);
			return entries.some((entry) => {
				if (entry.kind === 'null' || entry.kind === 'invalid') return false;
				return evalCompiledColonExpr(entry, node.expr);
			});
		}
		case 'PROPERTY_COMPARE': {
			const entries = getTypedPropertyEntries(doc, node.lowerKey);
			return entries.some((entry) => evalCompiledComparisonOnEntry(entry, node.comparison));
		}
	}
}

export function evaluateDoc(doc: NormalizedDocument, prepared: PreparedQuery): boolean {
	const plan = getExecutionPlan(prepared);
	if (doc.normalizationFingerprint !== plan.expectedFingerprint) {
		throw new Error(`Document "${doc.file.path}" normalizationFingerprint mismatch.`);
	}
	return evalCompiledSearchNode(doc, plan.root);
}

export function evaluateVault(
	docs: readonly NormalizedDocument[],
	prepared: PreparedQuery,
): VaultEvaluationReport {
	const plan = getExecutionPlan(prepared);
	const { expectedFingerprint, queriedKeys, root } = plan;
	const matches: NormalizedDocument[] = [];
	const propertyDiagnostics: DocumentDiagnostic[] = [];

	for (const doc of docs) {
		if (doc.normalizationFingerprint !== expectedFingerprint) {
			throw new Error(
				`Document "${doc.file.path}" normalizationFingerprint mismatch: expected ${expectedFingerprint}, got ${doc.normalizationFingerprint}`,
			);
		}
		if (evalCompiledSearchNode(doc, root)) {
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
