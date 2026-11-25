import { type ExplainConceptKey, formatInlineCode } from '@core/search';

interface InspectableFilterToken {
	readonly name?: string;
	readonly args?: ReadonlyArray<unknown>;
}

interface InspectableFilterEntry {
	readonly name?: string;
	readonly args?: readonly unknown[];
	readonly token?: InspectableFilterToken;
}

interface InspectableValueLike {
	readonly initial?: {
		readonly token?: { getText?: () => string };
		readonly postfix?: readonly { getText?: () => string }[];
		getText?: () => string;
	};
	readonly filters?: readonly InspectableFilterEntry[];
	getText?: () => string;
}

function safeUnknownToString(val: unknown): string {
	if (val === null || val === undefined) return '';
	if (typeof val === 'string') return val;
	if (typeof val === 'number' || typeof val === 'boolean') return String(val);
	return JSON.stringify(val);
}

function formatFilterArg(arg: unknown): string {
	if (Array.isArray(arg) && arg.length === 2) {
		const [k, v] = arg as [unknown, { getText?: () => string } | undefined];
		const vText =
			v && typeof v === 'object' && typeof v.getText === 'function'
				? v.getText()
				: safeUnknownToString(v);
		return `${safeUnknownToString(k)}: ${vText}`;
	}
	if (
		arg &&
		typeof arg === 'object' &&
		typeof (arg as { getText?: unknown }).getText === 'function'
	) {
		return (arg as { getText: () => string }).getText();
	}
	return safeUnknownToString(arg);
}

function scanInitialTextConcepts(rawInitial: string, concepts: Set<ExplainConceptKey>): void {
	const trimmed = rawInitial.trim();
	if (
		/\b(?:now|today)\b/.test(trimmed) ||
		/@(?:now|today|yesterday|tomorrow|thisweek|thismonth|thisyear)\b/.test(trimmed)
	) {
		concepts.add('temporal-intervals');
	}
	if (
		trimmed.includes('◊.') ||
		trimmed === '◊' ||
		/\b(?:targetPath|frontmatter|template)\b/.test(trimmed)
	) {
		concepts.add('template-modes-virtual-this');
	}
}

/**
 * Describes a single Liquid filter step in plain English and records any triggered `ExplainConceptKey`.
 */
