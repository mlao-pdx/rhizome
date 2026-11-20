import type { App } from 'obsidian';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type PersistedRenderSentinelRecord,
	RENDER_SENTINEL_STORE_NAME,
	RenderSentinelIdbStore,
} from '../../src/adapters/render-sentinel-idb';
import {
	computeCodeBlockSentinelHash,
	PROBATION_SCALE_FACTOR,
	RenderSentinelStore,
} from '../../src/adapters/render-sentinel-store';
import { assertProperty } from '../support/assertProperty';

function createInMemoryIdbFactory() {
	const stores = new Map<string, PersistedRenderSentinelRecord>();
	const factory = {
		open(_name: string, _version = 1): IDBOpenDBRequest {
			const req: Record<string, unknown> = {
				result: null,
				error: null,
				onupgradeneeded: null,
				onsuccess: null,
				onerror: null,
				onblocked: null,
			};
			queueMicrotask(() => {
				req.result = {
					objectStoreNames: { contains: () => true },
					deleteObjectStore: () => {},
					createObjectStore: () => ({}),
					transaction: () => {
						const tx: Record<string, unknown> = {
							oncomplete: null,
							onerror: null,
							onabort: null,
							objectStore: () => ({
								getAll: () => {
									const getReq: Record<string, unknown> = {
										result: [...stores.values()],
										onsuccess: null,
										onerror: null,
									};
									queueMicrotask(() => {
										(getReq.onsuccess as (() => void) | null)?.();
									});
									return getReq;
								},
								put: (rec: PersistedRenderSentinelRecord) => {
									stores.set(rec.hash, { ...rec });
								},
								delete: (key: string) => {
									stores.delete(key);
								},
								clear: () => {
									stores.clear();
								},
							}),
						};
						queueMicrotask(() => {
							(tx.oncomplete as (() => void) | null)?.();
						});
						return tx;
					},
					close: () => {},
					onversionchange: null,
				};
				(req.onsuccess as (() => void) | null)?.();
			});
			return req as unknown as IDBOpenDBRequest;
		},
		deleteDatabase(): IDBOpenDBRequest {
			stores.clear();
			const req: Record<string, unknown> = { onsuccess: null };
			queueMicrotask(() => {
				(req.onsuccess as (() => void) | null)?.();
			});
			return req as unknown as IDBOpenDBRequest;
		},
		raw: stores,
	};
	return factory;
}

const fakeApp = { appId: 'prop-vault' } as unknown as App;

