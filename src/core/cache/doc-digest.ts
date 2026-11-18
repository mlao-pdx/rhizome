import { XxHash64Accumulator } from '../hash/xxhash64';
import type { NormalizedDocument } from '../search/types';

/**
 * Computes a canonical 64-bit xxHash hex digest over every persisted field of a
 * `NormalizedDocument`, excluding the adapter-attached `backlinks` field.
 *
 * @remarks
 * (design, 2026-11-18) The digest is the equivalence probe for the document cache: a warm cache
 * and a cold rebuild of the same vault state must produce the same per-document digest. Field
 * order is fixed here rather than derived from `Object.keys`, while record-valued fields
 * (`properties`, typed property intervals) are hashed with sorted keys so insertion order cannot
 * affect the result. `backlinks` is deliberately never read because it is projected per pass and
 * is not part of the cached metadata payload.
 */
export function digestNormalizedDocument(doc: NormalizedDocument): string {
	const acc = new XxHash64Accumulator();
	acc.updateTag(0x50, 0);
	acc.updateValue([
		doc.normalizationFingerprint,
		doc.file,
		doc.aliases,
		doc.aliasLocations,
		doc.tags,
		doc.tagLocations,
		doc.cssclasses,
		doc.headings,
		doc.links,
		doc.embeds,
		doc.blocks,
		doc.propertyOccurrences,
		doc.propertyKeys,
		doc.properties,
		doc.propertyLocations,
		doc.diagnostics,
	]);
	return acc.digest().hex;
}
