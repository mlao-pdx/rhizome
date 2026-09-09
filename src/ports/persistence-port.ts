/**
 * `PersistencePort` — repository interface for the project's
 * IndexedDB-backed persistence. Core code depends on this port; the
 * Dexie-backed adapter (`src/adapters/dexie-persistence-adapter.ts`)
 * implements it, and nothing talks to raw IndexedDB directly. Replace
 * `ExampleRecord` with the record shapes your plugin actually persists —
 * see the `dexie-persistence-adapter` skill for the adapter-side schema
 * and transaction patterns. A plugin that persists nothing can delete
 * this port together with the `dexie` dependency and the adapter wiring
 * in `src/main.ts`.
 *
 * @see docs/dev/indexeddb-database-identity.md
 * @remarks
 * Shape, not contract: no implementation lives here. See
 * `src/ports/README.md` for why this interface has no `dexie` import.
 * Lifecycle (open/close) is deliberately not part of this interface — it
 * is a storage concern owned by the adapter, so it cannot leak into a
 * domain-shaped contract.
 */

/**
 * The project's single domain-neutral example record. Replace it with the
 * record shapes the plugin actually persists.
 */
export interface ExampleRecord {
	readonly id: number;
	readonly value: string;
}

/**
 * Technology-agnostic persistence over rebuildable derived cache. Every
 * method returns a promise and may reject — implementations must not
 * swallow storage errors, because a data contract cannot invent the
 * caller's recovery policy.
 *
 * @see docs/dev/indexeddb-database-identity.md
 * @remarks
 * (design, 2026-09-01) Everything persisted through this port is a
 * rebuildable derived cache, never a source of truth (design principle 3:
 * vault is truth). Anything that must survive an IndexedDB wipe belongs in
 * vault files or `data.json`. Backing storage is opened lazily on first
 * use, so constructing an adapter performs no I/O.
 */
export interface PersistencePort {
	/** Resolves the record for `id`, or `undefined` when absent. */
	get(id: number): Promise<ExampleRecord | undefined>;

	/** Inserts or overwrites the record under its own `id`. */
	put(record: ExampleRecord): Promise<void>;

	/** Removes the record for `id`. Absent ids are not an error. */
	delete(id: number): Promise<void>;

	/**
	 * Inserts or overwrites every record atomically: either all records
	 * land or none do.
	 */
	putMany(records: readonly ExampleRecord[]): Promise<void>;

	/**
	 * Removes every persisted record.
	 *
	 * @remarks
	 * (design, 2026-09-09) Empties everything the implementation persists:
	 * the store keeps no bookkeeping record of its own anymore (the
	 * database identity record is retired — see
	 * `docs/dev/indexeddb-database-identity.md` and
	 * `docs/spec/decisions.md`, Rev 0.1), so nothing survives `clear()`
	 * and the store cannot invalidate itself by being emptied.
	 *
	 * SUPERSEDED (design, 2026-09-01): `clear()` used to preserve a
	 * singleton identity record the next bootstrap verified against.
	 */
	clear(): Promise<void>;
}
