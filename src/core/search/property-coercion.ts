import { parseTemporalExpr } from './temporal';
import {
	isVirtualFileKey,
	type ObsidianPropertyType,
	type PropertyOccurrence,
	type PropertyTypeRegistry,
	type SanitizedScalar,
	type TypedPropertyValue,
} from './types';

export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
	'__proto__',
	'prototype',
	'constructor',
]);

export const STRICT_NUMBER_RE = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const NULL_TYPED_VALUE: TypedPropertyValue = Object.freeze({ kind: 'null' });
const TRUE_TYPED_VALUE: TypedPropertyValue = Object.freeze({
	kind: 'checkbox',
	value: true,
	raw: 'true',
});
const FALSE_TYPED_VALUE: TypedPropertyValue = Object.freeze({
	kind: 'checkbox',
	value: false,
	raw: 'false',
});

function safeToString(val: unknown): string {
	try {
		return String(val);
	} catch {
		return '[unconvertible]';
	}
}

function invalidValue(
	raw: string,
	expectedType: ObsidianPropertyType,
	hint: string | null,
	reason:
		| 'INVALID_VALUE'
		| 'REVERSED_DATE_RANGE'
		| 'SKIPPED_DATE'
		| 'RELATIVE_IN_STORED_PROPERTY' = 'INVALID_VALUE',
): TypedPropertyValue {
	return { kind: 'invalid', raw, expectedType, reason, hint };
}

/**
 * Sanitizes an arbitrary property value or list item into a JSON-safe `SanitizedScalar`.
 * Non-scalar objects, nested arrays, functions, and symbols return `{ valid: false, scalar: null }`.
 */
export function sanitizeScalar(item: unknown): { valid: boolean; scalar: SanitizedScalar } {
	if (item === null || item === undefined) return { valid: true, scalar: null };
	if (typeof item === 'boolean' || typeof item === 'string') return { valid: true, scalar: item };
	if (typeof item === 'number') {
		return { valid: true, scalar: Number.isFinite(item) ? (item === 0 ? 0 : item) : null };
	}
	if (item instanceof Date) {
		return { valid: true, scalar: Number.isNaN(item.getTime()) ? null : item.toISOString() };
	}
	return { valid: false, scalar: null };
}

/**
 * Normalizes a 1-based line number, returning `null` for non-positive or non-integer values.
 */
export function sanitizeLineNumber(line: number | null | undefined): number | null {
	if (typeof line === 'number' && Number.isSafeInteger(line) && line >= 1) {
		return line;
	}
	return null;
}

/**
 * Coerces a raw scalar value to a `TypedPropertyValue` for the given `ObsidianPropertyType`.
 * Non-throwing for JSON primitives, `undefined`, and standard `Date` instances.
 */
