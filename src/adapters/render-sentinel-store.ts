import type { App } from 'obsidian';
import { XxHash64Accumulator } from '@core/hash/xxhash64';
import type { RhizomeCodeBlockFlavor } from '@core/templates';
import type { LoggerPort } from '@ports/logger-port';
import {
	type PersistedRenderSentinelRecord,
	RenderSentinelIdbStore,
	type RenderSentinelStatus,
} from './render-sentinel-idb';

export const SENTINEL_CHAR_THRESHOLD = 65_536;
export const SENTINEL_LINE_THRESHOLD = 5_000;
export const PROBATION_SCALE_FACTOR = 1.5;
export const SENTINEL_OK_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_SENTINEL_RECORDS = 256;

export interface SentinelRunStats {
	readonly records: number;
	readonly outputChars: number;
	readonly outputLines: number;
}

export type SentinelFinishOutcome =
	| {
			readonly committed: true;
			readonly durationMs: number;
			readonly stats: SentinelRunStats;
	  }
	| {
			readonly committed: false;
	  };

interface ActiveSentinelRun {
	count: number;
	baseline: PersistedRenderSentinelRecord | undefined;
	writePromise: Promise<void>;
	committedOutcome: {
		readonly durationMs: number;
		readonly stats: SentinelRunStats;
	} | null;
}

function resolveSentinelDbName(app: App): string {
	const rawAppId = (app as { appId?: unknown }).appId;
	const suffix =
		typeof rawAppId === 'string' && rawAppId.trim().length > 0 ? rawAppId.trim() : 'default';
	return `rhizome-sentinels-${suffix}`;
}

