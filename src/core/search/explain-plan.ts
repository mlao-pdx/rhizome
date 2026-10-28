import { Temporal } from '@js-temporal/polyfill';
import { initEngineConfig } from './config';
import {
	FootnoteRegistry,
	refBareScopeFootnote,
	refDiagnosticFootnote,
	refIntervalFootnote,
	refPropertyFootnote,
	refRegexFootnote,
	refScopeFootnote,
	refTimezoneFootnote,
} from './explain-concepts';
import {
	buildRegex101Url,
	describeScopeSemantics,
	extractAstSlice,
	extractValueExprSlice,
	formatDateIntervalWindow,
	formatEpochTimestamp,
	formatInlineCode,
	formatLeafMatcher,
	formatSourceCaretSnippet,
	resolvePropertyTypeWithOrigin,
} from './explain-helpers';
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
	type SourceSpan,
	type ValueExprAST,
} from './types';
import { suggestScopeHint, validateQueryAST } from './validator';

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

function formatDirectRegexLink(
	matcher: Extract<LeafMatcher, { kind: 'regex' }>,
	footnotes: FootnoteRegistry,
): string {
	const literal = formatLeafMatcher(matcher);
	const url = buildRegex101Url(matcher.pattern, matcher.flags);
	const fn = refRegexFootnote(footnotes);
	return `[${formatInlineCode(literal)}](${url})${fn}`;
}

