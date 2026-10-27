import { type App, normalizePath } from 'obsidian';
import {
	compileQuery,
	type DocumentDiagnostic,
	evaluateVault,
	FORBIDDEN_KEYS,
	initEngineConfig,
	isValidPropertyType,
	isValidReferenceTimeMs,
	type NormalizedDocument,
	type NormalizedFileInfo,
	type NormalizedHeading,
	type NormalizedLink,
	type NormalizedTagLocation,
	normalizeObsidianMetadata,
	type PropertyTypeRegistry,
	type ResolveLinkPathFn,
	type SearchDiagnostic,
} from '@core/search';

const BUILTIN_PROPERTY_KEYS: ReadonlySet<string> = new Set(['alias', 'aliases', 'tag', 'tags']);

/**
 * Options for running or diagnosing a vault query.
 */
export interface VaultQueryOptions {
	/** Optional IANA timezone override (defaults to system timezone, falling back to 'UTC'). */
	readonly timeZone?: string | undefined;
	/** Optional property-type overrides merged on top of `.obsidian/types.json`. */
	readonly propertyTypes?: PropertyTypeRegistry | undefined;
	/** Optional reference timestamp in UTC epoch ms for `@` relative date anchors (defaults to `Date.now()`). */
	readonly referenceTimeMs?: number | undefined;
}

/**
 * Run-level environment context returned by `runVaultQuery` and `plugin.query`.
 */
export interface VaultQueryContext {
	/** Resolved IANA timezone used for query compilation and date coercion (trimmed). */
	readonly timeZone: string;
	/**
	 * Reference timestamp in UTC epoch ms for `@` relative date anchors,
	 * or `null` if an invalid `referenceTimeMs` override was supplied.
	 */
	readonly referenceTimeMs: number | null;
	/** Active normalized property-type registry (merged `.obsidian/types.json` and `options.propertyTypes`). */
	readonly propertyTypes: Readonly<PropertyTypeRegistry>;
}

/**
 * Query compilation and lint diagnostics returned by `runVaultQuery` and `plugin.query`.
 */
export interface QueryDiagnostics {
	/** Whether the engine config and query compiled without errors and was evaluated against the vault. */
	readonly executable: boolean;
	/** Query lexer, parser, validator, config, and linter findings. */
	readonly findings: SearchDiagnostic[];
}

/**
 * User-facing matched note metadata returned in `VaultQueryResult.matches`.
 */
export interface VaultQueryMatch {
	readonly file: NormalizedFileInfo;
	readonly aliases: string[];
	readonly tags: string[];
	readonly tagLocations: NormalizedTagLocation[];
	readonly headings: NormalizedHeading[];
	readonly links: NormalizedLink[];
	readonly embeds: NormalizedLink[];
	readonly blocks: string[];
	readonly properties: Record<string, unknown>;
}

/**
 * Result returned by `runVaultQuery` and `plugin.query`.
 */
export interface VaultQueryResult {
	/** Run-level environment context (frozen, JSON-safe POJO). */
	readonly context: VaultQueryContext;
	/** Query compilation and lint diagnostics. */
	readonly diagnostics: QueryDiagnostics;
	/** Matched Markdown notes in vault evaluation order. */
	readonly matches: VaultQueryMatch[];
}

/**
 * Projects a `NormalizedDocument` into a user-facing `VaultQueryMatch` POJO.
 */
export function toVaultQueryMatch(doc: NormalizedDocument): VaultQueryMatch {
	return {
		file: doc.file,
		aliases: doc.aliases,
		tags: doc.tags,
		tagLocations: doc.tagLocations,
		headings: doc.headings,
		links: doc.links,
		embeds: doc.embeds,
		blocks: doc.blocks,
		properties: doc.properties,
	};
}

/**
 * Exhaustive query and document diagnostic result returned by `diagnoseVaultQuery` and `plugin.diagnoseQuery`.
 */
export interface DiagnoseVaultQueryResult {
	/** Whether the query compiled without errors and was evaluated against the vault. */
	readonly executable: boolean;
	/** Vault-relative paths of all matching Markdown notes, in vault evaluation order. */
	readonly paths: string[];
	/** Full normalized metadata (`NormalizedDocument`) for each matching Markdown note. */
	readonly matches: NormalizedDocument[];
	/** Query lexer, parser, validator, config, and linter diagnostics. */
	readonly diagnostics: SearchDiagnostic[];
	/** Document property diagnostics for non-virtual property keys referenced by the query. */
	readonly propertyDiagnostics: DocumentDiagnostic[];
}

