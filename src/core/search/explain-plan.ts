import { Temporal } from '@js-temporal/polyfill';
import { initEngineConfig } from './config';
import { type ExplainConceptKey, formatPropertyTypeInlineBadge } from './explain-concepts';
import {
	buildRegex101Url,
	describeHopBounds,
	describeScopeSemantics,
	extractAstSlice,
	extractValueExprSlice,
	formatDateIntervalWindow,
	formatEpochTimestamp,
	formatInlineCode,
	formatLeafMatcher,
	formatScopeStringMatch,
	resolvePropertyTypeWithOrigin,
} from './explain-helpers';
import { isGraphScopeCanonicalName } from './graph-dag';
import { coerceHostScalarForProperty, resolveThisReference } from './host-reference';
import { lintQueryAST } from './linter';
import { validateRegexLiteral } from './literals';
import { parseAndLowerQuery } from './parser';
import { FORBIDDEN_KEYS, STRICT_NUMBER_RE } from './property-coercion';
import { isValidReferenceTimeMs, parseTemporalExpr } from './temporal';
import {
	type EngineConfig,
	getSystemScopeForPropertyKey,
	isValidPropertyType,
	isVirtualFileKey,
	type LeafMatcher,
	type NormalizedDocument,
	type ObsidianPropertyType,
	type PropertyFilterNode,
	type PropertyOperator,
	type PropertyTypeRegistry,
	type ResolvedEngineConfig,
	type SearchAST,
	type SearchDiagnostic,
	type SourceSpan,
	type ValueExprAST,
} from './types';
import { suggestScopeHint, validateQueryAST } from './validator';

/**
 * Options passed to `analyzeQueryExplain`.
 */
export interface AnalyzeQueryExplainOptions {
	readonly knownQueryNames?: ReadonlySet<string> | undefined;
	readonly extraDiagnostics?: readonly SearchDiagnostic[] | undefined;
	readonly hostDoc?: NormalizedDocument | null | undefined;
}

/**
 * Structured, footnote-free query explain analysis consumed by `rhizome-sample` callout builders.
 */
export interface QueryExplainAnalysis {
	readonly input: string;
	readonly executable: boolean;
	readonly ast: SearchAST | null;
	readonly effectiveTimeZone: string;
	readonly displayTimeZone: string;
	readonly timeZoneValid: boolean;
	readonly referenceTimeMs: number;
	readonly validReferenceTime: boolean;
	readonly nowLocalIso: string | null;
	readonly todayLocalWindow: string;
	readonly astBullets: readonly string[];
	readonly diagnostics: readonly SearchDiagnostic[];
	readonly errorCount: number;
	readonly warningCount: number;
	readonly hintCount: number;
	readonly queriedKeys: ReadonlySet<string>;
	readonly pathFilterLiterals: readonly string[];
	readonly queryDependencies: readonly string[];
	readonly usesHostReference: boolean;
	readonly concepts: ReadonlySet<ExplainConceptKey>;
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

function formatLocalIsoWithOffset(epochMs: number, timeZone: string): string {
	try {
		const zdt = Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone);
		return zdt.toString({ timeZoneName: 'never' });
	} catch {
		return formatEpochTimestamp(epochMs, timeZone).utcIso;
	}
}

function formatDirectRegexLink(matcher: Extract<LeafMatcher, { kind: 'regex' }>): string {
	const literal = formatLeafMatcher(matcher);
	const url = buildRegex101Url(matcher.pattern, matcher.flags);
	return `[${formatInlineCode(literal)}](${url})`;
}

