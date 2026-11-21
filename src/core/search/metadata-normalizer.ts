import type { ExtractedTaskInput } from '../scanner/task-extractor';
import {
	buildPropertiesViews,
	coercePropertyValue,
	FORBIDDEN_KEYS,
	isVacuousOccurrence,
	OMITTED_PROPERTY_VIEW_KEYS,
	resolveUserPropertyType,
	sanitizeLineNumber,
	sanitizeScalar,
} from './property-coercion';
import { stripTagHash } from './scopes';
import { formatEpochMsToMinuteIso, MAX_SAFE_EPOCH_MS } from './temporal';
import {
	getSystemScopeForPropertyKey,
	type DocumentDiagnostic,
	type DocumentDiagnosticCode,
	type NormalizedAliasLocation,
	type NormalizedBlock,
	type NormalizedDocument,
	type NormalizedFileInfo,
	type NormalizedHeading,
	type NormalizedLink,
	type NormalizedPropertyLocation,
	type NormalizedTagLocation,
	type NormalizedTask,
	type PropertyOccurrence,
	type PropertySource,
	type ResolvedEngineConfig,
	type SanitizedScalar,
	type TypedPropertyValue,
} from './types';

export type { ExtractedTaskInput };

const internalFileEpochMsMap = new WeakMap<
	NormalizedFileInfo,
	{ readonly ctime: number; readonly mtime: number }
>();

/**
 * Returns the internal UTC epoch-millisecond `{ ctime, mtime }` recorded when `file`
 * was normalized by `normalizeObsidianMetadata`, if available.
 */
export function getInternalFileEpochMs(
	file: NormalizedFileInfo,
): { readonly ctime: number; readonly mtime: number } | undefined {
	return internalFileEpochMsMap.get(file);
}

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
	readonly key?: string | undefined;
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
	readonly source?: 'dataview' | 'rhizome' | undefined;
	readonly line?: number | null | undefined;
	readonly position?: ObsidianPosInput | null | undefined;
}

export type ResolveLinkPathFn = (rawTarget: string, sourcePath: string) => string | null;

