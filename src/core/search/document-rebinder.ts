import {
	createNormalizedFileInfo,
	getInternalFileEpochMs,
	setInternalFileEpochMs,
	validateFileStat,
	type ObsidianFileInput,
	type ResolveLinkPathFn,
} from './metadata-normalizer';
import { formatEpochMsToMinuteIso } from './temporal';
import type {
	DocumentDiagnostic,
	NormalizedAliasLocation,
	NormalizedBlock,
	NormalizedDocument,
	NormalizedFileInfo,
	NormalizedHeading,
	NormalizedLink,
	NormalizedPropertyLocation,
	NormalizedTagLocation,
	NormalizedTask,
	ResolvedEngineConfig,
} from './types';

function isSelfSubpathLink(rawLink: string): boolean {
	return rawLink.length > 0 && (rawLink[0] === '#' || rawLink[0] === '^');
}

function rebindLinksOnly(
	items: NormalizedLink[],
	sourcePath: string,
	resolveLinkPath: ResolveLinkPathFn | undefined,
): { readonly items: NormalizedLink[]; readonly changed: boolean } {
	if (items.length === 0) {
		return { items, changed: false };
	}
	let next: NormalizedLink[] | null = null;
	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		const resolvedPath = isSelfSubpathLink(item.link)
			? sourcePath
			: resolveLinkPath
				? resolveLinkPath(item.rawTarget, sourcePath)
				: null;
		if (resolvedPath !== item.resolvedPath) {
			if (next === null) {
				next = items.slice(0, i);
			}
			next.push({
				link: item.link,
				rawTarget: item.rawTarget,
				resolvedPath,
				subpath: item.subpath,
				displayText: item.displayText,
				source: item.source,
				property: item.property,
				origin: item.origin,
			});
		} else if (next !== null) {
			next.push(item);
		}
	}
	return next !== null ? { items: next, changed: true } : { items, changed: false };
}

function rebindMovedLinks(
	items: NormalizedLink[],
	newSourcePath: string,
	resolveLinkPath: ResolveLinkPathFn | undefined,
	rebindOrigin: (prevOrigin: string) => string,
): NormalizedLink[] {
	if (items.length === 0) {
		return items;
	}
	let next: NormalizedLink[] | null = null;
	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		const selfSubpath = isSelfSubpathLink(item.link);
		const rawTarget = selfSubpath ? newSourcePath : item.rawTarget;
		const resolvedPath = selfSubpath
			? newSourcePath
			: resolveLinkPath
				? resolveLinkPath(rawTarget, newSourcePath)
				: null;
		const origin = rebindOrigin(item.origin);
		if (
			rawTarget !== item.rawTarget ||
			resolvedPath !== item.resolvedPath ||
			origin !== item.origin
		) {
			if (next === null) {
				next = items.slice(0, i);
			}
			next.push({
				link: item.link,
				rawTarget,
				resolvedPath,
				subpath: item.subpath,
				displayText: item.displayText,
				source: item.source,
				property: item.property,
				origin,
			});
		} else if (next !== null) {
			next.push(item);
		}
	}
	return next ?? items;
}

/**
 * Incrementally re-evaluates `resolvedPath` on `prevDoc.links` and `prevDoc.embeds`
 * for an unmoved note whose intrinsic metadata, body scan, stats, and engine config
 * are unchanged.
 *
 * @remarks
 * Reuses all 15 non-link fields of `prevDoc` and any unchanged `NormalizedLink`
 * elements by reference. Returns `prevDoc` directly if no `resolvedPath` changed.
 */
