import { BUILT_IN_SCOPES } from './scopes';
import {
	isValidPropertyType,
	type ConfigResult,
	type EngineConfig,
	type ObsidianPropertyType,
	type PropertyTypeRegistry,
	type ResolvedEngineConfig,
	type ScopeDefinition,
	type SearchDiagnostic,
} from './types';

const VALID_SCOPE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const RESERVED_KEYWORDS = new Set(['and', 'or', 'not']);

export function initEngineConfig(
	rawConfig: EngineConfig = { timeZone: 'UTC', propertyTypes: {} },
): ConfigResult {
	const diagnostics: SearchDiagnostic[] = [];
	const tz = typeof rawConfig.timeZone === 'string' ? rawConfig.timeZone.trim() : '';

	try {
		if (!tz) throw new RangeError('Empty timeZone');
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
	} catch {
		diagnostics.push({
			code: 'ERROR_INVALID_CONFIG',
			severity: 'error',
			issue: `Invalid IANA timeZone: "${rawConfig.timeZone}".`,
			hint: 'Provide a valid IANA timeZone such as "UTC" or "America/New_York".',
			span: null,
		});
	}

	const normalizedTypes = Object.create(null) as PropertyTypeRegistry;
	for (const [rawKey, propType] of Object.entries(rawConfig.propertyTypes ?? {})) {
		const key = rawKey.trim().toLowerCase();
		if (!key) continue;
		if (!isValidPropertyType(propType)) {
			diagnostics.push({
				code: 'ERROR_INVALID_CONFIG',
				severity: 'error',
				issue: `Unsupported ObsidianPropertyType "${String(propType)}" for key "${rawKey}".`,
				hint: 'Allowed types: text, multitext, number, checkbox, date, datetime, tags.',
				span: null,
			});
			continue;
		}
		if (
			Object.prototype.hasOwnProperty.call(normalizedTypes, key) &&
			normalizedTypes[key] !== propType
		) {
			diagnostics.push({
				code: 'ERROR_INVALID_CONFIG',
				severity: 'error',
				issue: `Conflicting property types for normalized key "${key}": "${normalizedTypes[key]}" vs "${propType}".`,
				hint: `Assign a single consistent type to "${key}".`,
				span: null,
			});
			continue;
		}
		normalizedTypes[key] = propType;
	}

	const privateScopeMap = new Map<string, ScopeDefinition>();
	const seenSourceDefs = new Set<ScopeDefinition>();

	const registerDef = (def: ScopeDefinition, isCustom: boolean): void => {
		if (seenSourceDefs.has(def)) return;
		seenSourceDefs.add(def);

		const trimmedCanon = def.canonicalName.trim();
		const dedupedNames = Array.from(
			new Set<string>([
				trimmedCanon.toLowerCase(),
				...def.aliases.map((a) => a.trim().toLowerCase()),
			]),
		);

		const frozenClone: ScopeDefinition = Object.freeze({
			canonicalName: trimmedCanon,
			aliases: Object.freeze(dedupedNames),
			extract: def.extract,
			matchString: def.matchString,
		});

		for (const name of dedupedNames) {
			if (isCustom && (!VALID_SCOPE_NAME_RE.test(name) || RESERVED_KEYWORDS.has(name))) {
				diagnostics.push({
					code: 'ERROR_INVALID_CONFIG',
					severity: 'error',
					issue: `Invalid custom scope name or alias "${name}".`,
					hint: 'Scope names must match /^[a-zA-Z][a-zA-Z0-9_-]*$/ and cannot be AND, OR, or NOT.',
					span: null,
				});
				continue;
			}
			const existing = privateScopeMap.get(name);
			if (existing && existing !== frozenClone) {
				diagnostics.push({
					code: 'ERROR_INVALID_CONFIG',
					severity: 'error',
					issue: `Scope name "${name}" collides with existing scope "${existing.canonicalName}".`,
					hint: `Choose a unique canonical name and alias list for "${trimmedCanon}".`,
					span: null,
				});
				continue;
			}
			privateScopeMap.set(name, frozenClone);
		}
	};

	for (const builtIn of BUILT_IN_SCOPES) registerDef(builtIn, false);
	for (const custom of rawConfig.customScopes ?? []) registerDef(custom, true);

	if (diagnostics.length > 0) {
		return { ok: false, config: null, diagnostics: Object.freeze(diagnostics) };
	}

	const frozenTypes = Object.freeze(normalizedTypes);
	const allNames = Object.freeze(Array.from(privateScopeMap.keys()));
	const sortedTypePairs: Array<[string, ObsidianPropertyType]> = Object.keys(frozenTypes)
		.sort()
		.map((k) => [k, frozenTypes[k]!]);
	const normalizationFingerprint = JSON.stringify({ tz, types: sortedTypePairs });

	const resolved: ResolvedEngineConfig = Object.freeze({
		__brand: 'ResolvedEngineConfig' as const,
		timeZone: tz,
		propertyTypes: frozenTypes,
		normalizationFingerprint,
		getScope: (nameOrAlias: string) => privateScopeMap.get(nameOrAlias.trim().toLowerCase()),
		getAllScopeNames: () => allNames,
	});

	return { ok: true, config: resolved, diagnostics: Object.freeze([]) };
}