export function describeLiquidFilterStep(
	name: string,
	rawArgs: readonly string[],
	concepts: Set<ExplainConceptKey>,
): string {
	const argsCode = rawArgs.length > 0 ? rawArgs.map((a) => formatInlineCode(a)).join(', ') : '';

	switch (name) {
		case 'pick':
			return argsCode ? `projects fields (${argsCode})` : 'projects selected fields (`pick`)';
		case 'prune':
			return argsCode ? `removes paths (${argsCode})` : 'removes paths (`prune`)';
		case 'merge':
			return argsCode ? `merges keys with ${argsCode}` : 'merges array of objects (`merge`)';
		case 'percentage':
		case 'percent':
			return argsCode
				? `computes percentage of ${argsCode} (\`0..100\` or \`nil\`)`
				: 'computes percentage (`percent`)';
		case 'aggregate':
		case 'agg':
			return argsCode ? `aggregates records (${argsCode})` : 'aggregates records (`agg`)';
		case 'sort':
			return argsCode
				? `sorts records by ${argsCode} (locale- and type-aware)`
				: 'sorts items (`sort`)';
		case 'sort_natural':
			return argsCode
				? `sorts records case-insensitively by ${argsCode}`
				: 'sorts items case-insensitively (`sort_natural`)';
		case 'group_by':
			return argsCode
				? `groups records by ${argsCode} into \`{ name, items, size }\` buckets`
				: 'groups records (`group_by`)';
		case 'where':
			return argsCode ? `keeps items matching ${argsCode}` : 'filters truthy items (`where`)';
		case 'reject':
			return argsCode
				? `excludes items matching ${argsCode}`
				: 'excludes truthy items (`reject`)';
		case 'find':
			return argsCode
				? `finds first item matching ${argsCode}`
				: 'finds first matching item (`find`)';
		case 'find_index':
			return argsCode
				? `finds 0-based index of first item matching ${argsCode}`
				: 'finds index of first match (`find_index`)';
		case 'has':
			return argsCode
				? `tests whether any item matches ${argsCode}`
				: 'tests item presence (`has`)';
		case 'map':
			return argsCode ? `extracts ${argsCode} from each item` : 'maps property (`map`)';
		case 'uniq':
			return argsCode ? `deduplicates items by ${argsCode}` : 'deduplicates items (`uniq`)';
		case 'sum':
			return argsCode ? `sums numeric ${argsCode} values` : 'sums numeric values (`sum`)';
		case 'table':
			return argsCode
				? `renders a Markdown table (${argsCode})`
				: 'renders a Markdown table (`table`)';
		case 'list':
			return argsCode
				? `renders a Markdown list (${argsCode})`
				: 'renders a Markdown list (`list`)';
		case 'heading':
			concepts.add('relative-headings');
			return argsCode
				? `renders relative Markdown heading(s) (${argsCode})`
				: 'renders relative Markdown heading(s) at the active heading level (`heading`)';
		case 'sentence':
		case 'array_to_sentence_string':
			return argsCode
				? `joins items into a natural-language sentence (connector ${argsCode})`
				: 'joins items into a natural-language sentence (`sentence`)';
		case 'link_paths':
			concepts.add('template-graph-joins');
			return argsCode
				? `extracts deduplicated link target paths (${argsCode})`
				: 'extracts deduplicated resolved link paths (`link_paths`)';
		case 'lookup':
			concepts.add('template-graph-joins');
			return argsCode
				? `joins paths against collection (${argsCode})`
				: 'joins paths against a note collection (`lookup`)';
		case 'tree':
			concepts.add('template-graph-joins');
			return argsCode
				? `builds cycle-safe hierarchy tree (${argsCode})`
				: 'builds cycle-safe hierarchy tree (`tree`)';
		case 'date':
			concepts.add('temporal-intervals');
			return argsCode
				? `formats temporal value with pattern ${argsCode}`
				: 'formats temporal value (`date`)';
		case 'date_to_xmlschema':
		case 'date_to_rfc822':
		case 'date_to_string':
		case 'date_to_long_string':
			concepts.add('temporal-intervals');
			return `formats temporal value (\`${name}\`)`;
		case 'size':
			return 'counts length (`size`)';
		case 'first':
			return 'takes first element (`first`)';
		case 'last':
			return 'takes last element (`last`)';
		case 'join':
			return argsCode ? `joins elements with ${argsCode}` : 'joins elements (`join`)';
		case 'split':
			return argsCode ? `splits string on ${argsCode}` : 'splits string (`split`)';
		case 'slice':
			return argsCode ? `slices range (${argsCode})` : 'slices value (`slice`)';
		case 'default':
			return argsCode
				? `falls back to ${argsCode} when empty/nil`
				: 'applies fallback (`default`)';
		case 'append':
			return argsCode ? `appends ${argsCode}` : 'appends text (`append`)';
		case 'prepend':
			return argsCode ? `prepends ${argsCode}` : 'prepends text (`prepend`)';
		case 'upcase':
			return 'converts to uppercase (`upcase`)';
		case 'downcase':
			return 'converts to lowercase (`downcase`)';
		case 'capitalize':
			return 'capitalizes first character (`capitalize`)';
		case 'strip':
			return 'trims outer whitespace (`strip`)';
		case 'replace':
			return argsCode ? `replaces ${argsCode}` : 'replaces substring (`replace`)';
		case 'plus':
			return argsCode ? `adds ${argsCode}` : 'adds number (`plus`)';
		case 'minus':
			return argsCode ? `subtracts ${argsCode}` : 'subtracts number (`minus`)';
		case 'times':
			return argsCode ? `multiplies by ${argsCode}` : 'multiplies (`times`)';
		case 'divided_by':
			return argsCode ? `divides by ${argsCode}` : 'divides (`divided_by`)';
		case 'round':
			return argsCode
				? `rounds to ${argsCode} decimal(s)`
				: 'rounds to nearest integer (`round`)';
		case 'json':
			return 'serializes to JSON (`json`)';
		default:
			return argsCode
				? `applies filter \`${name}\` (${argsCode})`
				: `applies filter \`${name}\``;
	}
}