function capitalizeFirst(text: string): string {
	if (!text) return text;
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function spanKey(span: SourceSpan): string {
	return `${span.startOffset}:${span.endOffset}`;
}

function formatInlineDiagBadge(diag: SearchDiagnostic): string {
	const icon = diag.severity === 'error' ? '❌' : diag.severity === 'warning' ? '⚠️' : 'ℹ️';
	return `${icon} \`${diag.code}\``;
}

function describeScopeThisLeaf(
	matcher: Extract<LeafMatcher, { kind: 'this' }>,
	formatPlainStringMatch: (val: string) => string,
	hostDoc: NormalizedDocument | null | undefined,
): string {
	const rawCode = formatInlineCode(matcher.raw);
	if (hostDoc === undefined) {
		return `matches host note value ${rawCode}`;
	}
	const res = resolveThisReference(hostDoc, matcher.segments);
	if (!res.resolved) {
		return `⚠️ ${rawCode} is missing or empty on the host note (evaluates to \`false\`)`;
	}
	if (res.values.length === 1) {
		return `${formatPlainStringMatch(String(res.values[0]!))} (from ${rawCode})`;
	}
	const joined = res.values.map((v) => formatPlainStringMatch(String(v))).join(' OR ');
	return `(${joined}) (from ${rawCode})`;
}

function describePropertyLeaf(
	matcher: LeafMatcher,
	propType: ObsidianPropertyType,
	operator: PropertyOperator,
	timeZone: string,
	referenceTimeMs: number,
	validRefTime: boolean,
	concepts: Set<ExplainConceptKey>,
	hostDoc?: NormalizedDocument | null,
): string {
	if (matcher.kind === 'regex') {
		const valid = validateRegexLiteral(matcher.pattern, matcher.flags) !== null;
		const link = formatDirectRegexLink(matcher);
		if (operator !== ':' || propType === 'checkbox') {
			return `❌ ${link} (regular expressions cannot be used with this operator on \`${propType}\` properties)`;
		}
		const isRawTarget = propType === 'number' || propType === 'date' || propType === 'datetime';
		return isRawTarget
			? `${valid ? 'has raw text matching' : '❌ invalid regex'} ${link}`
			: `${valid ? 'matches' : '❌ invalid regex'} ${link}`;
	}

	if (matcher.kind === 'this') {
		const rawCode = formatInlineCode(matcher.raw);
		if (
			propType === 'checkbox' &&
			(operator === '<' || operator === '>' || operator === '<=' || operator === '>=')
		) {
			return `❌ ${rawCode} (ordering comparison is not supported on \`checkbox\` properties)`;
		}
		if (hostDoc === undefined) {
			return `compares against host note value ${rawCode}`;
		}
		const res = resolveThisReference(hostDoc, matcher.segments);
		if (!res.resolved) {
			return `⚠️ ${rawCode} is missing or empty on the host note (evaluates to \`false\`)`;
		}
		const validDescs: string[] = [];
		for (const val of res.values) {
			const coerced = coerceHostScalarForProperty(val, propType, timeZone, referenceTimeMs);
			if (!coerced.ok) continue;
			const syntheticMatcher: LeafMatcher = {
				kind: 'string',
				value: String(val),
				quoted: propType === 'text' || propType === 'multitext',
			};
			validDescs.push(
				describePropertyLeaf(
					syntheticMatcher,
					propType,
					operator,
					timeZone,
					referenceTimeMs,
					true,
					concepts,
				),
			);
		}
		if (validDescs.length === 0) {
			return `⚠️ ${rawCode} has no valid \`${propType}\` values on the host note (evaluates to \`false\`)`;
		}
		if (validDescs.length === 1) {
			return `${validDescs[0]!} (from ${rawCode})`;
		}
		return `(${validDescs.join(' OR ')}) (from ${rawCode})`;
	}

	if (matcher.kind === 'query') {
		concepts.add('cross-query-waves');
		const rawCode = formatInlineCode(matcher.raw);
		if (
			propType === 'checkbox' &&
			(operator === '<' || operator === '>' || operator === '<=' || operator === '>=')
		) {
			return `❌ ${rawCode} (ordering comparison is not supported on \`checkbox\` properties)`;
		}
		return `compares against scalar values projected from ${rawCode} (sibling query ${formatInlineCode(`@query.${matcher.queryName}`)})`;
	}

	const rawLit = formatInlineCode(formatLeafMatcher(matcher));
	switch (propType) {
		case 'number': {
			const trimmed = matcher.value.trim();
			const ok =
				!matcher.quoted &&
				STRICT_NUMBER_RE.test(trimmed) &&
				Number.isFinite(Number(trimmed));
			if (!ok) {
				return `❌ ${rawLit} (expected an unquoted number such as \`42\` or \`-3.5\`)`;
			}
			const num = Number(trimmed);
			switch (operator) {
				case ':':
				case '=':
					return `equals \`${num}\``;
				case '!=':
					return `does not equal \`${num}\``;
				case '<':
					return `is less than \`${num}\``;
				case '<=':
					return `is at most \`${num}\``;
				case '>':
					return `is greater than \`${num}\``;
				case '>=':
					return `is at least \`${num}\``;
				default:
					return `matches \`${num}\``;
			}
		}
		case 'checkbox': {
			if (operator === '<' || operator === '>' || operator === '<=' || operator === '>=') {
				return `❌ ${rawLit} (ordering comparison is not supported on \`checkbox\` properties)`;
			}
			const lower = matcher.value.trim().toLowerCase();
			const ok = !matcher.quoted && (lower === 'true' || lower === 'false');
			if (!ok) {
				return `❌ ${rawLit} (checkbox requires unquoted \`true\` or \`false\`)`;
			}
			return operator === '!=' ? `is not \`${lower}\`` : `is \`${lower}\``;
		}
		case 'date':
		case 'datetime': {
			concepts.add('temporal-intervals');
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
			const startIso = formatLocalIsoWithOffset(res.interval.start, timeZone);
			const endIso = formatLocalIsoWithOffset(res.interval.end, timeZone);
			const intervalCode = formatInlineCode(`[${startIso}, ${endIso})`);
			const fallbackNote =
				!validRefTime && /(?:^|\.\.)\s*@/.test(matcher.value.trim())
					? ' *(resolved against fallback epoch `0` because `referenceTimeMs` is invalid)*'
					: '';
			switch (operator) {
				case ':':
				case '=':
					return `falls within ${intervalCode} (in ${formatInlineCode(timeZone)})${fallbackNote}`;
				case '!=':
					return `is outside ${intervalCode} (in ${formatInlineCode(timeZone)})${fallbackNote}`;
				default:
					return `${win.plainEnglish} (expanded window ${intervalCode})${fallbackNote}`;
			}
		}
		case 'text':
		case 'multitext': {
			switch (operator) {
				case ':':
					return `contains ${rawLit} (case-insensitive)`;
				case '=':
					return `equals ${rawLit} (case-insensitive)`;
				case '!=':
					return `does not equal ${rawLit} (case-insensitive)`;
				case '<':
					return `comes alphabetically before ${rawLit} (case-insensitive)`;
				case '<=':
					return `comes alphabetically at or before ${rawLit} (case-insensitive)`;
				case '>':
					return `comes alphabetically after ${rawLit} (case-insensitive)`;
				case '>=':
					return `comes alphabetically at or after ${rawLit} (case-insensitive)`;
				default:
					return `matches ${rawLit}`;
			}
		}
	}
}

/**
 * Analyzes `input` into a pure, footnote-free `QueryExplainAnalysis` with progressive-shrinking
 * AST bullets, compile/DAG/lint diagnostics, queried property keys, path literals, and triggered
 * `ExplainConceptKey` topics without scanning vault notes.
 */
export function analyzeQueryExplain(
	input: string,
	configOrResolved: ResolvedEngineConfig | EngineConfig,
	referenceTimeMs: number,
	options?: AnalyzeQueryExplainOptions,
): QueryExplainAnalysis {
	const hostDoc = options?.hostDoc;
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

	const tzValid = resolvedConfig !== null;
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
	const invalidPropertyNodes: ReadonlySet<PropertyFilterNode> = (() => {
		if (parsed.ast === null) return parsed.invalidPropertyNodes;
		const valRes = validateQueryAST(
			parsed.ast,
			effectiveConfig,
			effectiveRefTimeMs,
			parsed.invalidPropertyNodes,
			hostDoc,
			options?.knownQueryNames,
		);
		resolvedAst = valRes.ast;
		valDiagnostics = valRes.diagnostics;
		lintDiagnostics = lintQueryAST(resolvedAst, valRes.invalidPropertyNodes, effectiveConfig);
		return valRes.invalidPropertyNodes;
	})();

	const concepts = new Set<ExplainConceptKey>();
	const queriedKeys = new Set<string>();
	const pathFilterLiterals: string[] = [];
	const queryDepsSet = new Set<string>();
	let usesHostReference = false;
	const unknownScopeNodes = new Set<SearchAST>();
	const invalidRegexNodes = new Set<SearchAST>();

	const visitValueFlags = (
		expr: ValueExprAST,
		ownerNode: SearchAST,
		collectStringsInto?: string[],
	): void => {
		if (expr.type === 'VALUE_LEAF') {
			if (
				expr.matcher.kind === 'regex' &&
				validateRegexLiteral(expr.matcher.pattern, expr.matcher.flags) === null
			) {
				invalidRegexNodes.add(ownerNode);
			}
			if (expr.matcher.kind === 'this') {
				usesHostReference = true;
			} else if (expr.matcher.kind === 'query') {
				concepts.add('cross-query-waves');
				queryDepsSet.add(expr.matcher.queryName);
			} else if (expr.matcher.kind === 'string' && collectStringsInto) {
				collectStringsInto.push(expr.matcher.value);
			}
		} else if (expr.type === 'VALUE_NOT') {
			visitValueFlags(expr.child, ownerNode, collectStringsInto);
		} else {
			for (const c of expr.children) {
				visitValueFlags(c, ownerNode, collectStringsInto);
			}
		}
	};

	const collectAstFlags = (node: SearchAST): void => {
		switch (node.type) {
			case 'MATCH_ALL':
				return;
			case 'LOGICAL':
				for (const c of node.children) collectAstFlags(c);
				return;
			case 'NOT':
				collectAstFlags(node.child);
				return;
			case 'SCOPED_FILTER': {
				if (node.rawScope !== '#' && !effectiveConfig.getScope(node.rawScope)) {
					unknownScopeNodes.add(node);
				}
				visitValueFlags(
					node.expr,
					node,
					node.scope === 'path' ? pathFilterLiterals : undefined,
				);
				return;
			}
			case 'PROPERTY_FILTER': {
				const sysScope = getSystemScopeForPropertyKey(node.key);
				if (sysScope === undefined) {
					const tInfo = resolvePropertyTypeWithOrigin(
						node.key,
						effectiveConfig.propertyTypes,
					);
					if (tInfo.type === 'date' || tInfo.type === 'datetime') {
						concepts.add('temporal-intervals');
					}
					if (!isVirtualFileKey(node.key) && node.key.length > 0) {
						queriedKeys.add(node.key);
						concepts.add('property-coercion');
					}
				}
				if (node.valueExpr) {
					const isPathProp = node.key === 'file.path' || node.key === 'file.parent';
					visitValueFlags(
						node.valueExpr,
						node,
						isPathProp ? pathFilterLiterals : undefined,
					);
				}
				return;
			}
			case 'SCOPE_GRAPH_FILTER': {
				concepts.add('graph-traversal');
				if (!effectiveConfig.getScope(node.rawScope)) {
					unknownScopeNodes.add(node);
				}
				if (node.target.kind === 'subquery') {
					collectAstFlags(node.target.ast);
				} else if (node.target.kind === 'query_ref') {
					concepts.add('cross-query-waves');
					queryDepsSet.add(node.target.queryName);
				} else {
					usesHostReference = true;
				}
				return;
			}
			case 'PROPERTY_GRAPH_FILTER': {
				concepts.add('graph-traversal');
				if (node.target.kind === 'subquery') {
					collectAstFlags(node.target.ast);
				} else if (node.target.kind === 'query_ref') {
					concepts.add('cross-query-waves');
					queryDepsSet.add(node.target.queryName);
				} else {
					usesHostReference = true;
				}
				return;
			}
		}
	};

	if (resolvedAst !== null) {
		collectAstFlags(resolvedAst);
	}

	const rawAllDiags: SearchDiagnostic[] = [
		...configDiagnostics,
		...refTimeDiagnostics,
		...parsed.diagnostics,
		...valDiagnostics,
		...(options?.extraDiagnostics ?? []),
		...lintDiagnostics,
	];
	const dedupedDiagnostics: SearchDiagnostic[] = [];
	const seenDiagKeys = new Set<string>();
	for (const d of rawAllDiags) {
		const k = `${d.code}:${d.span?.startOffset ?? -1}:${d.span?.endOffset ?? -1}:${d.issue}`;
		if (!seenDiagKeys.has(k)) {
			seenDiagKeys.add(k);
			dedupedDiagnostics.push(d);
		}
	}

	const errorCount = dedupedDiagnostics.filter((d) => d.severity === 'error').length;
	const warningCount = dedupedDiagnostics.filter((d) => d.severity === 'warning').length;
	const hintCount = dedupedDiagnostics.filter((d) => d.severity === 'hint').length;
	const executable = resolvedAst !== null && errorCount === 0;

	const diagIndicesBySpan = new Map<string, number[]>();
	dedupedDiagnostics.forEach((diag, i) => {
		if (diag.span) {
			const key = spanKey(diag.span);
			const list = diagIndicesBySpan.get(key) ?? [];
			list.push(i + 1);
			diagIndicesBySpan.set(key, list);
		}
	});
	const attachedDiagNumbers = new Set<number>();

	const consumeDiagBadgesForSpan = (span: SourceSpan | undefined): string => {
		if (!span) return '';
		const nums = diagIndicesBySpan.get(spanKey(span));
		if (!nums || nums.length === 0) return '';
		const badges: string[] = [];
		for (const num of nums) {
			if (!attachedDiagNumbers.has(num)) {
				attachedDiagNumbers.add(num);
				badges.push(formatInlineDiagBadge(dedupedDiagnostics[num - 1]!));
			}
		}
		return badges.length > 0 ? ` · ${badges.join(' ')}` : '';
	};

	const consumeUnattachedContainedDiags = (span: SourceSpan | undefined): string => {
		if (!span) return '';
		const badges: string[] = [];
		dedupedDiagnostics.forEach((diag, idx) => {
			const num = idx + 1;
			if (attachedDiagNumbers.has(num) || !diag.span) return;
			if (
				diag.span.startOffset >= span.startOffset &&
				diag.span.endOffset <= span.endOffset
			) {
				attachedDiagNumbers.add(num);
				badges.push(formatInlineDiagBadge(diag));
			}
		});
		return badges.length > 0 ? ` · ${badges.join(' ')}` : '';
	};

	const todayParsed = parseTemporalExpr('@today', {
		allowYearOnly: true,
		allowRelative: true,
		timeZone: effectiveConfig.timeZone,
		referenceTimeMs: effectiveRefTimeMs,
	});
	const todayLocalWindow = todayParsed.ok
		? `[${formatLocalIsoWithOffset(todayParsed.interval.start, effectiveConfig.timeZone)}, ${formatLocalIsoWithOffset(todayParsed.interval.end, effectiveConfig.timeZone)})`
		: '[1970-01-01T00:00:00Z, 1970-01-02T00:00:00Z)';
	const nowLocalIso = validRefTime
		? formatLocalIsoWithOffset(referenceTimeMs, effectiveConfig.timeZone)
		: null;

	const bulletLines: string[] = [];
	if (resolvedAst !== null) {
		const renderValueExprBullets = (
			expr: ValueExprAST,
			indent: string,
			targetNoun: string,
			leafFormatter: (matcher: LeafMatcher) => string,
		): void => {
			const sliceCode = formatInlineCode(extractValueExprSlice(input, expr));
			switch (expr.type) {
				case 'VALUE_LEAF': {
					const desc = capitalizeFirst(leafFormatter(expr.matcher));
					const exactDiagSuffix = consumeDiagBadgesForSpan(expr.span);
					bulletLines.push(`${indent}- ${sliceCode}`);
					bulletLines.push(`${indent}  ${desc}.${exactDiagSuffix}`);
					return;
				}
				case 'VALUE_NOT': {
					const exactDiagSuffix = consumeDiagBadgesForSpan(expr.span);
					bulletLines.push(`${indent}- ${sliceCode}`);
					bulletLines.push(
						`${indent}  Does *not* match (\`!\` / \`NOT\`):${exactDiagSuffix}`,
					);
					renderValueExprBullets(expr.child, `${indent}  `, targetNoun, leafFormatter);
					return;
				}
				case 'VALUE_LOGICAL': {
					const combLabel =
						expr.operator === 'OR'
							? `*Any* of the following on that same ${targetNoun} (\`OR\`):`
							: expr.implicit
								? `*All* of the following on that same ${targetNoun} (implicit \`AND\`):`
								: `*All* of the following on that same ${targetNoun} (\`AND\`):`;
					const exactDiagSuffix = consumeDiagBadgesForSpan(expr.span);
					const headerIdx = bulletLines.length;
					bulletLines.push(`${indent}- ${sliceCode}`);
					bulletLines.push(`${indent}  ${combLabel}${exactDiagSuffix}`);
					for (const child of expr.children) {
						renderValueExprBullets(child, `${indent}  `, targetNoun, leafFormatter);
					}
					const remainingDiagSuffix = consumeUnattachedContainedDiags(expr.span);
					if (remainingDiagSuffix) {
						bulletLines[headerIdx + 1] =
							`${bulletLines[headerIdx + 1]}${remainingDiagSuffix}`;
					}
					return;
				}
			}
		};

		const renderAstBullets = (node: SearchAST, indent: string): void => {
			if (node.type === 'MATCH_ALL') {
				const sliceDisplay =
					input.trim().length === 0 ? '_(empty query)_' : formatInlineCode(input.trim());
				bulletLines.push(`${indent}- ${sliceDisplay}`);
				bulletLines.push(
					`${indent}  Matches every Markdown note in the vault (\`MATCH_ALL\`).`,
				);
				return;
			}

			const sliceCode = formatInlineCode(extractAstSlice(input, node));
			switch (node.type) {
				case 'LOGICAL': {
					const combLabel =
						node.operator === 'OR'
							? 'Matches notes where *any* of the following hold (`OR`):'
							: node.implicit
								? 'Matches notes where *all* of the following hold (implicit `AND`):'
								: 'Matches notes where *all* of the following hold (`AND`):';
					const exactDiagSuffix = consumeDiagBadgesForSpan(node.span);
					const headerIdx = bulletLines.length;
					bulletLines.push(`${indent}- ${sliceCode}`);
					bulletLines.push(`${indent}  ${combLabel}${exactDiagSuffix}`);
					for (const child of node.children) {
						renderAstBullets(child, `${indent}  `);
					}
					const rem = consumeUnattachedContainedDiags(node.span);
					if (rem) bulletLines[headerIdx + 1] = `${bulletLines[headerIdx + 1]}${rem}`;
					return;
				}
				case 'NOT': {
					const exactDiagSuffix = consumeDiagBadgesForSpan(node.span);
					const headerIdx = bulletLines.length;
					bulletLines.push(`${indent}- ${sliceCode}`);
					bulletLines.push(
						`${indent}  Excludes notes matching (\`!\` / \`NOT\`):${exactDiagSuffix}`,
					);
					renderAstBullets(node.child, `${indent}  `);
					const rem = consumeUnattachedContainedDiags(node.span);
					if (rem) bulletLines[headerIdx + 1] = `${bulletLines[headerIdx + 1]}${rem}`;
					return;
				}
				case 'SCOPED_FILTER': {
					if (unknownScopeNodes.has(node)) {
						const suggestion = suggestScopeHint(node.rawScope, effectiveConfig);
						const exact = consumeDiagBadgesForSpan(node.span);
						const rem = consumeUnattachedContainedDiags(node.span);
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ❌ Unknown search scope ${formatInlineCode(`${node.rawScope}:`)}.${suggestion ? ` ${suggestion}` : ''}${exact}${rem}`,
						);
						return;
					}
					const sem = describeScopeSemantics(node.scope);
					const aliasParen =
						node.rawScope !== '#' &&
						node.rawScope.trim().toLowerCase() !== node.scope.toLowerCase()
							? ` (alias for ${formatInlineCode(`${node.scope}:`)})`
							: '';
					const scopeTargetLabel = `${formatInlineCode(node.scope)}${aliasParen}`;
					const scopeOp = node.operator ?? ':';
					const formatScopeValue = (val: string): string =>
						formatScopeStringMatch(node.scope, scopeOp, val);
					const invalidPrefix = invalidRegexNodes.has(node) ? '❌ ' : '';

					if (node.expr.type === 'VALUE_LEAF') {
						const m = node.expr.matcher;
						const invalidRegexComparison = m.kind === 'regex' && scopeOp !== ':';
						const leafDesc =
							m.kind === 'regex'
								? invalidRegexComparison
									? ''
									: `matches ${formatDirectRegexLink(m)}`
								: m.kind === 'this'
									? describeScopeThisLeaf(m, formatScopeValue, hostDoc)
									: m.kind === 'query'
										? `matches scalar values projected from ${formatInlineCode(m.raw)} (sibling query ${formatInlineCode(`@query.${m.queryName}`)})`
										: formatScopeValue(m.value);
						const exact = consumeDiagBadgesForSpan(node.span);
						const leafDiag = consumeDiagBadgesForSpan(node.expr.span);
						const rem = consumeUnattachedContainedDiags(node.span);
						const description = invalidRegexComparison
							? `Operator ${formatInlineCode(scopeOp)} cannot be used with a regular expression`
							: `At least one ${scopeTargetLabel} ${leafDesc}`;
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ${invalidPrefix}${description}.${exact}${leafDiag}${rem}`,
						);
					} else {
						const exact = consumeDiagBadgesForSpan(node.span);
						const headerIdx = bulletLines.length;
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ${invalidPrefix}At least one ${scopeTargetLabel} satisfies:${exact}`,
						);
						renderValueExprBullets(node.expr, `${indent}  `, sem.singularTarget, (m) =>
							m.kind === 'regex'
								? `matches ${formatDirectRegexLink(m)}`
								: m.kind === 'this'
									? describeScopeThisLeaf(m, formatScopeValue, hostDoc)
									: m.kind === 'query'
										? `matches scalar values projected from ${formatInlineCode(m.raw)} (sibling query ${formatInlineCode(`@query.${m.queryName}`)})`
										: formatScopeValue(m.value),
						);
						const rem = consumeUnattachedContainedDiags(node.span);
						if (rem) bulletLines[headerIdx + 1] = `${bulletLines[headerIdx + 1]}${rem}`;
					}
					return;
				}
				case 'SCOPE_GRAPH_FILTER': {
					if (unknownScopeNodes.has(node)) {
						const suggestion = suggestScopeHint(node.rawScope, effectiveConfig);
						const exact = consumeDiagBadgesForSpan(node.span);
						const rem = consumeUnattachedContainedDiags(node.span);
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ❌ Unknown search scope ${formatInlineCode(node.rawScope)}.${suggestion ? ` ${suggestion}` : ''}${exact}${rem}`,
						);
						return;
					}
					if (!isGraphScopeCanonicalName(node.scope)) {
						const exact = consumeDiagBadgesForSpan(node.span);
						const rem = consumeUnattachedContainedDiags(node.span);
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ❌ Scope ${formatInlineCode(node.scope)} does not support graph traversal (only \`links\`, \`embeds\`, and \`backlinks\` support graph targets).${exact}${rem}`,
						);
						return;
					}
					const hopDesc = describeHopBounds(node.hops);
					const edgeDesc =
						node.scope === 'backlinks'
							? node.direction === 'outgoing'
								? 'incoming `backlinks`'
								: 'inverted `backlinks` (outgoing links)'
							: node.direction === 'outgoing'
								? `outgoing ${formatInlineCode(node.scope)}`
								: `incoming ${formatInlineCode(node.scope)} from other notes`;
					const exact = consumeDiagBadgesForSpan(node.span);

					if (node.target.kind === 'subquery') {
						const headerIdx = bulletLines.length;
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  Traverses ${edgeDesc} ${hopDesc} to reach a note matching:${exact}`,
						);
						renderAstBullets(node.target.ast, `${indent}  `);
						const rem = consumeUnattachedContainedDiags(node.span);
						if (rem) bulletLines[headerIdx + 1] = `${bulletLines[headerIdx + 1]}${rem}`;
						return;
					}
					const targetDiag = consumeDiagBadgesForSpan(node.target.span);
					const rem = consumeUnattachedContainedDiags(node.span);
					const targetDesc =
						node.target.kind === 'query_ref'
							? `a note matched by sibling query ${formatInlineCode(`@query.${node.target.queryName}`)}`
							: hostDoc === null
								? '⚠️ `@this` (unavailable without a hosting note; evaluates to `false`)'
								: hostDoc !== undefined
									? `host note ${formatInlineCode(hostDoc.file.path)} (\`@this\`)`
									: 'the hosting note (`@this`)';
					bulletLines.push(`${indent}- ${sliceCode}`);
					bulletLines.push(
						`${indent}  Traverses ${edgeDesc} ${hopDesc} to reach ${targetDesc}.${exact}${targetDiag}${rem}`,
					);
					return;
				}
				case 'PROPERTY_GRAPH_FILTER': {
					const keyCode = formatInlineCode(node.rawKey || node.key);
					const hopDesc = describeHopBounds(node.hops);
					const edgeDesc =
						node.direction === 'outgoing'
							? `outgoing ${keyCode} property links`
							: `incoming ${keyCode} property links from other notes`;
					const exact = consumeDiagBadgesForSpan(node.span);

					if (node.target.kind === 'subquery') {
						const headerIdx = bulletLines.length;
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  Traverses ${edgeDesc} ${hopDesc} to reach a note matching:${exact}`,
						);
						renderAstBullets(node.target.ast, `${indent}  `);
						const rem = consumeUnattachedContainedDiags(node.span);
						if (rem) bulletLines[headerIdx + 1] = `${bulletLines[headerIdx + 1]}${rem}`;
						return;
					}
					const targetDiag = consumeDiagBadgesForSpan(node.target.span);
					const rem = consumeUnattachedContainedDiags(node.span);
					const targetDesc =
						node.target.kind === 'query_ref'
							? `a note matched by sibling query ${formatInlineCode(`@query.${node.target.queryName}`)}`
							: hostDoc === null
								? '⚠️ `@this` (unavailable without a hosting note; evaluates to `false`)'
								: hostDoc !== undefined
									? `host note ${formatInlineCode(hostDoc.file.path)} (\`@this\`)`
									: 'the hosting note (`@this`)';
					bulletLines.push(`${indent}- ${sliceCode}`);
					bulletLines.push(
						`${indent}  Traverses ${edgeDesc} ${hopDesc} to reach ${targetDesc}.${exact}${targetDiag}${rem}`,
					);
					return;
				}
				case 'PROPERTY_FILTER': {
					const keyCode = formatInlineCode(node.key);
					const systemScope = getSystemScopeForPropertyKey(node.key);
					if (systemScope !== undefined) {
						const exact = consumeDiagBadgesForSpan(node.span);
						const rem = consumeUnattachedContainedDiags(node.span);
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ${keyCode} is a built-in note scope, not a property (use ${formatInlineCode(`${systemScope}:`)} instead).${exact}${rem}`,
						);
						return;
					}
					const typeInfo = resolvePropertyTypeWithOrigin(
						node.key,
						effectiveConfig.propertyTypes,
					);
					const propTargetLabel = `${keyCode} ${formatPropertyTypeInlineBadge(typeInfo)}`;
					const isInvalid = invalidPropertyNodes.has(node) || invalidRegexNodes.has(node);
					const prefix = isInvalid ? '❌ ' : '';

					if (node.operator === 'EXISTS') {
						const exact = consumeDiagBadgesForSpan(node.span);
						const rem = consumeUnattachedContainedDiags(node.span);
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ${prefix}${propTargetLabel} is present on the note (regardless of value).${exact}${rem}`,
						);
						return;
					}
					if (node.operator === 'EMPTY') {
						const exact = consumeDiagBadgesForSpan(node.span);
						const rem = consumeUnattachedContainedDiags(node.span);
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ${prefix}${propTargetLabel} is present on the note with no value (empty or null).${exact}${rem}`,
						);
						return;
					}
					if (node.valueExpr && node.valueExpr.type === 'VALUE_LEAF') {
						const leafDesc = describePropertyLeaf(
							node.valueExpr.matcher,
							typeInfo.type,
							node.operator,
							effectiveConfig.timeZone,
							effectiveRefTimeMs,
							validRefTime,
							concepts,
							hostDoc,
						);
						const exact = consumeDiagBadgesForSpan(node.span);
						const leafDiag = consumeDiagBadgesForSpan(node.valueExpr.span);
						const rem = consumeUnattachedContainedDiags(node.span);
						const singleLeafPrefix =
							leafDesc.startsWith('❌ ') && node.key.length > 0 ? '' : prefix;
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ${singleLeafPrefix}${propTargetLabel} ${leafDesc}.${exact}${leafDiag}${rem}`,
						);
					} else if (node.valueExpr) {
						const exact = consumeDiagBadgesForSpan(node.span);
						const headerIdx = bulletLines.length;
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ${prefix}At least one ${propTargetLabel} value satisfies:${exact}`,
						);
						renderValueExprBullets(
							node.valueExpr,
							`${indent}  `,
							`${keyCode} value`,
							(m) =>
								describePropertyLeaf(
									m,
									typeInfo.type,
									node.operator,
									effectiveConfig.timeZone,
									effectiveRefTimeMs,
									validRefTime,
									concepts,
									hostDoc,
								),
						);
						const rem = consumeUnattachedContainedDiags(node.span);
						if (rem) bulletLines[headerIdx + 1] = `${bulletLines[headerIdx + 1]}${rem}`;
					}
					return;
				}
			}
		};

		renderAstBullets(resolvedAst, '');
	}

	return Object.freeze({
		input,
		executable,
		ast: resolvedAst,
		effectiveTimeZone: effectiveConfig.timeZone,
		displayTimeZone,
		timeZoneValid: tzValid,
		referenceTimeMs: effectiveRefTimeMs,
		validReferenceTime: validRefTime,
		nowLocalIso,
		todayLocalWindow,
		astBullets: Object.freeze(bulletLines),
		diagnostics: Object.freeze(dedupedDiagnostics),
		errorCount,
		warningCount,
		hintCount,
		queriedKeys,
		pathFilterLiterals: Object.freeze(pathFilterLiterals),
		queryDependencies: Object.freeze([...queryDepsSet]),
		usesHostReference,
		concepts,
	});
}
