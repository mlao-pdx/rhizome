import { FORBIDDEN_KEYS, STRICT_NUMBER_RE } from './property-coercion';
import { parseTemporalExpr } from './temporal';
import type { DateInterval, NormalizedDocument, ObsidianPropertyType } from './types';

export type ResolvedHostScalar = string | number | boolean;

export type CoercedHostPropertyTarget =
	| { readonly ok: true; readonly kind: 'number'; readonly rhsNum: number }
	| { readonly ok: true; readonly kind: 'checkbox'; readonly rhsBool: boolean }
	| { readonly ok: true; readonly kind: 'temporal'; readonly rhsInterval: DateInterval }
	| {
			readonly ok: true;
			readonly kind: 'text';
			readonly rhsRaw: string;
			readonly rhsLower: string;
	  }
	| { readonly ok: false; readonly raw: string };

export interface ResolvedThisReference {
	readonly resolved: boolean;
	readonly values: readonly ResolvedHostScalar[];
}

const ARRAY_INDEX_RE = /^(?:0|[1-9]\d*)$/;

function isPlainObject(val: unknown): val is Record<string, unknown> {
	return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function lookupObjectSegment(obj: Record<string, unknown>, segment: string): unknown {
	if (FORBIDDEN_KEYS.has(segment)) return undefined;
	if (Object.prototype.hasOwnProperty.call(obj, segment)) {
		return obj[segment];
	}
	const lower = segment.toLowerCase();
	if (FORBIDDEN_KEYS.has(lower)) return undefined;
	for (const key of Object.keys(obj)) {
		if (key.toLowerCase() === lower) {
			return obj[key];
		}
	}
	return undefined;
}

function lookupFileSegment(fileObj: Record<string, unknown>, segment: string): unknown {
	const lower = segment.toLowerCase();
	if (lower === 'ext') return fileObj.extension;
	if (lower === 'ctime') return fileObj.created;
	if (lower === 'mtime') return fileObj.modified;
	return lookupObjectSegment(fileObj, segment);
}

function lookupRootSegment(hostDoc: NormalizedDocument, segment: string): unknown {
	switch (segment.toLowerCase()) {
		case 'file':
			return hostDoc.file;
		case 'aliases':
			return hostDoc.aliases;
		case 'aliaslocations':
			return hostDoc.aliasLocations;
		case 'tags':
			return hostDoc.tags;
		case 'taglocations':
			return hostDoc.tagLocations;
		case 'cssclasses':
			return hostDoc.cssclasses;
		case 'headings':
			return hostDoc.headings;
		case 'links':
			return hostDoc.links;
		case 'embeds':
			return hostDoc.embeds;
		case 'blocks':
			return hostDoc.blocks;
		case 'properties':
			return hostDoc.properties;
		case 'propertylocations':
			return hostDoc.propertyLocations;
		case 'backlinks':
			return hostDoc.backlinks ?? [];
		default:
			return undefined;
	}
}

function collectScalars(val: unknown, out: ResolvedHostScalar[]): boolean {
	if (val === null || val === undefined || val === '') {
		return true;
	}
	if (typeof val === 'string') {
		out.push(val);
		return true;
	}
	if (typeof val === 'boolean') {
		out.push(val);
		return true;
	}
	if (typeof val === 'number') {
		if (Number.isFinite(val)) {
			out.push(val === 0 ? 0 : val);
		}
		return true;
	}
	if (Array.isArray(val)) {
		if (val.length === 0) return true;
		for (const item of val) {
			if (!collectScalars(item, out)) {
				return false;
			}
		}
		return true;
	}
	// Stopping on a plain object (e.g. `@this.file`, `@this.properties`, `@this.links.0`) is non-scalar
	return false;
}

/**
 * Resolves a decoded `@this.<segments>` path against `hostDoc`.
 * Exposes the exact 13-field `VaultQueryMatch` surface (`file`, `aliases`, `aliasLocations`,
 * `tags`, `tagLocations`, `cssclasses`, `headings`, `links`, `embeds`, `blocks`, `properties`, `propertyLocations`,
 * `backlinks`)
 * with exact-then-case-insensitive key matching and array indexing/mapping.
 */
export function resolveThisReference(
	hostDoc: NormalizedDocument | null | undefined,
	segments: readonly string[],
): ResolvedThisReference {
	if (!hostDoc || segments.length === 0) {
		return { resolved: false, values: [] };
	}

	const firstSeg = segments[0]!;
	let current: unknown = lookupRootSegment(hostDoc, firstSeg);
	if (current === undefined) {
		return { resolved: false, values: [] };
	}

	const isFileRoot = firstSeg.toLowerCase() === 'file';

	for (let i = 1; i < segments.length; i++) {
		const seg = segments[i]!;
		if (current === null || current === undefined) {
			return { resolved: false, values: [] };
		}

		if (Array.isArray(current)) {
			if (ARRAY_INDEX_RE.test(seg)) {
				const idx = Number(seg);
				if (!Number.isSafeInteger(idx) || idx < 0 || idx >= current.length) {
					return { resolved: false, values: [] };
				}
				current = current[idx];
			} else {
				const mapped: unknown[] = [];
				for (const item of current) {
					if (isPlainObject(item)) {
						const v = lookupObjectSegment(item, seg);
						if (v !== undefined && v !== null) {
							if (Array.isArray(v)) {
								mapped.push(...(v as readonly unknown[]));
							} else {
								mapped.push(v);
							}
						}
					}
				}
				current = mapped;
			}
		} else if (isPlainObject(current)) {
			current =
				i === 1 && isFileRoot
					? lookupFileSegment(current, seg)
					: lookupObjectSegment(current, seg);
		} else {
			return { resolved: false, values: [] };
		}
	}

	const values: ResolvedHostScalar[] = [];
	const ok = collectScalars(current, values);
	if (!ok || values.length === 0) {
		return { resolved: false, values: [] };
	}
	return { resolved: true, values };
}

/**
 * Coerces a single scalar resolved from `@this.<path>` to the target `ObsidianPropertyType`
 * of an enclosing `PropertyFilterNode`.
 */
export function coerceHostScalarForProperty(
	val: ResolvedHostScalar,
	propType: ObsidianPropertyType,
	timeZone: string,
	referenceTimeMs: number,
): CoercedHostPropertyTarget {
	const raw = String(val);
	switch (propType) {
		case 'number': {
			if (typeof val === 'number') {
				if (!Number.isFinite(val)) return { ok: false, raw };
				return { ok: true, kind: 'number', rhsNum: val === 0 ? 0 : val };
			}
			if (typeof val === 'string') {
				const trimmed = val.trim();
				if (!STRICT_NUMBER_RE.test(trimmed)) return { ok: false, raw };
				const num = Number(trimmed);
				if (!Number.isFinite(num)) return { ok: false, raw };
				return { ok: true, kind: 'number', rhsNum: num === 0 ? 0 : num };
			}
			return { ok: false, raw };
		}
		case 'checkbox': {
			if (typeof val === 'boolean') {
				return { ok: true, kind: 'checkbox', rhsBool: val };
			}
			if (typeof val === 'string') {
				const lower = val.trim().toLowerCase();
				if (lower === 'true' || lower === 'false') {
					return { ok: true, kind: 'checkbox', rhsBool: lower === 'true' };
				}
			}
			return { ok: false, raw };
		}
		case 'date':
		case 'datetime': {
			if (typeof val !== 'string') {
				return { ok: false, raw };
			}
			const res = parseTemporalExpr(val, {
				allowYearOnly: true,
				allowRelative: true,
				timeZone,
				referenceTimeMs,
			});
			if (!res.ok) {
				return { ok: false, raw };
			}
			return { ok: true, kind: 'temporal', rhsInterval: res.interval };
		}
		case 'text':
		case 'multitext':
			return {
				ok: true,
				kind: 'text',
				rhsRaw: raw,
				rhsLower: raw.toLowerCase(),
			};
	}
}