const WIKILINK_UNSAFE_RE = /[[\]#^|\r\n]/;

function isValidOffset(val: unknown): val is number {
	return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0;
}

interface PrecomputedBlockOrigin {
	readonly startOffset: number;
	readonly endOffset: number;
	readonly span: number;
	readonly orderIndex: number;
	readonly origin: string;
}

interface PrecomputedHeadingOrigin {
	readonly startOffset: number;
	readonly orderIndex: number;
	readonly origin: string;
}

export interface OriginWikiLinkResolver {
	readonly noteOrigin: string;
	resolve(itemPos: ObsidianPosInput | null | undefined): string;
	forHeading(headingText: string): string;
	forBlock(cleanedBlockId: string): string;
}

/**
 * Precomputes a per-note lookup table of origin wikilinks for blocks, headings,
 * and the note-level fallback so each unique origin string is allocated once
 * and resolved without re-validating or re-testing regexes per item.
 */
export function createOriginWikiLinkResolver(
	filePath: string,
	fileBasename: string,
	blocks: ObsidianMetadataCacheInput['blocks'],
	headings: ObsidianMetadataCacheInput['headings'],
): OriginWikiLinkResolver {
	const noteOrigin = `[[${filePath}|${fileBasename}]]`;
	const blockEntries: PrecomputedBlockOrigin[] = [];
	const blockOriginCache = new Map<string, string>();
	const headingOriginCache = new Map<string, string>();

	const forBlock = (cleanedId: string): string => {
		if (cleanedId.trim().length === 0 || WIKILINK_UNSAFE_RE.test(cleanedId)) {
			return noteOrigin;
		}
		let origin = blockOriginCache.get(cleanedId);
		if (origin === undefined) {
			origin = `[[${filePath}#^${cleanedId}|${fileBasename}]]`;
			blockOriginCache.set(cleanedId, origin);
		}
		return origin;
	};

	const forHeading = (headingText: string): string => {
		if (headingText.trim().length === 0 || WIKILINK_UNSAFE_RE.test(headingText)) {
			return noteOrigin;
		}
		let origin = headingOriginCache.get(headingText);
		if (origin === undefined) {
			origin = `[[${filePath}#${headingText}|${fileBasename}]]`;
			headingOriginCache.set(headingText, origin);
		}
		return origin;
	};

	if (blocks) {
		let orderIndex = 0;
		for (const b of Object.values(blocks)) {
			const currentOrder = orderIndex++;
			const cleanedId = b.id.replace(/^\^+/, '');
			if (cleanedId.trim().length === 0 || WIKILINK_UNSAFE_RE.test(cleanedId)) {
				continue;
			}
			const bStart = b.position?.start?.offset;
			const bEnd = b.position?.end?.offset;
			if (!isValidOffset(bStart) || !isValidOffset(bEnd) || bStart > bEnd) {
				continue;
			}
			const origin = forBlock(cleanedId);
			blockEntries.push({
				startOffset: bStart,
				endOffset: bEnd,
				span: bEnd - bStart,
				orderIndex: currentOrder,
				origin,
			});
		}
		blockEntries.sort(
			(a, b) =>
				a.span - b.span || b.startOffset - a.startOffset || a.orderIndex - b.orderIndex,
		);
	}

	const headingEntries: PrecomputedHeadingOrigin[] = [];
	if (headings) {
		for (let i = 0; i < headings.length; i++) {
			const h = headings[i]!;
			const hStart = h.position?.start?.offset;
			if (!isValidOffset(hStart)) {
				continue;
			}
			const origin = forHeading(h.heading);
			headingEntries.push({
				startOffset: hStart,
				orderIndex: i,
				origin,
			});
		}
		headingEntries.sort((a, b) => b.startOffset - a.startOffset || b.orderIndex - a.orderIndex);
	}

	return {
		noteOrigin,
		forHeading,
		forBlock,
		resolve(itemPos: ObsidianPosInput | null | undefined): string {
			const itemStartOffset = itemPos?.start?.offset;
			if (!isValidOffset(itemStartOffset)) {
				return noteOrigin;
			}

			for (let i = 0; i < blockEntries.length; i++) {
				const entry = blockEntries[i]!;
				if (entry.startOffset <= itemStartOffset && itemStartOffset <= entry.endOffset) {
					return entry.origin;
				}
			}

			for (let i = 0; i < headingEntries.length; i++) {
				const entry = headingEntries[i]!;
				if (entry.startOffset <= itemStartOffset) {
					return entry.origin;
				}
			}

			return noteOrigin;
		},
	};
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
	return createOriginWikiLinkResolver(filePath, fileBasename, blocks, headings).resolve(itemPos);
}

function validateIntegerTimestampMs(val: number, fieldName: string): number {
	if (!Number.isSafeInteger(val) || Math.abs(val) > MAX_SAFE_EPOCH_MS) {
		throw new Error(`Invalid file stat ${fieldName}: ${val}`);
	}
	return val === 0 ? 0 : val;
}

const INLINE_WIKILINK_RE = /\[\[([^[\]\r\n]+)\]\]/g;

function sanitizeLinkPropertyKey(rawKey: string): string | null {
	const trimmed = rawKey.trim();
	const lower = trimmed.toLowerCase();
	if (
		trimmed.length === 0 ||
		FORBIDDEN_KEYS.has(trimmed) ||
		FORBIDDEN_KEYS.has(lower) ||
		FORBIDDEN_KEYS.has(rawKey) ||
		OMITTED_PROPERTY_VIEW_KEYS.has(lower)
	) {
		return null;
	}
	return trimmed;
}

function resolveFrontmatterLinkProperty(
	rawKey: string | undefined,
	frontmatter: Readonly<Record<string, unknown>> | undefined,
): string | null {
	if (typeof rawKey !== 'string') {
		return null;
	}
	if (
		frontmatter &&
		typeof frontmatter === 'object' &&
		Object.prototype.hasOwnProperty.call(frontmatter, rawKey)
	) {
		return sanitizeLinkPropertyKey(rawKey);
	}
	return sanitizeLinkPropertyKey(rawKey.replace(/(?:\.\d+)+$/, ''));
}

function extractWikilinksFromValue(val: unknown): ObsidianLinkCacheInput[] {
	const texts: string[] = [];
	if (typeof val === 'string') {
		if (val.includes('[[')) {
			texts.push(val);
		}
	} else if (Array.isArray(val)) {
		for (const item of val as readonly unknown[]) {
			if (typeof item === 'string' && item.includes('[[')) {
				texts.push(item);
			}
		}
	}
	if (texts.length === 0) {
		return [];
	}

	const out: ObsidianLinkCacheInput[] = [];
	for (const str of texts) {
		INLINE_WIKILINK_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = INLINE_WIKILINK_RE.exec(str)) !== null) {
			if (match.index > 0 && str[match.index - 1] === '!') {
				continue;
			}
			const inner = match[1]!;
			const pipeIdx = inner.indexOf('|');
			if (pipeIdx === -1) {
				const link = inner.trim();
				if (link.length > 0) {
					out.push({ link });
				}
			} else {
				const rawLink = inner.slice(0, pipeIdx);
				const unescaped = rawLink.endsWith('\\') ? rawLink.slice(0, -1) : rawLink;
				const link = unescaped.trim();
				if (link.length === 0) {
					continue;
				}
				const alias = inner.slice(pipeIdx + 1).trim();
				out.push({
					link,
					displayText: alias.length > 0 ? alias : link,
				});
			}
		}
	}
	return out;
}