export function coercePropertyValue(
	val: unknown,
	propType: ObsidianPropertyType,
	timeZone: string,
): TypedPropertyValue {
	if (val === null || val === undefined) return NULL_TYPED_VALUE;

	switch (propType) {
		case 'number': {
			if (val instanceof Date || typeof val === 'boolean') {
				return invalidValue(
					safeToString(val),
					'number',
					'Provide a finite numeric value (e.g., 42 or -3.5).',
				);
			}
			if (typeof val === 'number') {
				const cleanVal = val === 0 ? 0 : val;
				return Number.isFinite(cleanVal)
					? { kind: 'number', value: cleanVal, raw: String(cleanVal) }
					: invalidValue(String(val), 'number', 'Provide a finite numeric value.');
			}
			if (typeof val === 'string') {
				const trimmed = val.trim();
				if (!STRICT_NUMBER_RE.test(trimmed)) {
					return invalidValue(
						val,
						'number',
						'Provide a finite decimal number without units or hex prefixes.',
					);
				}
				const num = Number(trimmed);
				const cleanNum = num === 0 ? 0 : num;
				return Number.isFinite(cleanNum)
					? { kind: 'number', value: cleanNum, raw: val }
					: invalidValue(val, 'number', 'Provide a finite numeric value.');
			}
			return invalidValue(safeToString(val), 'number', 'Provide a finite numeric value.');
		}

		case 'checkbox': {
			if (typeof val === 'boolean') {
				return val ? TRUE_TYPED_VALUE : FALSE_TYPED_VALUE;
			}
			if (typeof val === 'string') {
				const lower = val.trim().toLowerCase();
				if (lower === 'true') return TRUE_TYPED_VALUE;
				if (lower === 'false') return FALSE_TYPED_VALUE;
			}
			return invalidValue(safeToString(val), 'checkbox', 'Use true or false.');
		}

		case 'date':
		case 'datetime': {
			if (val instanceof Date) {
				if (Number.isNaN(val.getTime())) {
					return invalidValue(
						'Invalid Date',
						propType,
						'Use ISO-8601 format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss).',
					);
				}
				const iso = val.toISOString();
				const res = parseTemporalExpr(iso, {
					allowYearOnly: true,
					allowRelative: false,
					timeZone,
				});
				return res.ok
					? { kind: propType, interval: res.interval, raw: iso }
					: invalidValue(iso, propType, 'Use ISO-8601 format (YYYY-MM-DD).');
			}
			if (typeof val === 'string') {
				const res = parseTemporalExpr(val, {
					allowYearOnly: true,
					allowRelative: false,
					timeZone,
				});
				if (res.ok) {
					return { kind: propType, interval: res.interval, raw: val };
				}
				if (res.reason === 'REVERSED_RANGE') {
					return invalidValue(val, propType, res.hint, 'REVERSED_DATE_RANGE');
				}
				if (res.reason === 'SKIPPED_DATE') {
					return invalidValue(
						val,
						propType,
						`Calendar date "${val}" was skipped by a timezone transition in "${timeZone}".`,
						'SKIPPED_DATE',
					);
				}
				if (res.reason === 'RELATIVE_NOT_ALLOWED' || /(?:^|\.\.)\s*@/.test(val.trim())) {
					return invalidValue(
						val,
						propType,
						'Relative @date anchors are only allowed in search queries, not in stored note properties.',
						'RELATIVE_IN_STORED_PROPERTY',
					);
				}
				return invalidValue(
					val,
					propType,
					'Use a valid ISO-8601 date (YYYY-MM-DD) or range (YYYY-MM-DD..YYYY-MM-DD).',
				);
			}
			return invalidValue(
				safeToString(val),
				propType,
				'Use an ISO-8601 date string (YYYY-MM-DD).',
			);
		}

		case 'text':
		case 'multitext':
		case 'tags': {
			if (val instanceof Date) {
				if (Number.isNaN(val.getTime())) {
					return invalidValue('Invalid Date', propType, null);
				}
				return { kind: 'text', value: val.toISOString() };
			}
			if (typeof val === 'number') {
				return Number.isFinite(val)
					? { kind: 'text', value: String(val) }
					: invalidValue(String(val), propType, null);
			}
			if (typeof val === 'string') {
				return { kind: 'text', value: val };
			}
			if (typeof val === 'boolean') {
				return { kind: 'text', value: val ? 'true' : 'false' };
			}
			return invalidValue(safeToString(val), propType, null);
		}
	}
}

/**
 * Resolves the property type for a stored user property during document normalization.
 * Does not apply virtual `file.*` types to user-authored properties.
 */
export function resolveUserPropertyType(
	lowerKey: string,
	normalizedRegistry: Readonly<PropertyTypeRegistry>,
): ObsidianPropertyType {
	if (lowerKey === 'tags' || lowerKey === 'tag') return 'tags';
	if (lowerKey === 'aliases' || lowerKey === 'alias') return 'multitext';
	if (Object.prototype.hasOwnProperty.call(normalizedRegistry, lowerKey)) {
		const found = normalizedRegistry[lowerKey];
		if (found !== undefined) return found;
	}
	return 'text';
}

/**
 * Resolves the property type for a query `PropertyFilterNode` (`[key op val]`).
 * Virtual `file.*` keys take precedence over user properties.
 */
export function resolveQueryPropertyType(
	lowerKey: string,
	normalizedRegistry: Readonly<PropertyTypeRegistry>,
): ObsidianPropertyType {
	if (lowerKey === 'file.modified' || lowerKey === 'file.created') return 'datetime';
	if (lowerKey === 'file.size') return 'number';
	if (isVirtualFileKey(lowerKey)) return 'text';
	return resolveUserPropertyType(lowerKey, normalizedRegistry);
}

/**
 * Builds the `propertyKeys` and null-prototype `properties` views from `propertyOccurrences`.
 * Defensively copies single-occurrence array values and promotes multi-occurrence keys into 1-level concatenated arrays.
 */
export function buildPropertiesViews(occurrences: readonly PropertyOccurrence[]): {
	propertyKeys: string[];
	properties: Record<string, unknown>;
} {
	const propertyKeys: string[] = [];
	const out = Object.create(null) as Record<string, unknown>;
	const promotedKeys = new Set<string>();

	for (const { key, rawValue } of occurrences) {
		if (FORBIDDEN_KEYS.has(key)) continue;
		if (!(key in out)) {
			propertyKeys.push(key);
			if (Array.isArray(rawValue)) {
				out[key] = [...rawValue];
				promotedKeys.add(key);
			} else {
				out[key] = rawValue;
			}
		} else {
			if (!promotedKeys.has(key)) {
				out[key] = [out[key]];
				promotedKeys.add(key);
			}
			const targetArr = out[key] as unknown[];
			if (Array.isArray(rawValue)) {
				for (const item of rawValue) targetArr.push(item);
			} else {
				targetArr.push(rawValue);
			}
		}
	}

	return { propertyKeys, properties: out };
}
