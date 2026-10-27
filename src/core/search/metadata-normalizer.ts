import {
	buildPropertiesViews,
	coercePropertyValue,
	FORBIDDEN_KEYS,
	resolveUserPropertyType,
	sanitizeLineNumber,
	sanitizeScalar,
} from './property-coercion';
import { stripTagHash } from './scopes';
import { MAX_SAFE_EPOCH_MS } from './temporal';
import type {
	DocumentDiagnostic,
	DocumentDiagnosticCode,
	NormalizedDocument,
	NormalizedHeading,
	NormalizedLink,
	NormalizedTagLocation,
	PropertyOccurrence,
	ResolvedEngineConfig,
	SanitizedScalar,
	TypedPropertyValue,
} from './types';

export interface ObsidianLocInput {
	readonly line: number;
	readonly col: number;
	readonly offset: number;
}

export interface ObsidianPosInput {
	readonly start: ObsidianLocInput;
	readonly end: ObsidianLocInput;
}

export interface ObsidianFileInput {
	readonly path: string;
	readonly name: string;
	readonly basename: string;
	readonly extension: string;
	readonly parent?: { readonly path: string } | null | undefined;
	readonly stat: {
		readonly ctime: number;
		readonly mtime: number;
		readonly size: number;
	};
}

export interface ObsidianLinkCacheInput {
	readonly link: string;
	readonly displayText?: string | undefined;
	readonly position?: ObsidianPosInput | undefined;
}

export interface ObsidianMetadataCacheInput {
	readonly frontmatter?: Readonly<Record<string, unknown>> | undefined;
	readonly tags?:
		| ReadonlyArray<{
				readonly tag: string;
				readonly position?: ObsidianPosInput | undefined;
		  }>
		| undefined;
	readonly headings?:
		| ReadonlyArray<{
				readonly heading: string;
				readonly level: number;
				readonly position?: ObsidianPosInput | undefined;
		  }>
		| undefined;
	readonly links?: readonly ObsidianLinkCacheInput[] | undefined;
	readonly frontmatterLinks?: readonly ObsidianLinkCacheInput[] | undefined;
	readonly embeds?: readonly ObsidianLinkCacheInput[] | undefined;
	readonly blocks?:
		| Readonly<
				Record<
					string,
					{
						readonly id: string;
						readonly position?: ObsidianPosInput | undefined;
					}
				>
		  >
		| undefined;
}

export interface InlinePropertyInput {
	readonly key: string;
	readonly value: unknown;
	readonly line?: number | null | undefined;
	readonly position?: ObsidianPosInput | null | undefined;
}

export type ResolveLinkPathFn = (rawTarget: string, sourcePath: string) => string | null;