/**
 * Parses raw `.obsidian/types.json` content into a normalized `PropertyTypeRegistry`.
 *
 * @remarks
 * (obsidian-idiom, 2026-10-25) Obsidian's `types.json` stores `"aliases": "aliases"` and may
 * contain third-party widget types or mixed-case keys. Filtering unrecognized types, stripping
 * built-in keys handled by `resolveUserPropertyType`, and deduplicating case collisions prevents
 * `initEngineConfig` from rejecting the entire vault config.
 */
export function parseObsidianTypesJson(rawJson: string): PropertyTypeRegistry {
	const registry = Object.create(null) as PropertyTypeRegistry;
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return registry;
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return registry;
	}

	const typesObj = (parsed as Record<string, unknown>)['types'];
	if (typeof typesObj !== 'object' || typesObj === null || Array.isArray(typesObj)) {
		return registry;
	}

	for (const [rawKey, rawVal] of Object.entries(typesObj as Record<string, unknown>)) {
		const key = rawKey.trim().toLowerCase();
		if (
			!key ||
			FORBIDDEN_KEYS.has(key) ||
			FORBIDDEN_KEYS.has(rawKey) ||
			BUILTIN_PROPERTY_KEYS.has(key)
		) {
			continue;
		}
		if (!isValidPropertyType(rawVal)) {
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(registry, key)) {
			continue;
		}
		registry[key] = rawVal;
	}

	return registry;
}

async function loadVaultPropertyTypes(app: App): Promise<PropertyTypeRegistry> {
	const typesPath = normalizePath(`${app.vault.configDir}/types.json`);
	try {
		const raw = await app.vault.adapter.read(typesPath);
		return parseObsidianTypesJson(raw);
	} catch {
		return Object.create(null) as PropertyTypeRegistry;
	}
}

function resolveDefaultTimeZone(): string {
	try {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return typeof tz === 'string' && tz.trim() ? tz.trim() : 'UTC';
	} catch {
		return 'UTC';
	}
}

function mergePropertyTypes(
	vaultTypes: PropertyTypeRegistry,
	overrides?: PropertyTypeRegistry,
): PropertyTypeRegistry {
	if (overrides === undefined || typeof overrides !== 'object' || overrides === null) {
		return vaultTypes;
	}

	const shadowedKeys = new Set<string>();
	for (const rawKey of Object.keys(overrides)) {
		const normalizedKey = rawKey.trim().toLowerCase();
		if (normalizedKey && !FORBIDDEN_KEYS.has(normalizedKey) && !FORBIDDEN_KEYS.has(rawKey)) {
			shadowedKeys.add(normalizedKey);
		}
	}

	const merged = Object.create(null) as PropertyTypeRegistry;
	for (const [key, val] of Object.entries(vaultTypes)) {
		if (!shadowedKeys.has(key.trim().toLowerCase())) {
			merged[key] = val;
		}
	}
	for (const [rawKey, val] of Object.entries(overrides)) {
		const normalizedKey = rawKey.trim().toLowerCase();
		if (FORBIDDEN_KEYS.has(rawKey) || FORBIDDEN_KEYS.has(normalizedKey)) {
			continue;
		}
		merged[rawKey] = val;
	}

	return merged;
}

function sanitizeFallbackPropertyTypes(
	rawTypes: PropertyTypeRegistry,
): Readonly<PropertyTypeRegistry> {
	const fallback = Object.create(null) as PropertyTypeRegistry;
	for (const [rawKey, propType] of Object.entries(rawTypes)) {
		const key = rawKey.trim().toLowerCase();
		if (!key || FORBIDDEN_KEYS.has(key) || FORBIDDEN_KEYS.has(rawKey)) {
			continue;
		}
		if (!isValidPropertyType(propType)) {
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(fallback, key)) {
			continue;
		}
		fallback[key] = propType;
	}
	return Object.freeze(fallback);
}

/**
 * Compiles a search query, normalizes all Markdown notes in the vault, and evaluates the query.
 */
