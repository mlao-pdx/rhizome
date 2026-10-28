import { initEngineConfig } from './config';
import {
	buildRegex101Url,
	describeScopeSemantics,
	describeVirtualFileKey,
	escapeMarkdownTableCell,
	formatAuthoredFilter,
	formatDateIntervalWindow,
	formatEpochTimestamp,
	formatInlineCode,
	formatLeafMatcher,
	formatScopeRhsDisplay,
	formatSourceCaretSnippet,
	resolvePropertyTypeWithOrigin,
	type ResolvedPropertyTypeInfo,
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

function capitalizeFirst(text: string): string {
	if (!text) return text;
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatFriendlyTypeNote(typeInfo: ResolvedPropertyTypeInfo): string {
	switch (typeInfo.origin) {
		case 'virtual':
			return `built-in file metadata, type \`${typeInfo.type}\``;
		case 'built-in':
			return `built-in Obsidian property, type \`${typeInfo.type}\``;
		case 'configured':
			return `configured as \`${typeInfo.type}\``;
		case 'default':
			return `unconfigured property, defaults to \`text\``;
	}
}

interface PropertyLeafExplanation {
	readonly plainEnglish: string;
	readonly reference: string;
}

function describePropertyLeaf(
	matcher: LeafMatcher,
	propType: ObsidianPropertyType,
	operator: PropertyOperator,
	timeZone: string,
	referenceTimeMs: number,
	validRefTime: boolean,
): PropertyLeafExplanation {
	if (matcher.kind === 'regex') {
		const valid = validateRegexLiteral(matcher.pattern, matcher.flags) !== null;
		const link = formatRegexLink(matcher);
		if (operator !== ':' || propType === 'checkbox') {
			return {
				plainEnglish: `❌ ${link} — regular expressions cannot be used with operator \`${operator}\` on \`${propType}\` properties`,
				reference: `❌ ${link} — regular expressions cannot be used with operator \`${operator}\` on \`${propType}\``,
			};
		}
		const isRawTarget = propType === 'number' || propType === 'date' || propType === 'datetime';
		const targetDesc = isRawTarget
			? `raw authored string (\`entry.raw\`) of \`${propType}\``
			: `\`${propType}\` value`;
		return {
			plainEnglish: isRawTarget
				? `${valid ? 'has raw text matching' : '❌ invalid regex'} ${link}`
				: `${valid ? 'matches regular expression' : '❌ invalid regex'} ${link}`,
			reference: `${valid ? '' : '❌ Invalid regex: '}${link} tested against ${targetDesc}`,
		};
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
				return {
					plainEnglish: `❌ ${rawLit} (expected an unquoted number such as \`42\` or \`-3.5\`)`,
					reference: `❌ ${rawLit} (not a valid unquoted finite number)`,
				};
			}
			const num = Number(trimmed);
			let plainEnglish: string;
			switch (operator) {
				case ':':
				case '=':
					plainEnglish = `equals \`${num}\``;
					break;
				case '!=':
					plainEnglish = `does not equal \`${num}\``;
					break;
				case '<':
					plainEnglish = `is less than \`${num}\``;
					break;
				case '<=':
					plainEnglish = `is at most \`${num}\` (\`<= ${num}\`)`;
					break;
				case '>':
					plainEnglish = `is greater than \`${num}\``;
					break;
				case '>=':
					plainEnglish = `is at least \`${num}\` (\`>= ${num}\`)`;
					break;
				default:
					plainEnglish = `matches \`${num}\``;
					break;
			}
			return {
				plainEnglish,
				reference: `${rawLit} → numeric \`${num}\` (\`entry.value ${operator === ':' ? '=' : operator} ${num}\`)`,
			};
		}
		case 'checkbox': {
			if (operator === '<' || operator === '>' || operator === '<=' || operator === '>=') {
				const msg = `❌ ${rawLit} — ordering operator \`${operator}\` cannot be used on \`checkbox\` properties`;
				return { plainEnglish: msg, reference: msg };
			}
			const lower = matcher.value.trim().toLowerCase();
			const ok = !matcher.quoted && (lower === 'true' || lower === 'false');
			if (!ok) {
				const msg = `❌ ${rawLit} (checkbox requires unquoted \`true\` or \`false\`)`;
				return { plainEnglish: msg, reference: msg };
			}
			return {
				plainEnglish: operator === '!=' ? `is not \`${lower}\`` : `is \`${lower}\``,
				reference: `${rawLit} → boolean \`${lower}\` (\`entry.value ${operator === ':' ? '=' : operator} ${lower}\`)`,
			};
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
				const msg = `❌ ${rawLit} (invalid ${propType} expression: \`${res.reason}\`)`;
				return { plainEnglish: msg, reference: msg };
			}
			const win = formatDateIntervalWindow(res.interval, operator, timeZone);
			const fallbackNote =
				!validRefTime && /(?:^|\.\.)\s*@/.test(matcher.value.trim())
					? ' *(resolved against fallback epoch `0` because `referenceTimeMs` is invalid)*'
					: '';
			return {
				plainEnglish: `${win.plainEnglish}${fallbackNote}`,
				reference: `${rawLit} → \`${win.grain}\` window \`${win.localWindow}\` (UTC \`${win.utcWindow}\`; matches when \`${win.inequality}\`, i.e. ${win.description})${fallbackNote}`,
			};
		}
		case 'tags': {
			const normTag = normalizeTagBody(matcher.value);
			const hashTagCode = formatInlineCode(`#${normTag}`);
			const subTagCode = formatInlineCode(`#${normTag}/...`);
			let plainEnglish: string;
			let reference: string;
			switch (operator) {
				case ':':
					plainEnglish = `is ${hashTagCode} (or a subtag like ${subTagCode}, case-insensitive)`;
					reference = `${rawLit} → hierarchical tag match on ${hashTagCode} (matches ${hashTagCode} or ${subTagCode})`;
					break;
				case '=':
					plainEnglish = `equals tag ${hashTagCode} (exact match, excluding subtags)`;
					reference = `${rawLit} → exact normalized tag equality (${formatInlineCode(`tag = #${normTag}`)})`;
					break;
				case '!=':
					plainEnglish = `does not equal tag ${hashTagCode}`;
					reference = `${rawLit} → normalized tag inequality (${formatInlineCode(`tag != #${normTag}`)})`;
					break;
				case '<':
					plainEnglish = `comes alphabetically before tag ${hashTagCode}`;
					reference = `${rawLit} → alphabetical tag comparison (${formatInlineCode(`tag < #${normTag}`)})`;
					break;
				case '<=':
					plainEnglish = `comes alphabetically at or before tag ${hashTagCode}`;
					reference = `${rawLit} → alphabetical tag comparison (${formatInlineCode(`tag <= #${normTag}`)})`;
					break;
				case '>':
					plainEnglish = `comes alphabetically after tag ${hashTagCode}`;
					reference = `${rawLit} → alphabetical tag comparison (${formatInlineCode(`tag > #${normTag}`)})`;
					break;
				case '>=':
					plainEnglish = `comes alphabetically at or after tag ${hashTagCode}`;
					reference = `${rawLit} → alphabetical tag comparison (${formatInlineCode(`tag >= #${normTag}`)})`;
					break;
				default:
					plainEnglish = `matches tag ${hashTagCode}`;
					reference = `${rawLit} → tag comparison (${formatInlineCode(`tag ${operator} #${normTag}`)})`;
					break;
			}
			return { plainEnglish, reference };
		}
		case 'text':
		case 'multitext': {
			let plainEnglish: string;
			let reference: string;
			switch (operator) {
				case ':':
					plainEnglish = `contains ${rawLit} (case-insensitive)`;
					reference = `${rawLit} → case-insensitive substring match`;
					break;
				case '=':
					plainEnglish = `equals ${rawLit} (case-insensitive)`;
					reference = `${rawLit} → case-insensitive equality (\`=\`)`;
					break;
				case '!=':
					plainEnglish = `does not equal ${rawLit} (case-insensitive)`;
					reference = `${rawLit} → case-insensitive inequality (\`!=\`, does not equal ${rawLit})`;
					break;
				case '<':
					plainEnglish = `comes alphabetically before ${rawLit} (case-insensitive)`;
					reference = `${rawLit} → case-insensitive alphabetical comparison (\`<\`)`;
					break;
				case '<=':
					plainEnglish = `comes alphabetically at or before ${rawLit} (case-insensitive)`;
					reference = `${rawLit} → case-insensitive alphabetical comparison (\`<=\`)`;
					break;
				case '>':
					plainEnglish = `comes alphabetically after ${rawLit} (case-insensitive)`;
					reference = `${rawLit} → case-insensitive alphabetical comparison (\`>\`)`;
					break;
				case '>=':
					plainEnglish = `comes alphabetically at or after ${rawLit} (case-insensitive)`;
					reference = `${rawLit} → case-insensitive alphabetical comparison (\`>=\`)`;
					break;
				default:
					plainEnglish = `matches ${rawLit}`;
					reference = `${rawLit} → case-insensitive comparison (\`${operator}\`)`;
					break;
			}
			return { plainEnglish, reference };
		}
	}
}