describe('RenderSentinelStore & Sentinel Hash Property Invariants', () => {
	it('computeCodeBlockSentinelHash is deterministic, partial-order invariant, and mutation-sensitive', async () => {
		const partialPairsArb = fc.uniqueArray(
			fc.tuple(
				fc.string({ minLength: 1, maxLength: 30 }),
				fc.string({ minLength: 0, maxLength: 80 }),
			),
			{ selector: ([k]) => k, maxLength: 8 },
		);

		await assertProperty(
			'sentinel/hash__order-invariance-and-mutation-sensitivity',
			fc.property(
				fc.string({ maxLength: 40 }),
				fc.string({ maxLength: 120 }),
				partialPairsArb,
				(sourcePath, source, pairs) => {
					const mapForward = new Map(pairs);
					const mapReversed = new Map([...pairs].reverse());

					const h1 = computeCodeBlockSentinelHash(sourcePath, source, mapForward);
					const h2 = computeCodeBlockSentinelHash(sourcePath, source, mapReversed);
					expect(h1).toBe(h2);
					expect(h1).toMatch(/^[0-9a-f]{16}$/);

					// Mutating sourcePath or source by 1 char alters the digest
					expect(
						computeCodeBlockSentinelHash(`${sourcePath}!`, source, mapForward),
					).not.toBe(h1);
					expect(
						computeCodeBlockSentinelHash(sourcePath, `${source}!`, mapForward),
					).not.toBe(h1);

					if (pairs.length > 0) {
						const mutated = new Map(pairs);
						const [firstKey, firstVal] = pairs[0]!;
						mutated.set(firstKey, `${firstVal}!`);
						expect(computeCodeBlockSentinelHash(sourcePath, source, mutated)).not.toBe(
							h1,
						);
					}
				},
			),
		);
	});

	it('State-machine crash bound invariant across arbitrary runs, aborts, restarts, and retries', async () => {
		type Action =
			| { readonly kind: 'succeed'; readonly chars: number; readonly lines: number }
			| { readonly kind: 'abort'; readonly chars: number; readonly lines: number }
			| { readonly kind: 'crash'; readonly chars: number; readonly lines: number }
			| { readonly kind: 'retry' };

		const actionArb: fc.Arbitrary<Action> = fc.oneof(
			fc.record({
				kind: fc.constant('succeed' as const),
				chars: fc.integer({ min: 70_000, max: 500_000 }),
				lines: fc.integer({ min: 5_000, max: 20_000 }),
			}),
			fc.record({
				kind: fc.constant('abort' as const),
				chars: fc.integer({ min: 70_000, max: 500_000 }),
				lines: fc.integer({ min: 5_000, max: 20_000 }),
			}),
			fc.record({
				kind: fc.constant('crash' as const),
				chars: fc.integer({ min: 70_000, max: 900_000 }),
				lines: fc.integer({ min: 5_000, max: 40_000 }),
			}),
			fc.constant({ kind: 'retry' as const }),
		);

		await assertProperty(
			'sentinel/store__state-machine-crash-bounds',
			fc.asyncProperty(
				fc.array(actionArb, { minLength: 1, maxLength: 20 }),
				async (steps) => {
					const idbFactory = createInMemoryIdbFactory();
					let sessionSeq = 1;
					let clock = 1_000;
					const hash = RENDER_SENTINEL_STORE_NAME;

					const openSession = async () => {
						const s = new RenderSentinelStore(fakeApp, undefined, {
							idbStore: new RenderSentinelIdbStore(
								'rhizome-sentinels-prop',
								idbFactory as unknown as IDBFactory,
							),
							sessionId: `sess-${sessionSeq++}`,
							nowFn: () => {
								clock += 100;
								return clock;
							},
						});
						await s.hydrate();
						return s;
					};

					let store = await openSession();
					let consecutiveCrashes = 0;

					for (const step of steps) {
						if (store.getQuarantined(hash)) {
							if (step.kind === 'retry') {
								await store.promoteToProbation(hash);
								consecutiveCrashes = 0;
								expect(store.getRecord(hash)?.status).toBe('probation');
							}
							continue;
						}

						if (step.kind === 'retry') {
							continue;
						}

						const preRunRecord = store.getRecord(hash);

						if (step.kind === 'succeed') {
							await store.markRunning(hash, {
								records: step.lines,
								outputChars: step.chars,
								outputLines: step.lines,
							});
							await store.finishRunning(hash, {
								committed: true,
								durationMs: 50,
								stats: {
									records: step.lines,
									outputChars: step.chars,
									outputLines: step.lines,
								},
							});
							consecutiveCrashes = 0;
							expect(store.getRecord(hash)?.status).toBe('ok');
						} else if (step.kind === 'abort') {
							await store.markRunning(hash, {
								records: step.lines,
								outputChars: step.chars,
								outputLines: step.lines,
							});
							await store.finishRunning(hash, { committed: false });
							// Clean abort followed by app restart must NEVER quarantine
							store = await openSession();
							expect(store.getQuarantined(hash)).toBeUndefined();
						} else if (step.kind === 'crash') {
							const lastOkDuration = preRunRecord?.lastOkDurationMs ?? null;
							const lastOkChars = preRunRecord?.lastOkChars ?? null;
							const lastOkLines = preRunRecord?.lastOkLines ?? null;
							const withinScale =
								lastOkDuration !== null &&
								lastOkChars !== null &&
								lastOkLines !== null &&
								step.chars <= lastOkChars * PROBATION_SCALE_FACTOR &&
								step.lines <= lastOkLines * PROBATION_SCALE_FACTOR;

							await store.markRunning(hash, {
								records: step.lines,
								outputChars: step.chars,
								outputLines: step.lines,
							});
							consecutiveCrashes += 1;

							// Simulate process crash + next session startup
							store = await openSession();

							if (!withinScale || consecutiveCrashes >= 2) {
								expect(store.getQuarantined(hash)?.status).toBe('quarantined');
							} else {
								expect(store.getRecord(hash)?.status).toBe('probation');
								expect(store.getQuarantined(hash)).toBeUndefined();
							}
						}
					}
				},
			),
			{ numRuns: 60 },
		);
	});
});
