import type { MyPluginSettings } from '../settings';
import { isValidVaultInstanceId, mintVaultInstanceId } from './database-identity';

/**
 * Owns the shape of `data.json` and is the only caller of
 * `Plugin.saveData` — keeping `main.ts` minimal per AGENTS.md. Constructed
 * with the plugin's bound `loadData`/`saveData` functions and the settings
 * defaults; owns no Obsidian import of its own beyond a type.
 */

/**
 * The full persisted shape of `data.json`. `vaultInstanceId` lives under a
 * separate top-level key, not inside the user-settings object, so a
 * "restore defaults" or settings migration can never regenerate it.
 *
 * @see docs/dev/indexeddb-database-identity.md
 */
export interface PluginData {
	settings: MyPluginSettings;
	vaultInstanceId?: string;
}

export class PluginDataStore {
	private cached: PluginData | undefined;
	private readInFlight: Promise<PluginData> | undefined;
	private ensureInFlight: Promise<string> | undefined;

	/**
	 * Serializes every `data.json` write through one promise chain.
	 *
	 * @remarks
	 * (design, 2026-09-01) `saveData` rewrites the whole file, so an
	 * unserialized settings save and identity mint can clobber each other.
	 * Mirrors the `writeQueue` precedent in `obsidian-logger-adapter.ts`,
	 * except failures propagate to the awaiting caller (a rejected write
	 * must be visible, not swallowed) while the chain itself stays alive
	 * for subsequent writes.
	 */
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly loadData: () => Promise<unknown>,
		private readonly saveData: (data: PluginData) => Promise<void>,
		private readonly defaultSettings: MyPluginSettings,
	) {}

	/** Reads `data.json` (once, then cached) and returns the merged settings. */
	async loadSettings(): Promise<MyPluginSettings> {
		const data = await this.read();
		return data.settings;
	}

	/** Persists the full settings object through the serialized write queue. */
	saveSettings(settings: MyPluginSettings): Promise<void> {
		return this.enqueueWrite((data) => ({ ...data, settings }));
	}

	/**
	 * Returns a valid stored `vaultInstanceId`, or mints one, persists it,
	 * and returns it.
	 *
	 * @remarks
	 * (design, 2026-09-01) The in-flight promise is memoized so concurrent
	 * first calls mint exactly once, and cleared on settlement so a failed
	 * mint can be retried. Persistence happens **before** the promise
	 * resolves: the authoritative identity must be durable before any
	 * database work (see `docs/dev/indexeddb-database-identity.md`).
	 */
	ensureVaultInstanceId(): Promise<string> {
		this.ensureInFlight ??= this.ensureVaultInstanceIdOnce().finally(() => {
			this.ensureInFlight = undefined;
		});
		return this.ensureInFlight;
	}

	private async ensureVaultInstanceIdOnce(): Promise<string> {
		const data = await this.read();
		if (isValidVaultInstanceId(data.vaultInstanceId)) {
			return data.vaultInstanceId;
		}
		const minted = mintVaultInstanceId();
		await this.enqueueWrite((current) => ({ ...current, vaultInstanceId: minted }));
		return minted;
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
 * is treated as the legacy flat settings shape rather than discarded.
 */
function parsePluginData(raw: unknown, defaults: MyPluginSettings): PluginData {
	if (raw !== null && typeof raw === 'object' && 'settings' in raw) {
		const obj = raw as { settings?: unknown; vaultInstanceId?: unknown };
		const data: PluginData = { settings: mergeSettings(defaults, obj.settings) };
		if (isValidVaultInstanceId(obj.vaultInstanceId)) {
			data.vaultInstanceId = obj.vaultInstanceId;
		}
		return data;
	}
	return { settings: mergeSettings(defaults, raw) };
}

function mergeSettings(defaults: MyPluginSettings, raw: unknown): MyPluginSettings {
	if (raw === null || typeof raw !== 'object') {
		return { ...defaults };
	}
	return { ...defaults, ...(raw as Partial<MyPluginSettings>) };
}