export async function runVaultQuery(
	app: App,
	input: string = '',
	options?: VaultQueryOptions,
): Promise<VaultQueryResult> {
	const timeZone = options?.timeZone !== undefined ? options.timeZone : resolveDefaultTimeZone();
	const rawRefTimeMs = options?.referenceTimeMs ?? Date.now();
	const validRefTimeMs = isValidReferenceTimeMs(rawRefTimeMs) ? rawRefTimeMs : null;

	const vaultTypes = await loadVaultPropertyTypes(app);
	const mergedTypes = mergePropertyTypes(vaultTypes, options?.propertyTypes);

	const configResult = initEngineConfig({
		timeZone,
		propertyTypes: mergedTypes,
	});
	if (!configResult.ok) {
		const context: VaultQueryContext = Object.freeze({
			timeZone: typeof timeZone === 'string' ? timeZone.trim() : '',
			referenceTimeMs: validRefTimeMs,
			propertyTypes: sanitizeFallbackPropertyTypes(mergedTypes),
		});
		return {
			context,
			diagnostics: {
				executable: false,
				findings: [...configResult.diagnostics],
			},
			matches: [],
		};
	}

	const context: VaultQueryContext = Object.freeze({
		timeZone: configResult.config.timeZone,
		referenceTimeMs: validRefTimeMs,
		propertyTypes: configResult.config.propertyTypes,
	});

	const compileResult = compileQuery(input, configResult.config, rawRefTimeMs);
	if (!compileResult.executable || !compileResult.prepared) {
		return {
			context,
			diagnostics: {
				executable: false,
				findings: compileResult.diagnostics,
			},
			matches: [],
		};
	}

	const resolveLinkPath: ResolveLinkPathFn = (rawTarget, sourcePath) =>
		app.metadataCache.getFirstLinkpathDest(rawTarget, sourcePath)?.path ?? null;

	const docs: NormalizedDocument[] = app.vault
		.getMarkdownFiles()
		.filter((file) => !(file as { deleted?: boolean }).deleted)
		.map((file) =>
			normalizeObsidianMetadata(
				file,
				app.metadataCache.getFileCache(file),
				configResult.config,
				[],
				resolveLinkPath,
			),
		);

	const report = evaluateVault(docs, compileResult.prepared);

	return {
		context,
		diagnostics: {
			executable: true,
			findings: compileResult.diagnostics,
		},
		matches: report.matches.map(toVaultQueryMatch),
	};
}

/**
 * Compiles a search query, evaluates it against the vault, and returns exhaustive query and document property diagnostics.
 */
export async function diagnoseVaultQuery(
	app: App,
	input: string = '',
	options?: VaultQueryOptions,
): Promise<DiagnoseVaultQueryResult> {
	const timeZone = options?.timeZone !== undefined ? options.timeZone : resolveDefaultTimeZone();
	const vaultTypes = await loadVaultPropertyTypes(app);
	const mergedTypes = mergePropertyTypes(vaultTypes, options?.propertyTypes);

	const configResult = initEngineConfig({
		timeZone,
		propertyTypes: mergedTypes,
	});
	if (!configResult.ok) {
		return {
			executable: false,
			paths: [],
			matches: [],
			diagnostics: [...configResult.diagnostics],
			propertyDiagnostics: [],
		};
	}

	const referenceTimeMs = options?.referenceTimeMs ?? Date.now();
	const compileResult = compileQuery(input, configResult.config, referenceTimeMs);
	if (!compileResult.executable || !compileResult.prepared) {
		return {
			executable: false,
			paths: [],
			matches: [],
			diagnostics: compileResult.diagnostics,
			propertyDiagnostics: [],
		};
	}

	const resolveLinkPath: ResolveLinkPathFn = (rawTarget, sourcePath) =>
		app.metadataCache.getFirstLinkpathDest(rawTarget, sourcePath)?.path ?? null;

	const docs: NormalizedDocument[] = app.vault
		.getMarkdownFiles()
		.filter((file) => !(file as { deleted?: boolean }).deleted)
		.map((file) =>
			normalizeObsidianMetadata(
				file,
				app.metadataCache.getFileCache(file),
				configResult.config,
				[],
				resolveLinkPath,
			),
		);

	const report = evaluateVault(docs, compileResult.prepared);

	return {
		executable: true,
		paths: report.matches.map((doc) => doc.file.path),
		matches: report.matches,
		diagnostics: compileResult.diagnostics,
		propertyDiagnostics: report.propertyDiagnostics,
	};
}
