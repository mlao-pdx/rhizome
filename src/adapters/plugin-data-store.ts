import type { RhizomeSettings } from '../settings';

/**
 * Owns the shape of `data.json` and is the only caller of
 * `Plugin.saveData` — keeping `main.ts` minimal per AGENTS.md. Constructed
 * with the plugin's bound `loadData`/`saveData` functions and the settings
 * defaults; owns no Obsidian import of its own beyond a type.
 */

/**
 * The full persisted shape of `data.json`.
 *
 * @remarks
 * (design, 2026-09-09) The shape is now just the user settings: the
 * `vaultInstanceId` key it once carried for database identity verification
 * is retired (see `docs/spec/decisions.md`, Rev 0.1). An old file with the
 * key still parses — read forgivingly — and the key is shed on the next
 * settings write.
 *
 * SUPERSEDED (design, 2026-09-01): `vaultInstanceId` lived under a
 * separate top-level key, not inside the user-settings object, so a
 * "restore defaults" or settings migration could never regenerate it.
 */
export interface PluginData {
	settings: RhizomeSettings;
}

export class PluginDataStore {
	private cached: PluginData | undefined;
	private readInFlight: Promise<PluginData> | undefined;

	/**
	 * Serializes every `data.json` write through one promise chain.
	 *
	 * @remarks
	 * (design, 2026-09-09) `saveData` rewrites the whole file, so two
	 * concurrent saves would each start from the same stale in-memory copy
	 * and the loser's changes would vanish; the queue makes later writes
	 * observe earlier ones. Mirrors the `writeQueue` precedent in
	 * `obsidian-logger-adapter.ts`, except failures propagate to the
	 * awaiting caller (a rejected write must be visible, not swallowed)
	 * while the chain itself stays alive for subsequent writes.
	 *
	 * SUPERSEDED (design, 2026-09-01): the queue originally also kept an
	 * unserialized settings save and an identity mint from clobbering each
	 * other; the mint is gone, but whole-file rewrites still race.
	 */
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly loadData: () => Promise<unknown>,
		private readonly saveData: (data: PluginData) => Promise<void>,
		private readonly defaultSettings: RhizomeSettings,
	) {}

	/** Reads `data.json` (once, then cached) and returns the merged settings. */
	async loadSettings(): Promise<RhizomeSettings> {
		const data = await this.read();
		return data.settings;
	}

	/** Persists the full settings object through the serialized write queue. */
	saveSettings(settings: RhizomeSettings): Promise<void> {
		return this.enqueueWrite((data) => ({ ...data, settings }));
	}

	private read(): Promise<PluginData> {
		if (this.cached !== undefined) {
			return Promise.resolve(this.cached);
		}
		this.readInFlight ??= (async () => {
			try {
				const raw = await this.loadData();
				this.cached = parsePluginData(raw, this.defaultSettings);
				return this.cached;
			} finally {
				this.readInFlight = undefined;
			}
		})();
		return this.readInFlight;
	}

	private enqueueWrite(mutate: (data: PluginData) => PluginData): Promise<void> {
		const task = this.writeQueue.then(async () => {
			const current = await this.read();
			const next = mutate(current);
			await this.saveData(next);
			this.cached = next;
		});
		// A failed write rejects the caller's promise but must not poison
		// the chain for subsequent writes.
		this.writeQueue = task.catch(() => undefined);
		return task;
	}
}

/**
 * Forgiving read (design principle 6): an object without a `settings` key
 * is treated as the legacy flat settings shape rather than discarded, and
 * unknown or retired top-level keys (e.g. a legacy `vaultInstanceId`) are
 * ignored — shed on the next write rather than preserved.
 */
function parsePluginData(raw: unknown, defaults: RhizomeSettings): PluginData {
	if (raw !== null && typeof raw === 'object' && 'settings' in raw) {
		const obj = raw as { settings?: unknown };
		return { settings: mergeSettings(defaults, obj.settings) };
	}
	return { settings: mergeSettings(defaults, raw) };
}

function mergeSettings(defaults: RhizomeSettings, raw: unknown): RhizomeSettings {
	if (raw === null || typeof raw !== 'object') {
		return { ...defaults };
	}
	return { ...defaults, ...(raw as Partial<RhizomeSettings>) };
}
