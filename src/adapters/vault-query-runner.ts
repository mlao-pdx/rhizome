import { type App, normalizePath } from 'obsidian';
import {
	compileQuery,
	type DocumentDiagnostic,
	evaluateVault,
	FORBIDDEN_KEYS,
	initEngineConfig,
	isValidPropertyType,
	type NormalizedDocument,
	normalizeObsidianMetadata,
	type PropertyTypeRegistry,
	type ResolveLinkPathFn,
	type SearchDiagnostic,
} from '@core/search';

const BUILTIN_PROPERTY_KEYS: ReadonlySet<string> = new Set(['alias', 'aliases', 'tag', 'tags']);

/**
 * Options for running a vault query via `runVaultQuery` or `plugin.query`.
 */
export interface VaultQueryOptions {
	/** Optional IANA timezone override (defaults to system timezone, falling back to 'UTC'). */
	readonly timeZone?: string;
	/** Optional property-type overrides merged on top of `.obsidian/types.json`. */
	readonly propertyTypes?: PropertyTypeRegistry;
	/** Optional reference timestamp in UTC epoch ms for `@` relative date anchors (defaults to `Date.now()`). */
	readonly referenceTimeMs?: number;
}

/**
 * Result returned by `runVaultQuery` and `plugin.query`.
 */
export interface VaultQueryResult {
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

/**
 * Compiles a search query, normalizes all Markdown notes in the vault, and evaluates the query.
 */
export async function runVaultQuery(
	app: App,
	input: string = '',
	options?: VaultQueryOptions,
): Promise<VaultQueryResult> {
	const timeZone = options?.timeZone !== undefined ? options.timeZone : resolveDefaultTimeZone();
	const vaultTypes = await loadVaultPropertyTypes(app);
	const mergedTypes: PropertyTypeRegistry =
		options?.propertyTypes !== undefined
			? { ...vaultTypes, ...options.propertyTypes }
			: vaultTypes;

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