export function rebindDocumentLinks(
	prevDoc: NormalizedDocument,
	sourcePath: string,
	resolveLinkPath?: ResolveLinkPathFn,
): NormalizedDocument {
	const reboundLinks = rebindLinksOnly(prevDoc.links, sourcePath, resolveLinkPath);
	const reboundEmbeds = rebindLinksOnly(prevDoc.embeds, sourcePath, resolveLinkPath);
	if (!reboundLinks.changed && !reboundEmbeds.changed) {
		return prevDoc;
	}
	return {
		normalizationFingerprint: prevDoc.normalizationFingerprint,
		file: prevDoc.file,
		aliases: prevDoc.aliases,
		aliasLocations: prevDoc.aliasLocations,
		tags: prevDoc.tags,
		tagLocations: prevDoc.tagLocations,
		cssclasses: prevDoc.cssclasses,
		headings: prevDoc.headings,
		links: reboundLinks.items,
		embeds: reboundEmbeds.items,
		blocks: prevDoc.blocks,
		tasks: prevDoc.tasks,
		propertyOccurrences: prevDoc.propertyOccurrences,
		propertyKeys: prevDoc.propertyKeys,
		properties: prevDoc.properties,
		propertyLocations: prevDoc.propertyLocations,
		diagnostics: prevDoc.diagnostics,
	};
}

/**
 * Incrementally rebinds a `NormalizedDocument` after a `TFile` move/rename (or `stat`-only
 * update) when its `CachedMetadata` object, `BodyScanCache` revision, and engine config
 * fingerprint are unchanged.
 *
 * @remarks
 * Reuses intrinsic property/tag/alias/task structures (`aliases`, `tags`, `cssclasses`,
 * `propertyOccurrences`, `propertyKeys`, `properties`, and nested frozen arrays/maps)
 * by reference while updating `file` (`setInternalFileEpochMs`), `origin` wikilinks,
 * `links`/`embeds` target resolution, and `diagnostics` paths to match a cold
 * `normalizeObsidianMetadata` build bit-for-bit.
 */
