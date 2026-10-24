import {
	buildPropertiesViews,
	coercePropertyValue,
	FORBIDDEN_KEYS,
	isCleanSanitizedScalar,
	resolveUserPropertyType,
	sanitizeLineNumber,
	sanitizeScalar,
} from './property-coercion';
import { MAX_SAFE_EPOCH_MS } from './temporal';
import type {
	DocumentDiagnostic,
	DocumentDiagnosticCode,
	NormalizedDocument,
	NormalizedHeading,
	NormalizedLink,
	PropertyOccurrence,
	ResolvedEngineConfig,
	SanitizedScalar,
	TypedPropertyValue,
} from './types';

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
}

export interface ObsidianMetadataCacheInput {
	readonly frontmatter?: Readonly<Record<string, unknown>> | undefined;
	readonly tags?: ReadonlyArray<{ readonly tag: string }> | undefined;
	readonly headings?:
		ReadonlyArray<{ readonly heading: string; readonly level: number }> | undefined;
	readonly links?: readonly ObsidianLinkCacheInput[] | undefined;
	readonly frontmatterLinks?: readonly ObsidianLinkCacheInput[] | undefined;
	readonly embeds?: readonly ObsidianLinkCacheInput[] | undefined;
	readonly blocks?: Readonly<Record<string, { readonly id: string }>> | undefined;
}

export interface InlinePropertyInput {
	readonly key: string;
	readonly value: unknown;
	readonly line?: number | null | undefined;
}

export type ResolvedLinksSnapshotInput = Readonly<
	Record<string, Readonly<Record<string, number>> | undefined>
>;

export type ResolveLinkPathFn = (rawTarget: string, sourcePath: string) => string | null;

function validateIntegerTimestampMs(val: number, fieldName: string): number {
	if (!Number.isSafeInteger(val) || Math.abs(val) > MAX_SAFE_EPOCH_MS) {
		throw new Error(`Invalid file stat ${fieldName}: ${val}`);
	}
	return val === 0 ? 0 : val;
}

