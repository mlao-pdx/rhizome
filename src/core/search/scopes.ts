import type { NormalizedDocument, ScopeDefinition, ScopeOperator } from './types';

export function substringStringMatch(target: string, queryValue: string): boolean {
	return target.toLowerCase().includes(queryValue.toLowerCase());
}

export function stripTagHash(raw: string): string {
	return raw.trim().replace(/^#+/, '').trim();
}

export function normalizeTagBody(raw: string): string {
	return stripTagHash(raw).toLowerCase();
}

export function hierarchicalTagMatch(target: string, queryValue: string): boolean {
	const t = normalizeTagBody(target);
	const q = normalizeTagBody(queryValue);
	if (!t || !q) return false;
	return t === q || t.startsWith(`${q}/`);
}

/**
 * The 10 built-in per-note metadata scopes (`file`, `path`, `ext`, `tag`, `aliases`, `cssclasses`,
 * `headings`, `links`, `embeds`, `blocks`). Backlinks and `resolvedLinks` are not supported.
 */
export const BUILT_IN_SCOPES: readonly ScopeDefinition[] = Object.freeze(
	[
		{
			canonicalName: 'file',
			aliases: Object.freeze(['file', 'filename']),
			extract: (doc: NormalizedDocument) => [doc.file.name, doc.file.basename],
			matchString: substringStringMatch,
		},
		{
			canonicalName: 'path',
			aliases: Object.freeze(['path', 'folder']),
			extract: (doc: NormalizedDocument) => [doc.file.path],
			matchString: substringStringMatch,
		},
		{
			canonicalName: 'ext',
			aliases: Object.freeze(['ext', 'extension']),
			extract: (doc: NormalizedDocument) => [doc.file.extension],
			matchString: (target: string, queryValue: string) => {
				const q = queryValue.toLowerCase();
				const normQ = q.startsWith('.') ? q.slice(1) : q;
				return target.toLowerCase() === normQ;
			},
		},
		{
			canonicalName: 'tag',
			aliases: Object.freeze(['tag']),
			extract: (doc: NormalizedDocument) => doc.tags,
			matchString: hierarchicalTagMatch,
		},
		{
			canonicalName: 'aliases',
			aliases: Object.freeze(['aliases', 'alias']),
			extract: (doc: NormalizedDocument) => doc.aliases,
			matchString: substringStringMatch,
		},
		{
			canonicalName: 'cssclasses',
			aliases: Object.freeze(['cssclasses', 'cssclass']),
			extract: (doc: NormalizedDocument) => doc.cssclasses,
			matchString: (target: string, queryValue: string) =>
				target.toLowerCase() === queryValue.toLowerCase(),
		},
		{
			canonicalName: 'headings',
			aliases: Object.freeze(['headings', 'heading', 'header', 'headers']),
			extract: (doc: NormalizedDocument) => doc.headings.map((h) => h.text),
			matchString: substringStringMatch,
		},
		{
			canonicalName: 'links',
			aliases: Object.freeze(['links', 'link', 'outlink', 'outlinks']),
			extract: (doc: NormalizedDocument) =>
				doc.links.flatMap((l) =>
					l.resolvedPath
						? [l.link, l.rawTarget, l.resolvedPath, l.displayText]
						: [l.link, l.rawTarget, l.displayText],
				),
			matchString: substringStringMatch,
		},
		{
			canonicalName: 'embeds',
			aliases: Object.freeze(['embeds', 'embed']),
			extract: (doc: NormalizedDocument) =>
				doc.embeds.flatMap((e) =>
					e.resolvedPath ? [e.link, e.rawTarget, e.resolvedPath] : [e.link, e.rawTarget],
				),
			matchString: substringStringMatch,
		},
		{
			canonicalName: 'blocks',
			aliases: Object.freeze(['blocks', 'block']),
			extract: (doc: NormalizedDocument) => doc.blocks.map((b) => b.id),
			matchString: (target: string, queryValue: string) => {
				const q = queryValue.toLowerCase();
				const normQ = q.startsWith('^') ? q.slice(1) : q;
				return target.toLowerCase() === normQ;
			},
		},
	].map((s) => Object.freeze(s)),
);

export function normalizeScopeComparisonOperand(canonicalScope: string, raw: string): string {
	const scope = canonicalScope.trim().toLowerCase();
	if (scope === 'tag') {
		return normalizeTagBody(raw);
	}
	if (scope === 'ext') {
		return raw.replace(/^\./, '').toLowerCase();
	}
	if (scope === 'blocks') {
		return raw.replace(/^\^/, '').toLowerCase();
	}
	return raw.toLowerCase();
}

export function normalizeScopeComparisonOperands(
	canonicalScope: string,
	rawValues: readonly string[],
): readonly string[] {
	const isTag = canonicalScope.trim().toLowerCase() === 'tag';
	const normalized: string[] = [];
	for (const raw of rawValues) {
		const value = normalizeScopeComparisonOperand(canonicalScope, raw);
		if (!isTag || value.length > 0) {
			normalized.push(value);
		}
	}
	return normalized;
}

export function scopeTargetsMatchComparison(
	canonicalScope: string,
	targets: readonly string[],
	operator: Exclude<ScopeOperator, ':'>,
	normalizedRhsValues: readonly string[],
): boolean {
	if (normalizedRhsValues.length === 0 || targets.length === 0) return false;
	const isTag = canonicalScope.trim().toLowerCase() === 'tag';
	for (const target of targets) {
		const a = normalizeScopeComparisonOperand(canonicalScope, target);
		if (isTag && a.length === 0) continue;
		for (const b of normalizedRhsValues) {
			switch (operator) {
				case '=':
					if (a === b) return true;
					break;
				case '!=':
					if (a !== b) return true;
					break;
				case '<':
					if (a < b) return true;
					break;
				case '>':
					if (a > b) return true;
					break;
				case '<=':
					if (a <= b) return true;
					break;
				case '>=':
					if (a >= b) return true;
					break;
			}
		}
	}
	return false;
}