export function rebindMovedDocument(
	prevDoc: NormalizedDocument,
	tfile: ObsidianFileInput,
	resolvedConfig: ResolvedEngineConfig,
	resolveLinkPath?: ResolveLinkPathFn,
): NormalizedDocument {
	const { ctime, mtime, size } = validateFileStat(tfile);
	const { timeZone, normalizationFingerprint } = resolvedConfig;

	const prevEpochs = getInternalFileEpochMs(prevDoc.file);
	const created =
		prevEpochs?.ctime === ctime
			? prevDoc.file.created
			: formatEpochMsToMinuteIso(ctime, timeZone);
	const modified =
		prevEpochs?.mtime === mtime
			? prevDoc.file.modified
			: formatEpochMsToMinuteIso(mtime, timeZone);

	const file: NormalizedFileInfo = createNormalizedFileInfo({
		path: tfile.path,
		name: tfile.name,
		basename: tfile.basename,
		extension: tfile.extension,
		parent: tfile.parent?.path && tfile.parent.path !== '/' ? tfile.parent.path : '',
		created,
		modified,
		size,
	});
	setInternalFileEpochMs(file, { ctime, mtime });

	const oldPath = prevDoc.file.path;
	const oldBasename = prevDoc.file.basename;
	const identityMoved = oldPath !== tfile.path || oldBasename !== tfile.basename;

	if (!identityMoved) {
		const reboundLinks = rebindLinksOnly(prevDoc.links, tfile.path, resolveLinkPath);
		const reboundEmbeds = rebindLinksOnly(prevDoc.embeds, tfile.path, resolveLinkPath);
		return {
			normalizationFingerprint,
			file,
			aliases: prevDoc.aliases,
			aliasLocations: prevDoc.aliasLocations,
			tags: prevDoc.tags,
			tagLocations: prevDoc.tagLocations,
			cssclasses: prevDoc.cssclasses,
			headings: prevDoc.headings,
			links: reboundLinks.items,
			embeds: reboundEmbeds.items,
			blocks: prevDoc.blocks,
			tasks: prevDoc.tasks,
			propertyOccurrences: prevDoc.propertyOccurrences,
			propertyKeys: prevDoc.propertyKeys,
			properties: prevDoc.properties,
			propertyLocations: prevDoc.propertyLocations,
			diagnostics: prevDoc.diagnostics,
		};
	}

	const oldNoteOrigin = `[[${oldPath}|${oldBasename}]]`;
	const newNoteOrigin = `[[${tfile.path}|${tfile.basename}]]`;
	const oldAnchorPrefix = `[[${oldPath}#`;
	const oldSuffix = `|${oldBasename}]]`;
	const minAnchoredLen = oldAnchorPrefix.length + oldSuffix.length;
	const originMemo = new Map<string, string>([[oldNoteOrigin, newNoteOrigin]]);

	const rebindOrigin = (prevOrigin: string): string => {
		const hit = originMemo.get(prevOrigin);
		if (hit !== undefined) {
			return hit;
		}
		let rebound = newNoteOrigin;
		if (
			prevOrigin.length >= minAnchoredLen &&
			prevOrigin.startsWith(oldAnchorPrefix) &&
			prevOrigin.endsWith(oldSuffix)
		) {
			const anchor = prevOrigin.slice(
				oldAnchorPrefix.length,
				prevOrigin.length - oldSuffix.length,
			);
			rebound = `[[${tfile.path}#${anchor}|${tfile.basename}]]`;
		}
		originMemo.set(prevOrigin, rebound);
		return rebound;
	};

	const aliasLocations: NormalizedAliasLocation[] =
		prevDoc.aliasLocations.length === 0
			? prevDoc.aliasLocations
			: prevDoc.aliasLocations.map((loc) => ({
					alias: loc.alias,
					source: loc.source,
					origin: rebindOrigin(loc.origin),
				}));

	const tagLocations: NormalizedTagLocation[] =
		prevDoc.tagLocations.length === 0
			? prevDoc.tagLocations
			: prevDoc.tagLocations.map((loc) => ({
					tag: loc.tag,
					source: loc.source,
					origin: rebindOrigin(loc.origin),
				}));

	const headings: NormalizedHeading[] =
		prevDoc.headings.length === 0
			? prevDoc.headings
			: prevDoc.headings.map((h) => ({
					text: h.text,
					level: h.level,
					origin: rebindOrigin(h.origin),
				}));

	const links = rebindMovedLinks(prevDoc.links, tfile.path, resolveLinkPath, rebindOrigin);
	const embeds = rebindMovedLinks(prevDoc.embeds, tfile.path, resolveLinkPath, rebindOrigin);

	const blocks: NormalizedBlock[] =
		prevDoc.blocks.length === 0
			? prevDoc.blocks
			: prevDoc.blocks.map((b) => ({
					id: b.id,
					origin: rebindOrigin(b.origin),
				}));

	const tasks: NormalizedTask[] =
		prevDoc.tasks.length === 0
			? prevDoc.tasks
			: prevDoc.tasks.map((t) => ({
					...t,
					origin: rebindOrigin(t.origin),
				}));

	const propertyLocations: NormalizedPropertyLocation[] =
		prevDoc.propertyLocations.length === 0
			? prevDoc.propertyLocations
			: prevDoc.propertyLocations.map((loc) => ({
					property: loc.property,
					value: loc.value,
					source: loc.source,
					origin: rebindOrigin(loc.origin),
				}));

	const diagnostics: DocumentDiagnostic[] =
		prevDoc.diagnostics.length === 0
			? prevDoc.diagnostics
			: prevDoc.diagnostics.map((d) => ({
					...d,
					filePath: tfile.path,
					fileBasename: tfile.basename,
				}));

	return {
		normalizationFingerprint,
		file,
		aliases: prevDoc.aliases,
		aliasLocations,
		tags: prevDoc.tags,
		tagLocations,
		cssclasses: prevDoc.cssclasses,
		headings,
		links,
		embeds,
		blocks,
		tasks,
		propertyOccurrences: prevDoc.propertyOccurrences,
		propertyKeys: prevDoc.propertyKeys,
		properties: prevDoc.properties,
		propertyLocations,
		diagnostics,
	};
}
