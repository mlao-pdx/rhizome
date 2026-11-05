import {
	encodeDoubleQuoted,
	FORBIDDEN_KEYS,
	isValidReferenceTimeMs,
	parseSingleTemporalAtom,
} from '@core/search';
import {
	type HeadingContextState,
	isBareRelativeTemporalAtom,
	normalizeInitialHeadingLevel,
	resolveValidTimeZone,
	TEMPORAL_CONTEXT_META_SYMBOL,
	TemporalDrop,
} from './temporal-drop';
import type { TemplatePlatformFlags, TemplateRuntimeContext } from './types';

/**
 * Reserved internal query key used to fetch the hosting note's normalized metadata
 * through the standard `plugin.query` / `ActiveQueryRoster` pipeline.
 * All `'◊'`-prefixed keys are stripped from the user-facing `query.*` namespace.
 */
export const HOST_QUERY_KEY = '◊host';

/**
 * Builds the exact virtual-property search query matching a single vault note by its
 * vault-relative `sourcePath` (`[file.path: = "<escaped>"]`).
 */
export function buildHostNoteQuery(sourcePath: string): string {
	return `[file.path: = ${encodeDoubleQuoted(sourcePath)}]`;
}

const DEFAULT_PLATFORM_FLAGS: TemplatePlatformFlags = Object.freeze({
	isDesktop: true,
	isMobile: false,
	isDesktopApp: true,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: false,
	isWin: false,
	isLinux: false,
	isSafari: false,
});

function normalizePlatformFlags(raw?: Partial<TemplatePlatformFlags>): TemplatePlatformFlags {
	if (!raw || typeof raw !== 'object') {
		return DEFAULT_PLATFORM_FLAGS;
	}
	return Object.freeze({
		isDesktop: Boolean(raw.isDesktop ?? DEFAULT_PLATFORM_FLAGS.isDesktop),
		isMobile: Boolean(raw.isMobile ?? DEFAULT_PLATFORM_FLAGS.isMobile),
		isDesktopApp: Boolean(raw.isDesktopApp ?? DEFAULT_PLATFORM_FLAGS.isDesktopApp),
		isMobileApp: Boolean(raw.isMobileApp ?? DEFAULT_PLATFORM_FLAGS.isMobileApp),
		isIosApp: Boolean(raw.isIosApp ?? DEFAULT_PLATFORM_FLAGS.isIosApp),
		isAndroidApp: Boolean(raw.isAndroidApp ?? DEFAULT_PLATFORM_FLAGS.isAndroidApp),
		isPhone: Boolean(raw.isPhone ?? DEFAULT_PLATFORM_FLAGS.isPhone),
		isTablet: Boolean(raw.isTablet ?? DEFAULT_PLATFORM_FLAGS.isTablet),
		isMacOS: Boolean(raw.isMacOS ?? DEFAULT_PLATFORM_FLAGS.isMacOS),
		isWin: Boolean(raw.isWin ?? DEFAULT_PLATFORM_FLAGS.isWin),
		isLinux: Boolean(raw.isLinux ?? DEFAULT_PLATFORM_FLAGS.isLinux),
		isSafari: Boolean(raw.isSafari ?? DEFAULT_PLATFORM_FLAGS.isSafari),
	});
}

function resolveTemporalAnchorDrop(
	identifier: string,
	timeZone: string,
	referenceTimeMs: number,
): TemporalDrop | null {
	const parsed = parseSingleTemporalAtom(`@${identifier}`, {
		allowYearOnly: true,
		allowRelative: true,
		timeZone,
		referenceTimeMs,
	});
	if (!parsed.ok) {
		return null;
	}
	return TemporalDrop.fromDateInterval(parsed.interval, timeZone, referenceTimeMs);
}

const EMPTY_FROZEN_ARRAY: readonly never[] = Object.freeze([]);
const EMPTY_FROZEN_PROPERTIES: Readonly<Record<string, unknown>> = Object.freeze(
	Object.create(null) as Record<string, unknown>,
);

/**
 * Extracts the user-facing `query` map from a raw batched query payload, stripping all
 * `'◊'`-prefixed internal keys (such as `'◊host'`) and prototype-pollution keys.
 */