function renderValueExprBullets(
	expr: ValueExprAST,
	indent: string,
	targetNoun: string,
	leafFormatter: (matcher: LeafMatcher) => string,
	out: string[],
): void {
	switch (expr.type) {
		case 'VALUE_LEAF':
			out.push(`${indent}- ${capitalizeFirst(leafFormatter(expr.matcher))}`);
			return;
		case 'VALUE_NOT':
			if (expr.child.type === 'VALUE_LEAF') {
				out.push(
					`${indent}- **Not (\`${expr.syntax}\`)**: Does **not** match: ${leafFormatter(expr.child.matcher)}`,
				);
			} else {
				out.push(
					`${indent}- **Not (\`${expr.syntax}\`)**: Does **not** match the following:`,
				);
				renderValueExprBullets(expr.child, `${indent}  `, targetNoun, leafFormatter, out);
			}
			return;
		case 'VALUE_LOGICAL': {
			const opDesc =
				expr.operator === 'AND'
					? `**Both / all on that same ${targetNoun} (\`AND\`)**:`
					: `**Either / any (\`OR\`)**:`;
			out.push(`${indent}- ${opDesc}`);
			for (const child of expr.children) {
				renderValueExprBullets(child, `${indent}  `, targetNoun, leafFormatter, out);
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
				const keyCode = formatInlineCode(node.key);
				const visitExpr = (expr: ValueExprAST): void => {
					if (expr.type === 'VALUE_LEAF') {
						if (expr.matcher.kind === 'regex') {
							const valid =
								validateRegexLiteral(expr.matcher.pattern, expr.matcher.flags) !==
								null;
							if (!valid) invalidRegexNodes.add(node);
							let targetNote: string;
							if (node.operator !== ':' || typeInfo.type === 'checkbox') {
								targetNote = `Property ${keyCode} (\`${typeInfo.type}\`) — ❌ unsupported with operator \`${node.operator}\` on \`${typeInfo.type}\``;
							} else if (
								typeInfo.type === 'number' ||
								typeInfo.type === 'date' ||
								typeInfo.type === 'datetime'
							) {
								targetNote = `Property ${keyCode} (\`${typeInfo.type}\`) — tested against raw authored string \`entry.raw\``;
							} else {
								targetNote = `Property ${keyCode} (\`${typeInfo.type}\`) — tested against normalized string \`entry.value\``;
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

		const bulletLines: string[] = [];
		const renderAstBullets = (node: SearchAST, indent: string): void => {
			switch (node.type) {
				case 'MATCH_ALL':
					bulletLines.push(
						`${indent}- **Match All Notes (\`MATCH_ALL\`)**: Because the query is empty or whitespace-only, every Markdown note in the vault matches.`,
					);
					return;
				case 'LOGICAL': {
					const groupNote = node.parenthesized ? ', grouped in parentheses' : '';
					if (node.operator === 'AND') {
						bulletLines.push(
							`${indent}- **All of the following conditions must match (\`AND\`${groupNote})**:`,
						);
					} else {
						bulletLines.push(
							`${indent}- **At least one of the following conditions must match (\`OR\`${groupNote})**:`,
						);
					}
					for (const child of node.children) {
						renderAstBullets(child, `${indent}  `);
					}
					return;
				}
				case 'NOT':
					bulletLines.push(
						`${indent}- **Exclude notes where (\`${node.syntax}\`)**: The note must **not** match:`,
					);
					renderAstBullets(node.child, `${indent}  `);
					return;
				case 'TEXT_MATCH': {
					const authored = formatInlineCode(node.rawText);
					if (node.matcher.kind === 'regex') {
						const valid = !invalidRegexNodes.has(node);
						const prefix = valid ? '' : '❌ **Invalid Regex** — ';
						bulletLines.push(
							`${indent}- ${prefix}**Bare regular expression** ${formatRegexLink(node.matcher)}: Matches if the note's filename (\`file.basename\`), path (\`file.path\`), aliases, or tags match this pattern *(note body content is not searched)*.`,
						);
					} else {
						bulletLines.push(
							`${indent}- **Bare text search** ${authored}: Matches if the note's filename (\`file.basename\`), path (\`file.path\`), aliases, or tags contain ${formatInlineCode(node.matcher.value)} (case-insensitive; *note body content is not searched*).`,
						);
					}
					return;
				}
				case 'SCOPED_FILTER': {
					const authored = formatInlineCode(formatAuthoredFilter(node));
					if (unknownScopeNodes.has(node)) {
						const suggestion = suggestScopeHint(node.rawScope, effectiveConfig);
						bulletLines.push(
							`${indent}- ❌ **Unknown Scope Filter** ${authored}: Scope ${formatInlineCode(`${node.rawScope}:`)} is not a recognized search scope.${suggestion ? ` ${suggestion}` : ''}`,
						);
						return;
					}
					const sem = describeScopeSemantics(node.scope);
					const aliasParen =
						node.rawScope === '#'
							? ''
							: node.rawScope.trim().toLowerCase() !== node.scope.toLowerCase()
								? ` (${formatInlineCode(`${node.rawScope}:`)} is an alias for ${formatInlineCode(`${node.scope}:`)})`
								: '';
					const invalidPrefix = invalidRegexNodes.has(node) ? '❌ ' : '';

					if (node.expr.type === 'VALUE_LEAF') {
						const m = node.expr.matcher;
						const leafDesc =
							m.kind === 'regex'
								? `matches regular expression ${formatRegexLink(m)}`
								: sem.formatPlainStringMatch(m.value);
						bulletLines.push(
							`${indent}- ${invalidPrefix}**${sem.friendlyTitle}** ${authored}${aliasParen}: The note has at least one ${sem.singularTarget} that ${leafDesc}.`,
						);
					} else {
						bulletLines.push(
							`${indent}- ${invalidPrefix}**${sem.friendlyTitle}** ${authored}${aliasParen}: The note has **at least one ${sem.singularTarget}** where that single ${sem.singularTarget} matches:`,
						);
						renderValueExprBullets(
							node.expr,
							`${indent}  `,
							sem.singularTarget,
							(m) =>
								m.kind === 'regex'
									? `matches regular expression ${formatRegexLink(m)}`
									: sem.formatPlainStringMatch(m.value),
							bulletLines,
						);
					}
					return;
				}
				case 'PROPERTY_FILTER': {
					const authored = formatInlineCode(formatAuthoredFilter(node));
					const keyCode = formatInlineCode(node.key);
					const typeInfo = resolvePropertyTypeWithOrigin(
						node.key,
						effectiveConfig.propertyTypes,
					);
					const isInvalid = invalidPropertyNodes.has(node) || invalidRegexNodes.has(node);
					const prefix = isInvalid ? '❌ ' : '';
					const virtualDesc = describeVirtualFileKey(node.key);
					const friendlyType = formatFriendlyTypeNote(typeInfo);

					if (node.operator === 'EXISTS') {
						bulletLines.push(
							`${indent}- ${prefix}**Property exists** ${authored}: The note has a ${keyCode} property (${friendlyType}) with a non-empty, valid value.`,
						);
						return;
					}

					if (node.valueExpr && node.valueExpr.type === 'VALUE_LEAF') {
						const { plainEnglish } = describePropertyLeaf(
							node.valueExpr.matcher,
							typeInfo.type,
							node.operator,
							effectiveConfig.timeZone,
							effectiveRefTimeMs,
							validRefTime,
						);
						if (virtualDesc !== null) {
							bulletLines.push(
								`${indent}- ${prefix}**File metadata filter** ${authored}: ${capitalizeFirst(virtualDesc)} ${plainEnglish}.`,
							);
						} else {
							bulletLines.push(
								`${indent}- ${prefix}**Property filter** ${authored}: The note has a ${keyCode} property (${friendlyType}) whose value ${plainEnglish}.`,
							);
						}
						if (node.operator === '!=' && virtualDesc === null) {
							const neqSnippet = formatInlineCode(`[${node.key} != ...]`);
							const negEqSnippet = formatInlineCode(`-[${node.key} = ...]`);
							bulletLines.push(
								`${indent}  - *Tip: ${neqSnippet} only matches notes that have a ${keyCode} property. To also include notes without ${keyCode}, use ${negEqSnippet}.*`,
							);
						}
					} else if (node.valueExpr) {
						const subjectDesc =
							virtualDesc !== null
								? `${capitalizeFirst(virtualDesc)} satisfies:`
								: `The note has **at least one ${keyCode} property value** (${friendlyType}) where that single value satisfies:`;
						bulletLines.push(
							`${indent}- ${prefix}**Property filter** ${authored}: ${subjectDesc}`,
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
								).plainEnglish,
							bulletLines,
						);
					}
					return;
				}
			}
		};

		renderAstBullets(resolvedAst, '');
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
							? `scope ${escapeMarkdownTableCell(formatInlineCode(node.scope))} (alias ${escapeMarkdownTableCell(formatInlineCode(`${node.rawScope}:`))})`
							: `scope ${escapeMarkdownTableCell(formatInlineCode(node.scope))}`;
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
					details = `Operator \`${node.operator}\`: ${
						describePropertyLeaf(
							node.valueExpr.matcher,
							typeInfo.type,
							node.operator,
							effectiveConfig.timeZone,
							effectiveRefTimeMs,
							validRefTime,
						).reference
					}`;
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