interface PreparedInlineAttribution {
	readonly property: string;
	readonly value: unknown;
	readonly position: ObsidianPosInput | null | undefined;
	readonly startOffset: number | null;
	readonly endOffset: number | null;
	readonly span: number;
	readonly orderIndex: number;
	readonly coveredLinks: Map<string, number>;
}

function normalizeLinkItem(
	l: ObsidianLinkCacheInput,
	source: 'frontmatter' | 'inline' | 'embed',
	sourcePath: string,
	origin: string,
	resolveLinkPath: ResolveLinkPathFn | undefined,
	property: string | null,
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
		property,
		origin,
	};
}

/**
 * Normalizes an Obsidian `TFile`, `CachedMetadata`, and inline properties
 * into a self-contained plain POJO `NormalizedDocument` bound to `resolvedConfig`.
 * Does not ingest `resolvedLinks`; backlinks are attached downstream by the adapter.
 */
export function normalizeObsidianMetadata(
	tfile: ObsidianFileInput,
	cache: ObsidianMetadataCacheInput | null,
	resolvedConfig: ResolvedEngineConfig,
	inlineProperties: readonly InlinePropertyInput[] = [],
	resolveLinkPath?: ResolveLinkPathFn,
	extractedTasks: readonly ExtractedTaskInput[] = [],
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
	const originResolver = createOriginWikiLinkResolver(
		tfile.path,
		tfile.basename,
		cache?.blocks,
		cache?.headings,
	);

	const recordDocDiagnosticIfInvalid = (
		tv: TypedPropertyValue,
		key: string,
		rawKey: string,
		source: PropertySource,
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

	// Note: Obsidian's native WikiLink display-value suggestions (`[[Note|Alias]]`) only inspect
	// YAML frontmatter `aliases`. Inline `alias`/`aliases` properties are indexed read-only into
	// `aliases` and `aliasLocations` here; copying inline aliases into frontmatter will be
	// provided as an explicit user-invoked command rather than an automatic background mutation.
	const aliasSet = new Set<string>();
	const aliasLocations: NormalizedAliasLocation[] = [];
	const tagSet = new Set<string>();
	const tagLocations: NormalizedTagLocation[] = [];
	const cssclassSet = new Set<string>();

	const recordSystemScopeEntry = (
		systemScope: 'tag' | 'aliases' | 'cssclasses',
		val: unknown,
		source: PropertySource,
		rawPosition?: ObsidianPosInput | null,
	): void => {
		const items = Array.isArray(val) ? (val as readonly unknown[]) : [val];
		if (systemScope === 'cssclasses') {
			if (source !== 'frontmatter') return;
			for (const item of items) {
				if (typeof item !== 'string') continue;
				for (const tok of item.split(/\s+/)) {
					if (tok.length > 0) {
						cssclassSet.add(tok);
					}
				}
			}
			return;
		}

		const occOrigin =
			source === 'frontmatter'
				? originResolver.noteOrigin
				: originResolver.resolve(rawPosition);

		if (systemScope === 'aliases') {
			for (const item of items) {
				const s = sanitizeScalar(item);
				if (!s.valid) continue;
				const tv = coercePropertyValue(item, 'multitext', timeZone);
				if (tv.kind === 'text') {
					aliasSet.add(tv.value);
					aliasLocations.push({
						alias: tv.value,
						source,
						origin: occOrigin,
					});
				}
			}
			return;
		}

		for (const item of items) {
			const s = sanitizeScalar(item);
			if (!s.valid) continue;
			const tv = coercePropertyValue(item, 'text', timeZone);
			if (tv.kind === 'text') {
				const stripped = stripTagHash(tv.value);
				if (stripped) {
					tagSet.add(stripped);
					tagLocations.push({
						tag: stripped,
						source,
						origin: occOrigin,
					});
				}
			}
		}
	};

	const addOccurrence = (
		rawKey: string,
		val: unknown,
		source: PropertySource,
		rawLine?: number | null,
		rawPosition?: ObsidianPosInput | null,
	): void => {
		if (source === 'frontmatter' && rawKey === 'position') return;
		const trimmedKey = rawKey.trim();
		const key = trimmedKey.toLowerCase();
		if (
			!key ||
			FORBIDDEN_KEYS.has(key) ||
			FORBIDDEN_KEYS.has(trimmedKey) ||
			FORBIDDEN_KEYS.has(rawKey)
		) {
			return;
		}

		const systemScope = getSystemScopeForPropertyKey(key);
		if (systemScope !== undefined) {
			recordSystemScopeEntry(systemScope, val, source, rawPosition);
			return;
		}
		if (OMITTED_PROPERTY_VIEW_KEYS.has(key)) {
			return;
		}

		const line = sanitizeLineNumber(rawLine);
		const propertyType = resolveUserPropertyType(key, propertyTypes);
		const occurrenceIndex = propertyOccurrences.length;

		if (Array.isArray(val)) {
			const sanitizedList: SanitizedScalar[] = [];
			const typedValues: TypedPropertyValue[] = [];
			for (const item of val as readonly unknown[]) {
				const s = sanitizeScalar(item);
				if (!s.valid) continue;
				sanitizedList.push(s.scalar);
				const valueIndex = typedValues.length;
				const tv = coercePropertyValue(item, propertyType, timeZone);
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
			const tv = coercePropertyValue(val, propertyType, timeZone);
			recordDocDiagnosticIfInvalid(tv, key, rawKey, source, line, occurrenceIndex, 0);
			propertyOccurrences.push({
				key,
				rawKey,
				source,
				line,
				propertyType,
				rawValue: s.scalar,
				typedValues: [tv],
			});
			occurrencePositions.push(rawPosition);
		}
	};

	for (const [k, v] of Object.entries(cache?.frontmatter ?? {})) {
		addOccurrence(k, v, 'frontmatter', null, null);
	}
	for (const inline of inlineProperties) {
		const inlineSource: PropertySource = inline.source === 'rhizome' ? 'rhizome' : 'dataview';
		addOccurrence(inline.key, inline.value, inlineSource, inline.line, inline.position);
	}

	const { propertyKeys, properties } = buildPropertiesViews(propertyOccurrences);

	const propertyLocations: NormalizedPropertyLocation[] = [];

	for (let i = 0; i < propertyOccurrences.length; i++) {
		const occ = propertyOccurrences[i]!;
		const occOrigin =
			occ.source === 'frontmatter'
				? originResolver.noteOrigin
				: originResolver.resolve(occurrencePositions[i]);

		const propKey = occ.rawKey.trim();
		if (
			!propKey ||
			FORBIDDEN_KEYS.has(propKey) ||
			FORBIDDEN_KEYS.has(occ.key) ||
			OMITTED_PROPERTY_VIEW_KEYS.has(occ.key)
		) {
			continue;
		}

		const locValue: SanitizedScalar | SanitizedScalar[] = Array.isArray(occ.rawValue)
			? [...occ.rawValue]
			: isVacuousOccurrence(occ.rawValue)
				? null
				: occ.rawValue;
		propertyLocations.push({
			property: propKey,
			value: locValue,
			source: occ.source,
			origin: occOrigin,
		});
	}

	const aliases = Array.from(aliasSet);
	const cssclasses = Array.from(cssclassSet);

	for (const t of cache?.tags ?? []) {
		const stripped = stripTagHash(t.tag);
		if (stripped) {
			tagSet.add(stripped);
			tagLocations.push({
				tag: stripped,
				source: 'inline',
				origin: originResolver.resolve(t.position),
			});
		}
	}
	const tags = Array.from(tagSet).sort();

	const headings: NormalizedHeading[] = (cache?.headings ?? []).map((h) => ({
		text: h.heading,
		level: (Number.isFinite(h.level) ? Math.min(6, Math.max(1, Math.trunc(h.level))) : 1) as
			1 | 2 | 3 | 4 | 5 | 6,
		origin: originResolver.forHeading(h.heading),
	}));

	const inlineAttributions: PreparedInlineAttribution[] = [];
	const positionedInlineAttributions: PreparedInlineAttribution[] = [];
	for (let i = 0; i < inlineProperties.length; i++) {
		const inline = inlineProperties[i]!;
		const prop = typeof inline.key === 'string' ? sanitizeLinkPropertyKey(inline.key) : null;
		if (prop === null) {
			continue;
		}
		const pStart = inline.position?.start?.offset;
		const pEnd = inline.position?.end?.offset;
		const hasValidSpan = isValidOffset(pStart) && isValidOffset(pEnd) && pStart <= pEnd;
		const entry: PreparedInlineAttribution = {
			property: prop,
			value: inline.value,
			position: inline.position,
			startOffset: hasValidSpan ? pStart : null,
			endOffset: hasValidSpan ? pEnd : null,
			span: hasValidSpan ? pEnd - pStart : 0,
			orderIndex: i,
			coveredLinks: new Map<string, number>(),
		};
		inlineAttributions.push(entry);
		if (hasValidSpan) {
			positionedInlineAttributions.push(entry);
		}
	}
	if (positionedInlineAttributions.length > 1) {
		positionedInlineAttributions.sort(
			(a, b) =>
				a.span - b.span || b.startOffset! - a.startOffset! || a.orderIndex - b.orderIndex,
		);
	}

	const normalizedBodyLinks: NormalizedLink[] = (cache?.links ?? []).map((l) => {
		let matchedProperty: string | null = null;
		const lStart = l.position?.start?.offset;
		const lEnd = l.position?.end?.offset;
		if (isValidOffset(lStart) && positionedInlineAttributions.length > 0) {
			const effectiveEnd = isValidOffset(lEnd) && lStart <= lEnd ? lEnd : lStart;
			const trimmedLinkKey = l.link.trim();
			for (let i = 0; i < positionedInlineAttributions.length; i++) {
				const attr = positionedInlineAttributions[i]!;
				const aStart = attr.startOffset!;
				const aEnd = attr.endOffset!;
				if (matchedProperty === null && aStart <= lStart && effectiveEnd <= aEnd) {
					matchedProperty = attr.property;
				}
				const overlaps =
					lStart === effectiveEnd
						? aStart <= lStart && lStart <= aEnd
						: lStart < aEnd && effectiveEnd > aStart;
				if (overlaps) {
					attr.coveredLinks.set(
						trimmedLinkKey,
						(attr.coveredLinks.get(trimmedLinkKey) ?? 0) + 1,
					);
				}
			}
		}
		return normalizeLinkItem(
			l,
			'inline',
			tfile.path,
			originResolver.resolve(l.position),
			resolveLinkPath,
			matchedProperty,
		);
	});

	const fallbackInlineLinks: NormalizedLink[] = [];
	for (let i = 0; i < inlineAttributions.length; i++) {
		const attr = inlineAttributions[i]!;
		const extracted = extractWikilinksFromValue(attr.value);
		if (extracted.length === 0) {
			continue;
		}
		const inlineOrigin = originResolver.resolve(attr.position);
		for (let j = 0; j < extracted.length; j++) {
			const ext = extracted[j]!;
			const trimmedLinkKey = ext.link.trim();
			const remaining = attr.coveredLinks.get(trimmedLinkKey) ?? 0;
			if (remaining > 0) {
				attr.coveredLinks.set(trimmedLinkKey, remaining - 1);
				continue;
			}
			fallbackInlineLinks.push(
				normalizeLinkItem(
					ext,
					'inline',
					tfile.path,
					inlineOrigin,
					resolveLinkPath,
					attr.property,
				),
			);
		}
	}

	const links: NormalizedLink[] = [
		...(cache?.frontmatterLinks ?? []).map((l) =>
			normalizeLinkItem(
				l,
				'frontmatter',
				tfile.path,
				originResolver.noteOrigin,
				resolveLinkPath,
				resolveFrontmatterLinkProperty(l.key, cache?.frontmatter),
			),
		),
		...normalizedBodyLinks,
		...fallbackInlineLinks,
	];

	const embeds: NormalizedLink[] = (cache?.embeds ?? []).map((e) =>
		normalizeLinkItem(
			e,
			'embed',
			tfile.path,
			originResolver.resolve(e.position),
			resolveLinkPath,
			null,
		),
	);

	const blocks: NormalizedBlock[] = [];
	for (const b of Object.values(cache?.blocks ?? {})) {
		const cleanedId = b.id.replace(/^\^+/, '');
		if (cleanedId.length > 0) {
			blocks.push({
				id: cleanedId,
				origin: originResolver.forBlock(cleanedId),
			});
		}
	}

	const tasks: NormalizedTask[] = extractedTasks.map((t) => {
		const cleanedTaskBlockId = t.blockId ? t.blockId.replace(/^\^+/, '') : '';
		const taskOrigin =
			cleanedTaskBlockId.length > 0
				? originResolver.forBlock(cleanedTaskBlockId)
				: originResolver.resolve(t.position);

		const taskProperties = Object.create(null) as Record<string, unknown>;
		if (t.properties && typeof t.properties === 'object') {
			for (const [pk, pv] of Object.entries(t.properties)) {
				if (FORBIDDEN_KEYS.has(pk) || FORBIDDEN_KEYS.has(pk.toLowerCase())) continue;
				taskProperties[pk] = Array.isArray(pv) ? [...(pv as readonly unknown[])] : pv;
			}
		}

		return {
			line: t.line,
			status: t.status,
			statusType: t.statusType,
			completed: t.completed,
			done: t.done,
			text: t.text,
			cleanText: t.cleanText,
			priority: t.priority,
			priorityNumber: t.priorityNumber,
			created: t.created,
			start: t.start,
			scheduled: t.scheduled,
			due: t.due,
			completion: t.completion,
			cancelled: t.cancelled,
			repeat: t.repeat,
			onCompletion: t.onCompletion,
			id: t.id,
			dependsOn: [...t.dependsOn],
			tags: [...t.tags],
			blockId: t.blockId,
			parentLine: t.parentLine,
			format: t.format,
			properties: taskProperties,
			origin: taskOrigin,
		};
	});

	const size = tfile.stat.size === 0 ? 0 : tfile.stat.size;

	const file: NormalizedFileInfo = {
		path: tfile.path,
		name: tfile.name,
		basename: tfile.basename,
		extension: tfile.extension,
		parent: tfile.parent?.path && tfile.parent.path !== '/' ? tfile.parent.path : '',
		created: formatEpochMsToMinuteIso(ctime, timeZone),
		modified: formatEpochMsToMinuteIso(mtime, timeZone),
		size,
	};
	internalFileEpochMsMap.set(file, { ctime, mtime });

	return {
		normalizationFingerprint,
		file,
		aliases,
		aliasLocations,
		tags,
		tagLocations,
		cssclasses,
		headings,
		links,
		embeds,
		blocks,
		tasks,
		propertyOccurrences,
		propertyKeys,
		properties,
		propertyLocations,
		diagnostics,
	};
}