export function extractUserQueryMap(
	rawPayload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown[]>> {
	const queryMap = Object.create(null) as Record<string, unknown[]>;
	if (!rawPayload || typeof rawPayload !== 'object') {
		return Object.freeze(queryMap);
	}

	for (const key of Object.keys(rawPayload)) {
		if (FORBIDDEN_KEYS.has(key) || key.startsWith('◊')) {
			continue;
		}
		const val = rawPayload[key];
		if (Array.isArray(val)) {
			queryMap[key] = val;
		}
	}

	return Object.freeze(queryMap);
}

/**
 * Constructs the root LiquidJS scope object for Pass 2 rendering:
 * - Binds the hosting note's 11 normalized fields (`file`, `aliases`, `aliasLocations`, `tags`,
 *   `tagLocations`, `headings`, `links`, `embeds`, `blocks`, `properties`, `propertyLocations`)
 *   from `rawPayload['◊host'][0]` under `root.this`.
 * - Exposes user query results under `query.<name>` (excluding `'◊'`-prefixed internal keys).
 * - Exposes `vault`, `tz`, `language`, and `platform.*` at the root.
 * - Exposes all built-in relative temporal literals (`now`, `today`, `today-7d`, `yesterday+3d`,
 *   `thisweek`, `thismonth`, `thisquarter`, `thisyear`, etc.) as `TemporalDrop` instances.
 */
export function buildRhizomeTemplateContext(
	rawPayload: Readonly<Record<string, unknown>>,
	runtimeContext?: TemplateRuntimeContext,
): Record<string, unknown> {
	const referenceTimeMs = isValidReferenceTimeMs(runtimeContext?.referenceTimeMs)
		? runtimeContext.referenceTimeMs
		: Date.now();
	const timeZone = resolveValidTimeZone(runtimeContext?.timeZone);
	const vault = typeof runtimeContext?.vault === 'string' ? runtimeContext.vault : '';
	const language =
		typeof runtimeContext?.language === 'string' && runtimeContext.language.trim().length > 0
			? runtimeContext.language.trim()
			: 'en';
	const platform = normalizePlatformFlags(runtimeContext?.platform);

	const hostEntries =
		rawPayload && typeof rawPayload === 'object' ? rawPayload[HOST_QUERY_KEY] : undefined;
	const hostMatch =
		Array.isArray(hostEntries) && hostEntries.length > 0 && typeof hostEntries[0] === 'object'
			? (hostEntries[0] as Record<string, unknown> | null)
			: null;

	const hostObject = Object.freeze({
		file: hostMatch && 'file' in hostMatch ? hostMatch.file : null,
		aliases:
			hostMatch && Array.isArray(hostMatch.aliases) ? hostMatch.aliases : EMPTY_FROZEN_ARRAY,
		aliasLocations:
			hostMatch && Array.isArray(hostMatch.aliasLocations)
				? hostMatch.aliasLocations
				: EMPTY_FROZEN_ARRAY,
		tags: hostMatch && Array.isArray(hostMatch.tags) ? hostMatch.tags : EMPTY_FROZEN_ARRAY,
		tagLocations:
			hostMatch && Array.isArray(hostMatch.tagLocations)
				? hostMatch.tagLocations
				: EMPTY_FROZEN_ARRAY,
		headings:
			hostMatch && Array.isArray(hostMatch.headings)
				? hostMatch.headings
				: EMPTY_FROZEN_ARRAY,
		links: hostMatch && Array.isArray(hostMatch.links) ? hostMatch.links : EMPTY_FROZEN_ARRAY,
		embeds:
			hostMatch && Array.isArray(hostMatch.embeds) ? hostMatch.embeds : EMPTY_FROZEN_ARRAY,
		blocks:
			hostMatch && Array.isArray(hostMatch.blocks) ? hostMatch.blocks : EMPTY_FROZEN_ARRAY,
		properties:
			hostMatch && hostMatch.properties && typeof hostMatch.properties === 'object'
				? hostMatch.properties
				: EMPTY_FROZEN_PROPERTIES,
		propertyLocations:
			hostMatch && Array.isArray(hostMatch.propertyLocations)
				? hostMatch.propertyLocations
				: EMPTY_FROZEN_ARRAY,
	});

	const root: Record<string, unknown> = {
		this: hostObject,
		query: extractUserQueryMap(rawPayload),
		vault,
		tz: timeZone,
		language,
		platform,
	};

	const initialHeadingLevel = normalizeInitialHeadingLevel(runtimeContext?.headingLevel);
	const headingState: HeadingContextState = {
		level: initialHeadingLevel,
		initialLevel: initialHeadingLevel,
	};

	Object.defineProperty(root, TEMPORAL_CONTEXT_META_SYMBOL, {
		value: Object.freeze({ timeZone, referenceTimeMs, language, headingState }),
		enumerable: false,
		configurable: false,
		writable: false,
	});

	const ensureDynamicTemporalKey = (target: Record<string, unknown>, prop: PropertyKey): void => {
		if (typeof prop !== 'string' || prop in target || FORBIDDEN_KEYS.has(prop)) {
			return;
		}
		if (isBareRelativeTemporalAtom(prop)) {
			const drop = resolveTemporalAnchorDrop(prop, timeZone, referenceTimeMs);
			if (drop) {
				target[prop] = drop;
			}
		}
	};

	return new Proxy(root, {
		has(target, prop) {
			ensureDynamicTemporalKey(target, prop);
			return prop in target;
		},
		getOwnPropertyDescriptor(target, prop) {
			ensureDynamicTemporalKey(target, prop);
			return Object.getOwnPropertyDescriptor(target, prop);
		},
		get(target, prop, receiver) {
			ensureDynamicTemporalKey(target, prop);
			return Reflect.get(target, prop, receiver) as unknown;
		},
	});
}