const WIKILINK_UNSAFE_RE = /[[\]#^|\r\n]/;

function isValidOffset(val: unknown): val is number {
	return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0;
}

/**
 * Resolves the narrowest valid Obsidian wikilink pointing to where an item starts
 * in the source note (block ID, active heading, or note-level fallback).
 */
export function resolveOriginWikiLink(
	filePath: string,
	fileBasename: string,
	itemPos: ObsidianPosInput | null | undefined,
	blocks: ObsidianMetadataCacheInput['blocks'],
	headings: ObsidianMetadataCacheInput['headings'],
): string {
	const noteOrigin = `[[${filePath}|${fileBasename}]]`;
	const itemStartOffset = itemPos?.start?.offset;
	if (!isValidOffset(itemStartOffset)) {
		return noteOrigin;
	}

	if (blocks) {
		let bestBlockId: string | null = null;
		let bestSpan = Number.POSITIVE_INFINITY;
		let bestStart = -1;

		for (const b of Object.values(blocks)) {
			const cleanedId = b.id.startsWith('^') ? b.id.slice(1) : b.id;
			if (cleanedId.length === 0 || WIKILINK_UNSAFE_RE.test(cleanedId)) {
				continue;
			}
			const bStart = b.position?.start?.offset;
			const bEnd = b.position?.end?.offset;
			if (!isValidOffset(bStart) || !isValidOffset(bEnd) || bStart > bEnd) {
				continue;
			}
			if (bStart <= itemStartOffset && itemStartOffset <= bEnd) {
				const span = bEnd - bStart;
				if (span < bestSpan || (span === bestSpan && bStart > bestStart)) {
					bestSpan = span;
					bestStart = bStart;
					bestBlockId = cleanedId;
				}
			}
		}

		if (bestBlockId !== null) {
			return `[[${filePath}#^${bestBlockId}|${fileBasename}]]`;
		}
	}

	if (headings) {
		let activeHeadingText: string | null = null;
		let bestHeadingStart = -1;

		for (const h of headings) {
			const hStart = h.position?.start?.offset;
			if (!isValidOffset(hStart)) {
				continue;
			}
			if (hStart <= itemStartOffset && hStart >= bestHeadingStart) {
				bestHeadingStart = hStart;
				activeHeadingText = h.heading;
			}
		}

		if (
			activeHeadingText !== null &&
			activeHeadingText.trim().length > 0 &&
			!WIKILINK_UNSAFE_RE.test(activeHeadingText)
		) {
			return `[[${filePath}#${activeHeadingText}|${fileBasename}]]`;
		}
	}

	return noteOrigin;
}

function validateIntegerTimestampMs(val: number, fieldName: string): number {
	if (!Number.isSafeInteger(val) || Math.abs(val) > MAX_SAFE_EPOCH_MS) {
		throw new Error(`Invalid file stat ${fieldName}: ${val}`);
	}
	return val === 0 ? 0 : val;
}

function normalizeLinkItem(
	l: ObsidianLinkCacheInput,
	source: 'body' | 'frontmatter' | 'embed',
	sourcePath: string,
	origin: string,
	resolveLinkPath: ResolveLinkPathFn | undefined,
): NormalizedLink {
	const raw = l.link;
	let rawTarget = raw;
	let subpath = '';
	const hashIdx = raw.indexOf('#');
	const blockIdx = raw.indexOf('^');
	const splitIdx =
		hashIdx !== -1 && blockIdx !== -1
			? Math.min(hashIdx, blockIdx)
			: hashIdx !== -1
				? hashIdx
				: blockIdx;

	if (splitIdx === 0) {
		rawTarget = sourcePath;
		subpath = raw;
	} else if (splitIdx > 0) {
		rawTarget = raw.slice(0, splitIdx);
		subpath = raw.slice(splitIdx);
	}

	const resolvedPath =
		splitIdx === 0
			? sourcePath
			: resolveLinkPath
				? resolveLinkPath(rawTarget, sourcePath)
				: null;

	return {
		link: raw,
		rawTarget,
		resolvedPath,
		subpath,
		displayText: l.displayText ?? raw,
		source,
		origin,
	};
}

/**
 * Normalizes an Obsidian `TFile`, `CachedMetadata`, and inline properties
 * into a self-contained plain POJO `NormalizedDocument` bound to `resolvedConfig`.
 * Does not ingest `resolvedLinks` or compute backlinks.
 */
export function normalizeObsidianMetadata(
	tfile: ObsidianFileInput,
	cache: ObsidianMetadataCacheInput | null,
	resolvedConfig: ResolvedEngineConfig,
	inlineProperties: readonly InlinePropertyInput[] = [],
	resolveLinkPath?: ResolveLinkPathFn,
): NormalizedDocument {
	const ctime = validateIntegerTimestampMs(tfile.stat.ctime, 'ctime');
	const mtime = validateIntegerTimestampMs(tfile.stat.mtime, 'mtime');
	if (!Number.isSafeInteger(tfile.stat.size) || tfile.stat.size < 0) {
		throw new Error(`Invalid file stat size: ${tfile.stat.size}`);
	}

	const { timeZone, propertyTypes, normalizationFingerprint } = resolvedConfig;
	const propertyOccurrences: PropertyOccurrence[] = [];
	const occurrencePositions: Array<ObsidianPosInput | null | undefined> = [];
	const diagnostics: DocumentDiagnostic[] = [];
	const noteOrigin = `[[${tfile.path}|${tfile.basename}]]`;

	const recordDocDiagnosticIfInvalid = (
		tv: TypedPropertyValue,
		key: string,
		rawKey: string,
		source: 'frontmatter' | 'inline',
		line: number | null,
		occurrenceIndex: number,
		valueIndex: number,
	): void => {
		if (tv.kind !== 'invalid') return;
		const code: DocumentDiagnosticCode =
			tv.reason === 'REVERSED_DATE_RANGE'
				? 'DOC_REVERSED_DATE_RANGE'
				: tv.reason === 'SKIPPED_DATE'
					? 'DOC_SKIPPED_DATE'
					: 'DOC_INVALID_PROPERTY_VALUE';

		diagnostics.push({
			code,
			filePath: tfile.path,
			fileBasename: tfile.basename,
			propertyKey: key,
			rawKey,
			rawValue: tv.raw,
			expectedType: tv.expectedType,
			source,
			line,
			occurrenceIndex,
			valueIndex,
			issue:
				code === 'DOC_REVERSED_DATE_RANGE'
					? `The left endpoint starts on or after the exclusive end contributed by the right endpoint in "${tv.raw}".`
					: code === 'DOC_SKIPPED_DATE'
						? `Date "${tv.raw}" does not exist in timezone "${timeZone}".`
						: `Value "${tv.raw}" is not a valid ${tv.expectedType}.`,
			hint: tv.hint,
		});
	};

	const addOccurrence = (
		rawKey: string,
		val: unknown,
		source: 'frontmatter' | 'inline',
		rawLine?: number | null,
		rawPosition?: ObsidianPosInput | null,
	): void => {
		if (source === 'frontmatter' && rawKey === 'position') return;
		const key = rawKey.trim().toLowerCase();
		if (!key || FORBIDDEN_KEYS.has(key) || FORBIDDEN_KEYS.has(rawKey)) return;

		const line = sanitizeLineNumber(rawLine);
		const propertyType = resolveUserPropertyType(key, propertyTypes);
		const occurrenceIndex = propertyOccurrences.length;

		if (Array.isArray(val)) {
			const sanitizedList: SanitizedScalar[] = [];
			const typedValues: TypedPropertyValue[] = [];
			for (const item of val as readonly unknown[]) {
				const s = sanitizeScalar(item);
				if (!s.valid) continue;
				let scalar = s.scalar;
				let itemForCoerce: unknown = item;
				if (propertyType === 'tags' && typeof scalar === 'string') {
					const stripped = stripTagHash(scalar);
					if (!stripped) continue;
					scalar = stripped;
					itemForCoerce = stripped;
				}
				sanitizedList.push(scalar);
				const valueIndex = typedValues.length;
				const tv = coercePropertyValue(itemForCoerce, propertyType, timeZone);
				typedValues.push(tv);
				recordDocDiagnosticIfInvalid(
					tv,
					key,
					rawKey,
					source,
					line,
					occurrenceIndex,
					valueIndex,
				);
			}
			propertyOccurrences.push({
				key,
				rawKey,
				source,
				line,
				propertyType,
				rawValue: sanitizedList,
				typedValues,
			});
			occurrencePositions.push(rawPosition);
		} else {
			const s = sanitizeScalar(val);
			if (!s.valid) return;
			let scalar = s.scalar;
			let valForCoerce: unknown = val;
			if (propertyType === 'tags' && typeof scalar === 'string') {
				const stripped = stripTagHash(scalar);
				if (!stripped) return;
				scalar = stripped;
				valForCoerce = stripped;
			}
			const tv = coercePropertyValue(valForCoerce, propertyType, timeZone);
			recordDocDiagnosticIfInvalid(tv, key, rawKey, source, line, occurrenceIndex, 0);
			propertyOccurrences.push({
				key,
				rawKey,
				source,
				line,
				propertyType,
				rawValue: scalar,
				typedValues: [tv],
			});
			occurrencePositions.push(rawPosition);
		}
	};

	for (const [k, v] of Object.entries(cache?.frontmatter ?? {})) {
		addOccurrence(k, v, 'frontmatter', null, null);
	}
	for (const inline of inlineProperties) {
		addOccurrence(inline.key, inline.value, 'inline', inline.line, inline.position);
	}

	const { propertyKeys, properties } = buildPropertiesViews(propertyOccurrences);

	const aliases: string[] = [];
	for (const occ of propertyOccurrences) {
		if (occ.key === 'aliases' || occ.key === 'alias') {
			for (const tv of occ.typedValues) {
				if (tv.kind === 'text') aliases.push(tv.value);
			}
		}
	}

	const tags: string[] = [];
	const tagLocations: NormalizedTagLocation[] = [];
	for (let i = 0; i < propertyOccurrences.length; i++) {
		const occ = propertyOccurrences[i]!;
		if (occ.key === 'tags' || occ.key === 'tag') {
			const occOrigin =
				occ.source === 'frontmatter'
					? noteOrigin
					: resolveOriginWikiLink(
							tfile.path,
							tfile.basename,
							occurrencePositions[i],
							cache?.blocks,
							cache?.headings,
						);
			for (const tv of occ.typedValues) {
				if (tv.kind === 'text') {
					const stripped = stripTagHash(tv.value);
					if (stripped) {
						tags.push(stripped);
						tagLocations.push({
							tag: stripped,
							source: occ.source,
							origin: occOrigin,
						});
					}
				}
			}
		}
	}
	for (const t of cache?.tags ?? []) {
		const stripped = stripTagHash(t.tag);
		if (stripped) {
			tags.push(stripped);
			tagLocations.push({
				tag: stripped,
				source: 'body',
				origin: resolveOriginWikiLink(
					tfile.path,
					tfile.basename,
					t.position,
					cache?.blocks,
					cache?.headings,
				),
			});
		}
	}

	const headings: NormalizedHeading[] = (cache?.headings ?? []).map((h) => ({
		text: h.heading,
		level: (Number.isFinite(h.level) ? Math.min(6, Math.max(1, Math.trunc(h.level))) : 1) as
			1 | 2 | 3 | 4 | 5 | 6,
	}));

	const links: NormalizedLink[] = [
		...(cache?.frontmatterLinks ?? []).map((l) =>
			normalizeLinkItem(l, 'frontmatter', tfile.path, noteOrigin, resolveLinkPath),
		),
		...(cache?.links ?? []).map((l) =>
			normalizeLinkItem(
				l,
				'body',
				tfile.path,
				resolveOriginWikiLink(
					tfile.path,
					tfile.basename,
					l.position,
					cache?.blocks,
					cache?.headings,
				),
				resolveLinkPath,
			),
		),
	];

	const embeds: NormalizedLink[] = (cache?.embeds ?? []).map((e) =>
		normalizeLinkItem(
			e,
			'embed',
			tfile.path,
			resolveOriginWikiLink(
				tfile.path,
				tfile.basename,
				e.position,
				cache?.blocks,
				cache?.headings,
			),
			resolveLinkPath,
		),
	);

	const blocks = Object.values(cache?.blocks ?? {})
		.map((b) => (b.id.startsWith('^') ? b.id.slice(1) : b.id))
		.filter((id) => id.length > 0);

	const size = tfile.stat.size === 0 ? 0 : tfile.stat.size;

	return {
		normalizationFingerprint,
		file: {
			path: tfile.path,
			name: tfile.name,
			basename: tfile.basename,
			extension: tfile.extension,
			parent: tfile.parent?.path && tfile.parent.path !== '/' ? tfile.parent.path : '',
			created: ctime,
			modified: mtime,
			size,
		},
		aliases,
		tags,
		tagLocations,
		headings,
		links,
		embeds,
		blocks,
		propertyOccurrences,
		propertyKeys,
		properties,
		diagnostics,
	};
}