function defineLazyProperty<K extends keyof NormalizedDocument>(
	target: NormalizedDocument,
	key: K,
	compute: () => NormalizedDocument[K],
): void {
	Object.defineProperty(target, key, {
		get(): NormalizedDocument[K] {
			const val = compute();
			Object.defineProperty(target, key, {
				value: val,
				writable: true,
				enumerable: true,
				configurable: true,
			});
			return val;
		},
		set(val: NormalizedDocument[K]): void {
			Object.defineProperty(target, key, {
				value: val,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		},
		enumerable: true,
		configurable: true,
	});
}

function normalizeLinkItem(
	l: ObsidianLinkCacheInput,
	source: 'body' | 'frontmatter' | 'embed',
	sourcePath: string,
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
	};
}

/**
 * Normalizes an Obsidian `TFile`, `CachedMetadata`, inline properties, and `resolvedLinks`
 * into a self-contained `NormalizedDocument` bound to `resolvedConfig`.
 *
 * @remarks
 * Shares clean `tfile.stat` and frontmatter scalar arrays by reference without mutation,
 * and lazily materializes derived collections (`tags`, `aliases`, `headings`, `links`,
 * `embeds`, `referencedLinks`, `blocks`, `propertyKeys`, `properties`) on first read.
 */
export function normalizeObsidianMetadata(
	tfile: ObsidianFileInput,
	cache: ObsidianMetadataCacheInput | null,
	resolvedConfig: ResolvedEngineConfig,
	inlineProperties: readonly InlinePropertyInput[] = [],
	resolvedLinksSnapshot: ResolvedLinksSnapshotInput = {},
	resolveLinkPath?: ResolveLinkPathFn,
): NormalizedDocument {
	const ctime = validateIntegerTimestampMs(tfile.stat.ctime, 'ctime');
	const mtime = validateIntegerTimestampMs(tfile.stat.mtime, 'mtime');
	if (!Number.isSafeInteger(tfile.stat.size) || tfile.stat.size < 0) {
		throw new Error(`Invalid file stat size: ${tfile.stat.size}`);
	}

	const { timeZone, propertyTypes, normalizationFingerprint } = resolvedConfig;
	const propertyOccurrences: PropertyOccurrence[] = [];
	const diagnostics: DocumentDiagnostic[] = [];

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
	): void => {
		if (source === 'frontmatter' && rawKey === 'position') return;
		const key = rawKey.trim().toLowerCase();
		if (!key || FORBIDDEN_KEYS.has(key) || FORBIDDEN_KEYS.has(rawKey)) return;

		const line = sanitizeLineNumber(rawLine);
		const propertyType = resolveUserPropertyType(key, propertyTypes);
		const occurrenceIndex = propertyOccurrences.length;

		if (Array.isArray(val)) {
			const canShareArray = val.every(isCleanSanitizedScalar);
			const sanitizedList: SanitizedScalar[] = canShareArray ? val : [];
			const typedValues: TypedPropertyValue[] = [];
			for (const item of val as readonly unknown[]) {
				if (!canShareArray) {
					const s = sanitizeScalar(item);
					if (!s.valid) continue;
					sanitizedList.push(s.scalar);
				}
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
		}
	};

	for (const [k, v] of Object.entries(cache?.frontmatter ?? {})) {
		addOccurrence(k, v, 'frontmatter', null);
	}
	for (const inline of inlineProperties) {
		addOccurrence(inline.key, inline.value, 'inline', inline.line);
	}

	const size = tfile.stat.size === 0 ? 0 : tfile.stat.size;
	const canShareStat =
		Object.keys(tfile.stat).length === 3 &&
		!Object.is(tfile.stat.ctime, -0) &&
		!Object.is(tfile.stat.mtime, -0) &&
		!Object.is(tfile.stat.size, -0);
	const stat = canShareStat ? tfile.stat : { ctime, mtime, size };

	const doc = {
		normalizationFingerprint,
		file: {
			path: tfile.path,
			name: tfile.name,
			basename: tfile.basename,
			extension: tfile.extension,
			parent: tfile.parent?.path && tfile.parent.path !== '/' ? tfile.parent.path : '',
			stat,
		},
	} as NormalizedDocument;

	defineLazyProperty(doc, 'aliases', () => {
		const aliases: string[] = [];
		for (const occ of propertyOccurrences) {
			if (occ.key === 'aliases' || occ.key === 'alias') {
				for (const tv of occ.typedValues) {
					if (tv.kind === 'text') aliases.push(tv.value);
				}
			}
		}
		return aliases;
	});

	defineLazyProperty(doc, 'tags', () => {
		const tagSet = new Set<string>();
		for (const t of cache?.tags ?? []) {
			const clean = t.tag.trim().toLowerCase();
			if (clean) tagSet.add(clean.startsWith('#') ? clean : `#${clean}`);
		}
		for (const occ of propertyOccurrences) {
			if (occ.key === 'tags' || occ.key === 'tag') {
				for (const tv of occ.typedValues) {
					if (tv.kind === 'text') {
						const clean = tv.value.trim().toLowerCase();
						if (clean) tagSet.add(clean.startsWith('#') ? clean : `#${clean}`);
					}
				}
			}
		}
		return Array.from(tagSet).sort();
	});

	defineLazyProperty(doc, 'headings', (): NormalizedHeading[] =>
		(cache?.headings ?? []).map((h) => ({
			text: h.heading,
			level: (Number.isFinite(h.level)
				? Math.min(6, Math.max(1, Math.trunc(h.level)))
				: 1) as 1 | 2 | 3 | 4 | 5 | 6,
		})),
	);

	defineLazyProperty(doc, 'links', (): NormalizedLink[] => [
		...(cache?.links ?? []).map((l) =>
			normalizeLinkItem(l, 'body', tfile.path, resolveLinkPath),
		),
		...(cache?.frontmatterLinks ?? []).map((l) =>
			normalizeLinkItem(l, 'frontmatter', tfile.path, resolveLinkPath),
		),
	]);

	defineLazyProperty(doc, 'embeds', (): NormalizedLink[] =>
		(cache?.embeds ?? []).map((e) =>
			normalizeLinkItem(e, 'embed', tfile.path, resolveLinkPath),
		),
	);

	defineLazyProperty(doc, 'referencedLinks', () => {
		const incomingSet = new Set<string>();
		for (const [sourcePath, targets] of Object.entries(resolvedLinksSnapshot)) {
			const count = targets?.[tfile.path];
			if (typeof count === 'number' && count > 0) {
				incomingSet.add(sourcePath);
			}
		}
		return Array.from(incomingSet).sort();
	});

	defineLazyProperty(doc, 'blocks', () =>
		Object.keys(cache?.blocks ?? {}).map((b) =>
			b.startsWith('^') ? b.slice(1).toLowerCase() : b.toLowerCase(),
		),
	);

	doc.propertyOccurrences = propertyOccurrences;

	const materializePropertyViews = (): {
		propertyKeys: string[];
		properties: Record<string, unknown>;
	} => {
		const views = buildPropertiesViews(propertyOccurrences);
		Object.defineProperty(doc, 'propertyKeys', {
			value: views.propertyKeys,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(doc, 'properties', {
			value: views.properties,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		return views;
	};

	defineLazyProperty(doc, 'propertyKeys', () => materializePropertyViews().propertyKeys);
	defineLazyProperty(doc, 'properties', () => materializePropertyViews().properties);

	doc.diagnostics = diagnostics;

	return doc;
}
