import type { NormalizedDocument, ScopeDefinition } from './types';

export function substringStringMatch(target: string, queryValue: string): boolean {
	return target.toLowerCase().includes(queryValue.toLowerCase());
}

/**
 * The 9 built-in per-note metadata scopes (`file`, `path`, `ext`, `tag`, `aliases`,
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
			matchString: (target: string, queryValue: string) => {
				const q = queryValue.toLowerCase();
				const normQ = q.startsWith('#') ? q : `#${q}`;
				const t = target.toLowerCase();
				return t === normQ || t.startsWith(`${normQ}/`);
			},
		},
		{
			canonicalName: 'aliases',
			aliases: Object.freeze(['aliases', 'alias']),
			extract: (doc: NormalizedDocument) => doc.aliases,
			matchString: substringStringMatch,
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
			extract: (doc: NormalizedDocument) => doc.blocks,
			matchString: (target: string, queryValue: string) => {
				const q = queryValue.toLowerCase();
				const normQ = q.startsWith('^') ? q.slice(1) : q;
				return target.toLowerCase() === normQ;
			},
		},
	].map((s) => Object.freeze(s)),
);
