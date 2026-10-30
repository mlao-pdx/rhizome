import { type App, normalizePath } from 'obsidian';
import {
	type CompileResult,
	type DocumentDiagnostic,
	FORBIDDEN_KEYS,
	isValidPropertyType,
	type PropertyTypeRegistry,
	type SearchDiagnostic,
} from '@core/search';
import type { LoggerPort } from '@ports/logger-port';
import { markSensitive } from './logger-format';

const BUILTIN_PROPERTY_KEYS: ReadonlySet<string> = new Set(['alias', 'aliases', 'tag', 'tags']);
const MAX_SAMPLE_FILES = 5;

export interface ParsedTypesJsonResult {
	readonly registry: PropertyTypeRegistry;
	readonly malformedReason: string | null;
	readonly validCount: number;
	readonly unsupportedCount: number;
	readonly collisionCount: number;
}

/**
 * Inspects and parses raw `.obsidian/types.json` content into a normalized
 * `PropertyTypeRegistry` along with diagnostic counts for logging.
 */
export function inspectObsidianTypesJson(rawJson: string): ParsedTypesJsonResult {
	const registry = Object.create(null) as PropertyTypeRegistry;
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return {
			registry,
			malformedReason: 'invalid_json',
			validCount: 0,
			unsupportedCount: 0,
			collisionCount: 0,
		};
	}

	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return {
			registry,
			malformedReason: 'invalid_root',
			validCount: 0,
			unsupportedCount: 0,
			collisionCount: 0,
		};
	}

	const typesObj = (parsed as Record<string, unknown>)['types'];
	if (typeof typesObj !== 'object' || typesObj === null || Array.isArray(typesObj)) {
		return {
			registry,
			malformedReason: 'invalid_types_object',
			validCount: 0,
			unsupportedCount: 0,
			collisionCount: 0,
		};
	}

	let validCount = 0;
	let unsupportedCount = 0;
	let collisionCount = 0;

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
			unsupportedCount++;
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(registry, key)) {
			collisionCount++;
			continue;
		}
		registry[key] = rawVal;
		validCount++;
	}

	return {
		registry,
		malformedReason: null,
		validCount,
		unsupportedCount,
		collisionCount,
	};
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
	return inspectObsidianTypesJson(rawJson).registry;
}

/**
 * Reads `.obsidian/types.json` from the vault adapter, returning a null-prototype
 * `PropertyTypeRegistry` and logging parse/filtering diagnostics when `logger` is provided.
 */
export async function loadVaultPropertyTypes(
	app: App,
	logger?: LoggerPort,
): Promise<PropertyTypeRegistry> {
	const typesPath = normalizePath(`${app.vault.configDir}/types.json`);
	let raw: string;
	try {
		raw = await app.vault.adapter.read(typesPath);
	} catch {
		return Object.create(null) as PropertyTypeRegistry;
	}

	const inspected = inspectObsidianTypesJson(raw);
	if (inspected.malformedReason !== null) {
		logger?.log(
			'warn',
			`Failed to parse vault property types from ${markSensitive(typesPath)}`,
			{
				source: 'query.types',
				reason: inspected.malformedReason,
			},
		);
		return inspected.registry;
	}

	if (inspected.unsupportedCount > 0 || inspected.collisionCount > 0) {
		logger?.log(
			'debug',
			`Filtered unsupported or colliding property types in ${markSensitive(typesPath)}`,
			{
				source: 'query.types',
				count: inspected.validCount,
				validCount: inspected.validCount,
				unsupportedCount: inspected.unsupportedCount,
				collisionCount: inspected.collisionCount,
			},
		);
	}

	return inspected.registry;
}

export function logEngineConfigFailure(
	logger: LoggerPort | undefined,
	timeZone: unknown,
	diagnostics: readonly SearchDiagnostic[],
): void {
	logger?.log('error', 'Query engine configuration failed', {
		source: 'query.config',
		timeZone: markSensitive(timeZone),
		codes: diagnostics.map((d) => d.code),
		count: diagnostics.length,
	});
}

export function logQueryCompilation(
	logger: LoggerPort | undefined,
	name: string,
	rawInput: string,
	compileResult: CompileResult,
): void {
	if (!logger) {
		return;
	}
	const errorCodes = new Set<string>();
	const warningCodes = new Set<string>();
	const hintCodes = new Set<string>();
	for (const d of compileResult.diagnostics) {
		if (d.severity === 'error') {
			errorCodes.add(d.code);
		} else if (d.severity === 'warning') {
			warningCodes.add(d.code);
		} else {
			hintCodes.add(d.code);
		}
	}

	if (!compileResult.executable || warningCodes.size > 0) {
		logger.log('warn', `Query compilation diagnostics for ${markSensitive(name)}`, {
			source: 'query.compile',
			count: compileResult.diagnostics.length,
			query: markSensitive(rawInput),
			executable: compileResult.executable,
			errorCodes: [...errorCodes],
			warningCodes: [...warningCodes],
			hintCodes: [...hintCodes],
		});
	} else {
		logger.log('debug', `Compiled query ${markSensitive(name)}`, {
			source: 'query.compile',
			count: compileResult.diagnostics.length,
			query: markSensitive(rawInput),
			executable: true,
			hintCodes: [...hintCodes],
		});
	}
}

export class QueriedPropertyDiagnosticsAggregator {
	diagnosticCount = 0;
	affectedNotes = 0;
	private readonly codes = new Set<string>();
	private readonly keys = new Set<string>();
	private readonly sampleFiles: string[] = [];

	constructor(private readonly queriedKeys: ReadonlySet<string>) {}

	recordNote(filePath: string, diagnostics: readonly DocumentDiagnostic[]): void {
		if (diagnostics.length === 0 || this.queriedKeys.size === 0) {
			return;
		}
		let noteAffected = false;
		for (const d of diagnostics) {
			if (!this.queriedKeys.has(d.propertyKey.toLowerCase())) {
				continue;
			}
			noteAffected = true;
			this.diagnosticCount++;
			this.codes.add(d.code);
			this.keys.add(markSensitive(d.propertyKey));
		}
		if (noteAffected) {
			this.affectedNotes++;
			if (this.sampleFiles.length < MAX_SAMPLE_FILES) {
				this.sampleFiles.push(markSensitive(filePath));
			}
		}
	}

	flush(logger: LoggerPort | undefined): void {
		if (!logger || this.diagnosticCount === 0) {
			return;
		}
		logger.log('warn', 'Encountered invalid property values on queried keys', {
			source: 'query.run',
			count: this.diagnosticCount,
			diagnosticCount: this.diagnosticCount,
			affectedNotes: this.affectedNotes,
			codes: [...this.codes],
			keys: [...this.keys],
			sampleFiles: this.sampleFiles,
		});
	}
}
