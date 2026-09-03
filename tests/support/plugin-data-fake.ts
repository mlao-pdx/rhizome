/**
 * Minimal in-memory stand-in for the `Plugin.loadData`/`Plugin.saveData`
 * pair that `PluginDataStore` (`src/adapters/plugin-data-store.ts`) is
 * constructed with.
 *
 * Grow this only as the data store grows — see `mock-obsidian-app.ts`'s
 * header for the same policy.
 */
export interface InMemoryPluginData {
	/** Every object passed to `saveData`, in write order. */
	readonly writes: unknown[];
	/**
	 * Declared as function properties, not methods: `PluginDataStore`
	 * consumes them as detached callbacks, so they must not depend on a
	 * receiver `this`.
	 */
	loadData: () => Promise<unknown>;
	saveData: (data: unknown) => Promise<void>;
}

/**
 * Creates the fake. `initial` is what the first `loadData()` resolves
 * before any write; each `saveData` replaces it (and records the write).
 */
export function createInMemoryPluginData(initial?: unknown): InMemoryPluginData {
	let current: unknown = initial;
	const writes: unknown[] = [];
	return {
		writes,
		async loadData() {
			return current;
		},
		async saveData(data: unknown) {
			current = data;
			writes.push(data);
		},
	};
}