function capitalizeFirst(text: string): string {
	if (!text) return text;
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function spanKey(span: SourceSpan): string {
	return `${span.startOffset}:${span.endOffset}`;
}

function describePropertyLeaf(
	matcher: LeafMatcher,
	propType: ObsidianPropertyType,
	operator: PropertyOperator,
	timeZone: string,
	configuredTimeZone: string,
	tzValid: boolean,
	referenceTimeMs: number,
	validRefTime: boolean,
	todayLocalWindow: string | undefined,
	footnotes: FootnoteRegistry,
): string {
	if (matcher.kind === 'regex') {
		const valid = validateRegexLiteral(matcher.pattern, matcher.flags) !== null;
		const link = formatDirectRegexLink(matcher, footnotes);
		if (operator !== ':' || propType === 'checkbox') {
			return `❌ ${link} (regular expressions cannot be used with this operator on \`${propType}\` properties)`;
		}
		const isRawTarget = propType === 'number' || propType === 'date' || propType === 'datetime';
		return isRawTarget
			? `${valid ? 'has raw text matching' : '❌ invalid regex'} ${link}`
			: `${valid ? 'matches' : '❌ invalid regex'} ${link}`;
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
			const intervalFn = refIntervalFootnote(footnotes, todayLocalWindow);
			const tzFn = refTimezoneFootnote(footnotes, timeZone, configuredTimeZone, tzValid);
			const fallbackNote =
				!validRefTime && /(?:^|\.\.)\s*@/.test(matcher.value.trim())
					? ' *(resolved against fallback epoch `0` because `referenceTimeMs` is invalid)*'
					: '';
			switch (operator) {
				case ':':
				case '=':
					return `falls within ${intervalCode}${intervalFn} (in ${formatInlineCode(timeZone)}${tzFn})${fallbackNote}`;
				case '!=':
					return `is outside ${intervalCode}${intervalFn} (in ${formatInlineCode(timeZone)}${tzFn})${fallbackNote}`;
				default:
					return `${win.plainEnglish} (expanded window ${intervalCode}${intervalFn}${tzFn})${fallbackNote}`;
			}
		}
		case 'tags': {
			const normTag = normalizeTagBody(matcher.value);
			const hashTagCode = formatInlineCode(`#${normTag}`);
			const subTagCode = formatInlineCode(`#${normTag}/...`);
			switch (operator) {
				case ':':
					return `is ${hashTagCode} or a nested tag under ${subTagCode} (case-insensitive)`;
				case '=':
					return `equals exact tag ${hashTagCode} (case-insensitive)`;
				case '!=':
					return `does not equal exact tag ${hashTagCode} (case-insensitive)`;
				case '<':
					return `comes alphabetically before tag ${hashTagCode} (case-insensitive)`;
				case '<=':
					return `comes alphabetically at or before tag ${hashTagCode} (case-insensitive)`;
				case '>':
					return `comes alphabetically after tag ${hashTagCode} (case-insensitive)`;
				case '>=':
					return `comes alphabetically at or after tag ${hashTagCode} (case-insensitive)`;
				default:
					return `matches tag ${hashTagCode} (case-insensitive)`;
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
 * Generates a progressive-shrinking Markdown explanation plan with inline footnotes and a
 * `## Concept Reference` section for a search query without scanning vault notes.
 */
export function explainQuery(
	input: string,
	configOrResolved: ResolvedEngineConfig | EngineConfig,
	referenceTimeMs: number,
	heading = 'Query Explain Plan',
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

	function collectAstFlags(node: SearchAST): void {
		switch (node.type) {
			case 'MATCH_ALL':
				return;
			case 'LOGICAL':
				for (const c of node.children) collectAstFlags(c);
				return;
			case 'NOT':
				collectAstFlags(node.child);
				return;
			case 'TEXT_MATCH':
				if (
					node.matcher.kind === 'regex' &&
					validateRegexLiteral(node.matcher.pattern, node.matcher.flags) === null
				) {
					invalidRegexNodes.add(node);
				}
				return;
			case 'SCOPED_FILTER': {
				if (node.rawScope !== '#' && !effectiveConfig.getScope(node.rawScope)) {
					unknownScopeNodes.add(node);
				}
				const visitExpr = (expr: ValueExprAST): void => {
					if (expr.type === 'VALUE_LEAF') {
						if (
							expr.matcher.kind === 'regex' &&
							validateRegexLiteral(expr.matcher.pattern, expr.matcher.flags) === null
						) {
							invalidRegexNodes.add(node);
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
				if (!node.valueExpr) return;
				const visitExpr = (expr: ValueExprAST): void => {
					if (expr.type === 'VALUE_LEAF') {
						if (
							expr.matcher.kind === 'regex' &&
							validateRegexLiteral(expr.matcher.pattern, expr.matcher.flags) === null
						) {
							invalidRegexNodes.add(node);
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
		collectAstFlags(resolvedAst);
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

	const footnotes = new FootnoteRegistry();
	const diagIndicesBySpan = new Map<string, number[]>();
	allDiagnostics.forEach((diag, i) => {
		if (diag.span) {
			const key = spanKey(diag.span);
			const list = diagIndicesBySpan.get(key) ?? [];
			list.push(i + 1);
			diagIndicesBySpan.set(key, list);
		}
	});
	const attachedDiagNumbers = new Set<number>();

	function consumeDiagLinksForSpan(span: SourceSpan | undefined): string {
		if (!span) return '';
		const nums = diagIndicesBySpan.get(spanKey(span));
		if (!nums || nums.length === 0) return '';
		const refs: string[] = [];
		for (const num of nums) {
			if (!attachedDiagNumbers.has(num)) {
				attachedDiagNumbers.add(num);
				const diag = allDiagnostics[num - 1]!;
				refs.push(refDiagnosticFootnote(footnotes, num, diag));
			}
		}
		return refs.length > 0 ? ` · ${refs.join(' ')}` : '';
	}

	function consumeUnattachedContainedDiags(span: SourceSpan | undefined): string {
		if (!span) return '';
		const refs: string[] = [];
		allDiagnostics.forEach((diag, idx) => {
			const num = idx + 1;
			if (attachedDiagNumbers.has(num) || !diag.span) return;
			if (
				diag.span.startOffset >= span.startOffset &&
				diag.span.endOffset <= span.endOffset
			) {
				attachedDiagNumbers.add(num);
				refs.push(refDiagnosticFootnote(footnotes, num, diag));
			}
		});
		return refs.length > 0 ? ` · ${refs.join(' ')}` : '';
	}

	// Compute @today window in effectiveConfig.timeZone at effectiveRefTimeMs
	const todayParsed = parseTemporalExpr('@today', {
		allowYearOnly: true,
		allowRelative: true,
		timeZone: effectiveConfig.timeZone,
		referenceTimeMs: effectiveRefTimeMs,
	});
	const todayLocalWindow = todayParsed.ok
		? `[${formatLocalIsoWithOffset(todayParsed.interval.start, effectiveConfig.timeZone)}, ${formatLocalIsoWithOffset(todayParsed.interval.end, effectiveConfig.timeZone)})`
		: '[1970-01-01T00:00:00Z, 1970-01-02T00:00:00Z)';

	const normalizedHeading =
		heading
			.replace(/[\r\n]+/g, ' ')
			.trim()
			.replace(/^#+\s*/, '') || 'Query Explain Plan';
	const lines: string[] = [`# ${normalizedHeading}`, ''];

	// =========================================================================
	// Header Context
	// =========================================================================
	const queryDisplay = input.trim().length === 0 ? '_(empty query)_' : formatInlineCode(input);
	const statusBadge = executable ? '*Executable*' : '*Not Executable*';
	lines.push(`- **Query**: ${queryDisplay}`);
	lines.push(
		`- **Status**: ${statusBadge} with ${errorCount} error${errorCount === 1 ? '' : 's'}, ${warningCount} warning${warningCount === 1 ? '' : 's'}, ${hintCount} hint${hintCount === 1 ? '' : 's'}.`,
	);
	lines.push('- **Context**:');
	if (validRefTime) {
		const nowLocalIso = formatLocalIsoWithOffset(referenceTimeMs, effectiveConfig.timeZone);
		lines.push(`  - \`@now\`: \`${nowLocalIso}\` (\`${referenceTimeMs}\` ms UTC)`);
	} else {
		lines.push(
			`  - \`@now\`: ❌ Invalid \`referenceTimeMs\` (${formatInlineCode(String(referenceTimeMs))}; fell back to epoch \`0\` for best-effort analysis)`,
		);
	}
	const todayIntervalFn = refIntervalFootnote(footnotes, todayLocalWindow);
	lines.push(`  - \`@today\`: \`${todayLocalWindow}\`${todayIntervalFn}`);
	const headerTzFn = refTimezoneFootnote(
		footnotes,
		effectiveConfig.timeZone,
		displayTimeZone,
		tzValid,
	);
	if (tzValid) {
		lines.push(`  - **Timezone**: ${formatInlineCode(effectiveConfig.timeZone)}${headerTzFn}`);
	} else {
		lines.push(
			`  - **Timezone**: ❌ Invalid timezone ${formatInlineCode(displayTimeZone)} (fell back to \`UTC\`${headerTzFn})`,
		);
	}
	lines.push('');

	// =========================================================================
	// SECTION 1: Logic Breakdown
	// =========================================================================
	lines.push('## Logic Breakdown', '');
	if (resolvedAst === null) {
		lines.push(
			'This query could not be parsed into an execution tree because of a syntax or query-length error. See *Diagnostics* below for the exact location and fix.',
			'',
		);
	} else {
		const bulletLines: string[] = [];

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
					const exactDiagSuffix = consumeDiagLinksForSpan(expr.span);
					bulletLines.push(`${indent}- ${sliceCode}`);
					bulletLines.push(`${indent}  ${desc}.${exactDiagSuffix}`);
					return;
				}
				case 'VALUE_NOT': {
					const exactDiagSuffix = consumeDiagLinksForSpan(expr.span);
					bulletLines.push(`${indent}- ${sliceCode}`);
					bulletLines.push(
						`${indent}  Does *not* match (\`-\` / \`NOT\`):${exactDiagSuffix}`,
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
					const exactDiagSuffix = consumeDiagLinksForSpan(expr.span);
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
					const exactDiagSuffix = consumeDiagLinksForSpan(node.span);
					const headerIdx = bulletLines.length;
					bulletLines.push(`${indent}- ${sliceCode}`);
					bulletLines.push(`${indent}  ${combLabel}${exactDiagSuffix}`);
					for (const child of node.children) {
						renderAstBullets(child, `${indent}  `);
					}
					const remainingDiagSuffix = consumeUnattachedContainedDiags(node.span);
					if (remainingDiagSuffix) {
						bulletLines[headerIdx + 1] =
							`${bulletLines[headerIdx + 1]}${remainingDiagSuffix}`;
					}
					return;
				}
				case 'NOT': {
					const exactDiagSuffix = consumeDiagLinksForSpan(node.span);
					const headerIdx = bulletLines.length;
					bulletLines.push(`${indent}- ${sliceCode}`);
					bulletLines.push(
						`${indent}  Excludes notes matching (\`-\` / \`NOT\`):${exactDiagSuffix}`,
					);
					renderAstBullets(node.child, `${indent}  `);
					const remainingDiagSuffix = consumeUnattachedContainedDiags(node.span);
					if (remainingDiagSuffix) {
						bulletLines[headerIdx + 1] =
							`${bulletLines[headerIdx + 1]}${remainingDiagSuffix}`;
					}
					return;
				}
				case 'TEXT_MATCH': {
					const bareFn = refBareScopeFootnote(footnotes);
					bulletLines.push(`${indent}- ${sliceCode}`);
					if (node.matcher.kind === 'regex') {
						const valid = !invalidRegexNodes.has(node);
						const prefix = valid ? '' : '❌ ';
						const link = formatDirectRegexLink(node.matcher, footnotes);
						const exactDiagSuffix = consumeDiagLinksForSpan(node.span);
						bulletLines.push(
							`${indent}  ${prefix}Note metadata (${bareFn}) ${valid ? 'matches' : 'has invalid regex'} ${link}.${exactDiagSuffix}`,
						);
					} else {
						const exactDiagSuffix = consumeDiagLinksForSpan(node.span);
						bulletLines.push(
							`${indent}  Note metadata (${bareFn}) contains ${formatInlineCode(node.matcher.value)} (case-insensitive).${exactDiagSuffix}`,
						);
					}
					return;
				}
				case 'SCOPED_FILTER': {
					if (unknownScopeNodes.has(node)) {
						const suggestion = suggestScopeHint(node.rawScope, effectiveConfig);
						const exactDiagSuffix = consumeDiagLinksForSpan(node.span);
						const remDiag = consumeUnattachedContainedDiags(node.span);
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ❌ Unknown search scope ${formatInlineCode(`${node.rawScope}:`)}.${suggestion ? ` ${suggestion}` : ''}${exactDiagSuffix}${remDiag}`,
						);
						return;
					}
					const sem = describeScopeSemantics(node.scope);
					const scopeFn = refScopeFootnote(footnotes, node.scope);
					const aliasParen =
						node.rawScope !== '#' &&
						node.rawScope.trim().toLowerCase() !== node.scope.toLowerCase()
							? ` (alias for ${formatInlineCode(`${node.scope}:`)})`
							: '';
					const scopeTargetLabel = `${formatInlineCode(node.scope)}${scopeFn}${aliasParen}`;
					const invalidPrefix = invalidRegexNodes.has(node) ? '❌ ' : '';

					if (node.expr.type === 'VALUE_LEAF') {
						const m = node.expr.matcher;
						const leafDesc =
							m.kind === 'regex'
								? `matches ${formatDirectRegexLink(m, footnotes)}`
								: sem.formatPlainStringMatch(m.value);
						const exactDiagSuffix = consumeDiagLinksForSpan(node.span);
						const leafDiag = consumeDiagLinksForSpan(node.expr.span);
						const remDiag = consumeUnattachedContainedDiags(node.span);
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ${invalidPrefix}At least one ${scopeTargetLabel} ${leafDesc}.${exactDiagSuffix}${leafDiag}${remDiag}`,
						);
					} else {
						const exactDiagSuffix = consumeDiagLinksForSpan(node.span);
						const headerIdx = bulletLines.length;
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ${invalidPrefix}At least one ${scopeTargetLabel} satisfies:${exactDiagSuffix}`,
						);
						renderValueExprBullets(node.expr, `${indent}  `, sem.singularTarget, (m) =>
							m.kind === 'regex'
								? `matches ${formatDirectRegexLink(m, footnotes)}`
								: sem.formatPlainStringMatch(m.value),
						);
						const remDiag = consumeUnattachedContainedDiags(node.span);
						if (remDiag) {
							bulletLines[headerIdx + 1] = `${bulletLines[headerIdx + 1]}${remDiag}`;
						}
					}
					return;
				}
				case 'PROPERTY_FILTER': {
					const keyCode = formatInlineCode(node.key);
					const typeInfo = resolvePropertyTypeWithOrigin(
						node.key,
						effectiveConfig.propertyTypes,
					);
					const propFn = refPropertyFootnote(footnotes, node.key, typeInfo);
					const propTargetLabel = `${keyCode}${propFn}`;
					const isInvalid = invalidPropertyNodes.has(node) || invalidRegexNodes.has(node);
					const prefix = isInvalid ? '❌ ' : '';

					if (node.operator === 'EXISTS') {
						const exactDiagSuffix = consumeDiagLinksForSpan(node.span);
						const remDiag = consumeUnattachedContainedDiags(node.span);
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ${prefix}${propTargetLabel} exists with a non-empty valid value.${exactDiagSuffix}${remDiag}`,
						);
						return;
					}

					if (node.valueExpr && node.valueExpr.type === 'VALUE_LEAF') {
						const leafDesc = describePropertyLeaf(
							node.valueExpr.matcher,
							typeInfo.type,
							node.operator,
							effectiveConfig.timeZone,
							displayTimeZone,
							tzValid,
							effectiveRefTimeMs,
							validRefTime,
							todayLocalWindow,
							footnotes,
						);
						const exactDiagSuffix = consumeDiagLinksForSpan(node.span);
						const leafDiag = consumeDiagLinksForSpan(node.valueExpr.span);
						const remDiag = consumeUnattachedContainedDiags(node.span);
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ${prefix}${propTargetLabel} ${leafDesc}.${exactDiagSuffix}${leafDiag}${remDiag}`,
						);
					} else if (node.valueExpr) {
						const exactDiagSuffix = consumeDiagLinksForSpan(node.span);
						const headerIdx = bulletLines.length;
						bulletLines.push(`${indent}- ${sliceCode}`);
						bulletLines.push(
							`${indent}  ${prefix}At least one ${propTargetLabel} value satisfies:${exactDiagSuffix}`,
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
									displayTimeZone,
									tzValid,
									effectiveRefTimeMs,
									validRefTime,
									todayLocalWindow,
									footnotes,
								),
						);
						const remDiag = consumeUnattachedContainedDiags(node.span);
						if (remDiag) {
							bulletLines[headerIdx + 1] = `${bulletLines[headerIdx + 1]}${remDiag}`;
						}
					}
					return;
				}
			}
		};

		renderAstBullets(resolvedAst, '');
		lines.push(...bulletLines, '');
	}

	// =========================================================================
	// SECTION 2: Diagnostics
	// =========================================================================
	lines.push('## Diagnostics', '');
	if (allDiagnostics.length === 0) {
		lines.push('> [!tip] No issues found');
		lines.push('> This query compiled cleanly with 0 errors, 0 warnings, and 0 lint hints.');
	} else {
		allDiagnostics.forEach((diag, idx) => {
			if (idx > 0) lines.push('');
			const num = idx + 1;
			const calloutType =
				diag.severity === 'error'
					? '[!danger]'
					: diag.severity === 'warning'
						? '[!warning]'
						: '[!info]';
			const sevTitle =
				diag.severity === 'error'
					? 'Error'
					: diag.severity === 'warning'
						? 'Warning'
						: 'Hint';
			const locText = diag.span
				? ` (line ${diag.span.startLine}, column ${diag.span.startColumn})`
				: '';
			lines.push(`> ${calloutType} ${sevTitle} ${num}: \`${diag.code}\`${locText}`);
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
				lines.push(`> *Fix*: ${diag.hint}`);
			}
		});
	}
	lines.push('');

	// =========================================================================
	// SECTION 3: Concept Reference
	// =========================================================================
	lines.push('## Concept Reference', '');
	lines.push(footnotes.renderDefinitions());

	return lines.join('\n');
}