function extractInitialSource(valueLike: InspectableValueLike): string {
	const init = valueLike.initial;
	if (!init) {
		return typeof valueLike.getText === 'function' ? valueLike.getText().trim() : '';
	}
	if (typeof init.getText === 'function') {
		return init.getText().trim();
	}
	if (init.token && typeof init.token.getText === 'function') {
		return init.token.getText().trim();
	}
	if (init.postfix && Array.isArray(init.postfix) && init.postfix.length > 0) {
		const postfixList = init.postfix as readonly { getText?: () => string }[];
		const texts = postfixList
			.map((t) => (t && typeof t.getText === 'function' ? t.getText() : ''))
			.filter((s) => s.length > 0);
		if (texts.length > 0) {
			return texts.join(' ');
		}
	}
	return '';
}

/**
 * Explains a LiquidJS `Value` or `ValueToken` pipeline as concise plain-English steps and
 * populates `concepts` with any Rhizome language features referenced in the pipeline.
 */
export function explainLiquidValue(
	valueObj: unknown,
	rawFallbackText: string,
	concepts: Set<ExplainConceptKey>,
): { readonly sourceCode: string; readonly summary: string } {
	if (!valueObj || typeof valueObj !== 'object') {
		const trimmed = rawFallbackText.trim();
		scanInitialTextConcepts(trimmed, concepts);
		return {
			sourceCode: formatInlineCode(trimmed),
			summary: `evaluates ${formatInlineCode(trimmed)}`,
		};
	}

	const v = valueObj as InspectableValueLike;
	if (typeof v.getText === 'function' && !('filters' in v)) {
		const txt = v.getText().trim() || rawFallbackText.trim();
		scanInitialTextConcepts(txt, concepts);
		return {
			sourceCode: formatInlineCode(txt),
			summary: `evaluates ${formatInlineCode(txt)}`,
		};
	}

	const initialText = extractInitialSource(v) || rawFallbackText.split('|')[0]?.trim() || '';
	scanInitialTextConcepts(initialText, concepts);

	const filters: readonly InspectableFilterEntry[] = Array.isArray(v.filters)
		? (v.filters as readonly InspectableFilterEntry[])
		: [];
	const filterSteps: string[] = [];
	const reconstructedFilterParts: string[] = [];

	for (const f of filters) {
		const fName = f.name ?? f.token?.name ?? '';
		if (!fName) continue;
		const rawArgsList = Array.isArray(f.args)
			? (f.args as readonly unknown[]).map(formatFilterArg)
			: Array.isArray(f.token?.args)
				? (f.token.args as readonly unknown[]).map(formatFilterArg)
				: [];
		filterSteps.push(describeLiquidFilterStep(fName, rawArgsList, concepts));
		reconstructedFilterParts.push(
			rawArgsList.length > 0 ? `${fName}: ${rawArgsList.join(', ')}` : fName,
		);
	}

	const fullExpr =
		rawFallbackText.trim().length > 0
			? rawFallbackText.trim()
			: reconstructedFilterParts.length > 0
				? `${initialText} | ${reconstructedFilterParts.join(' | ')}`
				: initialText;

	const initDisplay = initialText.length > 0 ? formatInlineCode(initialText) : 'input';
	const summary =
		filterSteps.length === 0
			? `reads ${initDisplay}`
			: `reads ${initDisplay} → ${filterSteps.join(' → ')}`;

	return {
		sourceCode: formatInlineCode(fullExpr),
		summary,
	};
}
