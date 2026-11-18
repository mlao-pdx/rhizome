import {
	initEngineConfig,
	normalizeObsidianMetadata,
	type NormalizedDocument,
	type ResolvedEngineConfig,
} from '../../src/core/search';

export interface DocFileSpec {
	path?: string;
	ctime?: number;
	mtime?: number;
	size?: number;
}

export function makeConfig(
	propertyTypes: Record<
		string,
		'text' | 'number' | 'date' | 'datetime' | 'checkbox' | 'multitext'
	> = {},
): ResolvedEngineConfig {
	const result = initEngineConfig({ timeZone: 'UTC', propertyTypes });
	if (!result.ok) {
		throw new Error('fixture config failed');
	}
	return result.config;
}

export function makeDoc(
	options: {
		file?: DocFileSpec;
		frontmatter?: Record<string, unknown>;
		links?: Array<{ link: string; displayText?: string }>;
		embeds?: Array<{ link: string; displayText?: string }>;
		tags?: string[];
		config?: ResolvedEngineConfig;
		resolve?: (raw: string, source: string) => string | null;
	} = {},
): NormalizedDocument {
	const path = options.file?.path ?? 'notes/alpha.md';
	const slashIdx = path.lastIndexOf('/');
	const name = slashIdx === -1 ? path : path.slice(slashIdx + 1);
	const dotIdx = name.lastIndexOf('.');
	const basename = dotIdx === -1 ? name : name.slice(0, dotIdx);
	const extension = dotIdx === -1 ? '' : name.slice(dotIdx + 1);
	const cache = {
		frontmatter: options.frontmatter,
		tags: (options.tags ?? []).map((tag) => ({ tag, position: {} as never })),
		links: (options.links ?? []).map((link) => ({
			link: link.link,
			displayText: link.displayText,
			original: `[[${link.link}]]`,
			position: {} as never,
		})),
		embeds: (options.embeds ?? []).map((embed) => ({
			link: embed.link,
			displayText: embed.displayText,
			original: `![[${embed.link}]]`,
			position: {} as never,
		})),
	};
	return normalizeObsidianMetadata(
		{
			path,
			name,
			basename,
			extension,
			parent: { path: slashIdx === -1 ? '' : path.slice(0, slashIdx) },
			stat: {
				ctime: options.file?.ctime ?? 1_700_000_000_000,
				mtime: options.file?.mtime ?? 1_700_000_000_000,
				size: options.file?.size ?? 100,
			},
		},
		cache,
		options.config ?? makeConfig(),
		[],
		options.resolve ?? ((raw) => (raw === 'Missing' ? null : `Targets/${raw}.md`)),
	);
}