function mintSessionId(): string {
	if (typeof crypto === 'object' && crypto !== null && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function isValidStatus(val: unknown): val is RenderSentinelStatus {
	return val === 'running' || val === 'ok' || val === 'probation' || val === 'quarantined';
}

function isValidSentinelRecord(rec: unknown): rec is PersistedRenderSentinelRecord {
	if (!rec || typeof rec !== 'object') return false;
	const r = rec as Partial<PersistedRenderSentinelRecord>;
	return (
		typeof r.hash === 'string' &&
		r.hash.length > 0 &&
		isValidStatus(r.status) &&
		typeof r.sessionId === 'string' &&
		typeof r.records === 'number' &&
		typeof r.outputChars === 'number' &&
		typeof r.outputLines === 'number' &&
		typeof r.updatedAt === 'number'
	);
}

function evictionTier(status: RenderSentinelStatus): number {
	if (status === 'ok') return 0;
	if (status === 'probation') return 1;
	if (status === 'quarantined') return 2;
	return 3;
}

/**
 * Computes a deterministic 64-bit hex digest identifying a Rhizome codeblock's fence `flavor`,
 * host path, inline template source, and referenced partial/layout file contents without
 * persisting vault text or note paths in IndexedDB.
 */
export function computeCodeBlockSentinelHash(
	sourcePath: string,
	source: string,
	fileSources: ReadonlyMap<string, string>,
	flavor: RhizomeCodeBlockFlavor = 'rhizome',
): string {
	const acc = new XxHash64Accumulator();
	acc.updateTag(0x53, 2);
	acc.updateString(flavor);
	acc.updateString(sourcePath);
	acc.updateString(source);
	const entries = [...fileSources.entries()].sort((a, b) =>
		a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
	);
	acc.updateTag(0x54, entries.length);
	for (const [path, content] of entries) {
		acc.updateString(path);
		acc.updateString(content);
	}
	return acc.digest().hex;
}

/**
 * Session-scoped crash sentinel coordinator backed by `RenderSentinelIdbStore`.
 *
 * @remarks
 * (design, 2026-11-20) Reconciles orphaned `'running'` records from prior terminated
 * sessions once during startup `hydrate()`, granting a single `'probation'` retry (with
 * wiped `lastOk*` baselines) only when the block previously succeeded at comparable scale
 * (`<= 1.5x` chars and lines) and quarantining untested or exploded blocks immediately.
 */
export class RenderSentinelStore {
	readonly sessionId: string;
	private readonly logger: LoggerPort | undefined;
	private readonly idb: RenderSentinelIdbStore;
	private readonly nowFn: () => number;
	private readonly store = new Map<string, PersistedRenderSentinelRecord>();
	private readonly activeRuns = new Map<string, ActiveSentinelRun>();
	private hydratePromise: Promise<void> | null = null;
	private clearEpoch = 0;
	private disposed = false;

	constructor(
		app: App,
		logger?: LoggerPort,
		options?: {
			readonly idbStore?: RenderSentinelIdbStore;
			readonly sessionId?: string;
			readonly nowFn?: () => number;
		},
	) {
		this.logger = logger;
		this.idb = options?.idbStore ?? new RenderSentinelIdbStore(resolveSentinelDbName(app));
		this.sessionId = options?.sessionId ?? mintSessionId();
		this.nowFn = options?.nowFn ?? (() => Date.now());
	}

	get size(): number {
		return this.store.size;
	}

	hydrate(): Promise<void> {
		this.hydratePromise ??= this.runHydration();
		return this.hydratePromise;
	}

	ensureHydrated(): Promise<void> {
		return this.hydrate();
	}

	getRecord(hash: string): PersistedRenderSentinelRecord | undefined {
		return this.store.get(hash);
	}

	getQuarantined(hash: string): PersistedRenderSentinelRecord | undefined {
		const rec = this.store.get(hash);
		return rec?.status === 'quarantined' ? rec : undefined;
	}

	async markRunning(hash: string, stats: SentinelRunStats): Promise<void> {
		if (this.disposed) return;
		const epoch = this.clearEpoch;
		await this.ensureHydrated();
		if (this.disposed || this.clearEpoch !== epoch) return;

		let active = this.activeRuns.get(hash);
		const existing = this.store.get(hash);
		if (
			active &&
			existing?.status === 'running' &&
			existing.records === stats.records &&
			existing.outputChars === stats.outputChars &&
			existing.outputLines === stats.outputLines
		) {
			active.count += 1;
			await active.writePromise;
			return;
		}

		const baseline = active ? active.baseline : existing;
		const runningRecord: PersistedRenderSentinelRecord = {
			hash,
			status: 'running',
			sessionId: this.sessionId,
			records: stats.records,
			outputChars: stats.outputChars,
			outputLines: stats.outputLines,
			lastOkDurationMs: baseline?.lastOkDurationMs ?? null,
			lastOkChars: baseline?.lastOkChars ?? null,
			lastOkLines: baseline?.lastOkLines ?? null,
			updatedAt: this.nowFn(),
		};
		this.store.set(hash, runningRecord);
		const putPromise = (async () => {
			await this.idb.put(runningRecord);
			if (this.disposed || this.clearEpoch !== epoch) {
				return;
			}
		})();

		if (!active) {
			active = {
				count: 1,
				baseline,
				writePromise: putPromise,
				committedOutcome: null,
			};
			this.activeRuns.set(hash, active);
		} else {
			active.count += 1;
			active.writePromise = putPromise;
		}

		await putPromise;
	}

	async finishRunning(hash: string, outcome: SentinelFinishOutcome): Promise<void> {
		if (this.disposed) return;
		const active = this.activeRuns.get(hash);
		if (!active) return;

		if (outcome.committed) {
			active.committedOutcome = {
				durationMs: Math.max(0, outcome.durationMs),
				stats: outcome.stats,
			};
		}
		active.count -= 1;
		if (active.count > 0) {
			return;
		}
		this.activeRuns.delete(hash);
		const epoch = this.clearEpoch;

		if (active.committedOutcome !== null) {
			const { durationMs, stats } = active.committedOutcome;
			const okRecord: PersistedRenderSentinelRecord = {
				hash,
				status: 'ok',
				sessionId: this.sessionId,
				records: stats.records,
				outputChars: stats.outputChars,
				outputLines: stats.outputLines,
				lastOkDurationMs: durationMs,
				lastOkChars: stats.outputChars,
				lastOkLines: stats.outputLines,
				updatedAt: this.nowFn(),
			};
			if (this.disposed || this.clearEpoch !== epoch) return;
			this.store.set(hash, okRecord);
			const evicted = this.evictExcessRecords();
			await this.idb.flushBatch([okRecord], evicted);
			return;
		}

		if (this.disposed || this.clearEpoch !== epoch) return;
		if (active.baseline !== undefined) {
			this.store.set(hash, active.baseline);
			await this.idb.put(active.baseline);
		} else {
			this.store.delete(hash);
			await this.idb.delete(hash);
		}
	}

	async clearProbationIfSubThreshold(hash: string): Promise<void> {
		if (this.disposed) return;
		const existing = this.store.get(hash);
		if (existing?.status === 'probation' && !this.activeRuns.has(hash)) {
			this.store.delete(hash);
			await this.idb.delete(hash);
		}
	}

	async promoteToProbation(hash: string): Promise<void> {
		if (this.disposed) return;
		const epoch = this.clearEpoch;
		await this.ensureHydrated();
		if (this.disposed || this.clearEpoch !== epoch) return;
		const existing = this.store.get(hash);
		if (!existing || existing.status !== 'quarantined' || this.activeRuns.has(hash)) {
			return;
		}

		const promoted: PersistedRenderSentinelRecord = {
			...existing,
			status: 'probation',
			sessionId: this.sessionId,
			lastOkDurationMs: null,
			lastOkChars: null,
			lastOkLines: null,
			updatedAt: this.nowFn(),
		};
		this.store.set(hash, promoted);
		await this.idb.put(promoted);
	}

	async clearAll(): Promise<void> {
		this.clearEpoch += 1;
		this.store.clear();
		this.activeRuns.clear();
		this.hydratePromise = Promise.resolve();
		await this.idb.clear();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clearEpoch += 1;
		const puts: PersistedRenderSentinelRecord[] = [];
		const deletes: string[] = [];
		for (const [hash, active] of this.activeRuns) {
			if (active.baseline !== undefined) {
				puts.push(active.baseline);
			} else {
				deletes.push(hash);
			}
		}
		this.activeRuns.clear();
		this.store.clear();
		this.idb.flushAndClose(puts, deletes);
	}

	private async runHydration(): Promise<void> {
		if (this.disposed) return;
		const epoch = this.clearEpoch;
		const rawRecords = await this.idb.getAll();
		if (this.disposed || this.clearEpoch !== epoch || rawRecords.length === 0) return;

		const now = this.nowFn();
		const putsMap = new Map<string, PersistedRenderSentinelRecord>();
		const deletesSet = new Set<string>();

		for (const raw of rawRecords) {
			if (!isValidSentinelRecord(raw)) continue;
			if (this.activeRuns.has(raw.hash)) continue;

			let resolved = raw;
			if (raw.status === 'running' && raw.sessionId !== this.sessionId) {
				const grantProbation =
					raw.lastOkDurationMs !== null &&
					raw.lastOkChars !== null &&
					raw.lastOkLines !== null &&
					raw.outputChars <= raw.lastOkChars * PROBATION_SCALE_FACTOR &&
					raw.outputLines <= raw.lastOkLines * PROBATION_SCALE_FACTOR;

				if (grantProbation) {
					resolved = {
						...raw,
						status: 'probation',
						sessionId: this.sessionId,
						lastOkDurationMs: null,
						lastOkChars: null,
						lastOkLines: null,
						updatedAt: now,
					};
					this.logger?.log(
						'debug',
						`Placed interrupted codeblock render sentinel ${raw.hash} on probation`,
						{
							source: 'template.sentinel',
							hash: raw.hash,
							records: raw.records,
							outputChars: raw.outputChars,
							outputLines: raw.outputLines,
						},
					);
				} else {
					resolved = {
						...raw,
						status: 'quarantined',
						sessionId: this.sessionId,
						updatedAt: now,
					};
					this.logger?.log(
						'warn',
						`Quarantined interrupted codeblock render sentinel ${raw.hash}`,
						{
							source: 'template.sentinel',
							hash: raw.hash,
							records: raw.records,
							outputChars: raw.outputChars,
							outputLines: raw.outputLines,
						},
					);
				}
				putsMap.set(resolved.hash, resolved);
			}

			if (resolved.status === 'ok' && now - resolved.updatedAt > SENTINEL_OK_TTL_MS) {
				putsMap.delete(resolved.hash);
				deletesSet.add(resolved.hash);
				continue;
			}

			this.store.set(resolved.hash, resolved);
		}

		for (const evictedHash of this.evictExcessRecords()) {
			putsMap.delete(evictedHash);
			deletesSet.add(evictedHash);
		}

		if (this.disposed || this.clearEpoch !== epoch) return;
		await this.idb.flushBatch([...putsMap.values()], [...deletesSet]);
	}

	private evictExcessRecords(): string[] {
		if (this.store.size <= MAX_SENTINEL_RECORDS) {
			return [];
		}
		const candidates = [...this.store.values()]
			.filter((rec) => rec.status !== 'running')
			.sort((a, b) => {
				const tierDiff = evictionTier(a.status) - evictionTier(b.status);
				return tierDiff !== 0 ? tierDiff : a.updatedAt - b.updatedAt;
			});
		const excessCount = this.store.size - MAX_SENTINEL_RECORDS;
		const evicted: string[] = [];
		for (let i = 0; i < excessCount && i < candidates.length; i++) {
			const hash = candidates[i]!.hash;
			this.store.delete(hash);
			evicted.push(hash);
		}
		return evicted;
	}
}
