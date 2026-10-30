import type { App } from 'obsidian';
import type { PropertyTypeRegistry } from '@core/search';
import type { LoggerPort } from '@ports/logger-port';
import { markSensitive } from './logger-format';
import {
	resolveDefaultTimeZone,
	runVaultQuery,
	sanitizeQueryEntries,
	type VaultQueryCallback,
	type VaultQueryMatch,
	type VaultQueryOptions,
	type VaultQueryResult,
} from './vault-query-runner';

const PRIME32_1 = 0x9e3779b1 | 0;
const PRIME32_2 = 0x85ebca77 | 0;
const PRIME32_3 = 0xc2b2ae3d | 0;
const PRIME32_4 = 0x27d4eb2f | 0;
const PRIME32_5 = 0x165667b1 | 0;

const SEED_LANE_1 = (PRIME32_5 + PRIME32_1) | 0;
const SEED_LANE_2 = (PRIME32_5 ^ PRIME32_4) | 0;

const f64Scratch = new Float64Array(1);
const i32Scratch = new Int32Array(f64Scratch.buffer);

function rotl32(x: number, r: number): number {
	return (x << r) | (x >>> (32 - r));
}

function xxh32Round(acc: number, input: number): number {
	return Math.imul(rotl32((acc + Math.imul(input, PRIME32_3)) | 0, 17), PRIME32_4);
}

function xxh32Avalanche(h: number): number {
	h ^= h >>> 15;
	h = Math.imul(h, PRIME32_2);
	h ^= h >>> 13;
	h = Math.imul(h, PRIME32_3);
	h ^= h >>> 16;
	return h >>> 0;
}

function formatHex64(hi: number, lo: number): string {
	return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

interface Digest64 {
	readonly hi: number;
	readonly lo: number;
	readonly hex: string;
}

/**
 * Zero-allocation 64-bit streaming xxHash accumulator built from two independent
 * 32-bit xxHash lanes using `Math.imul` and IEEE-754 scratch views.
 *
 * @remarks
 * (perf, 2026-10-30) Uses unboxed 32-bit `Math.imul` arithmetic over pairs of UTF-16
 * code units and a shared `Float64Array`/`Int32Array` buffer for numbers, avoiding
 * `BigInt` heap allocations, `String(number)` allocations, and JS-to-WASM UTF-8 copy
 * overhead while providing a 64-bit xxHash avalanche digest.
 */
class XxHash64Accumulator {
	private s1 = SEED_LANE_1;
	private s2 = SEED_LANE_2;
	private totalBytes = 0;

	updateU32(val: number): void {
		const w = val | 0;
		this.s1 = xxh32Round(this.s1, w);
		this.s2 = xxh32Round(this.s2, (w ^ PRIME32_2) | 0);
		this.totalBytes = (this.totalBytes + 4) | 0;
	}

	updateTag(tag: number, length = 0): void {
		if (length >= 0 && length <= 0x00ffffff) {
			this.updateU32(((tag & 0xff) << 24) | length);
		} else {
			this.updateU32((tag & 0xff) << 24);
			this.updateU32(length | 0);
		}
	}

	updateNumber(n: number): void {
		if ((n | 0) === n && !Object.is(n, -0)) {
			this.updateU32(0x14000001);
			this.updateU32(n | 0);
			return;
		}
		if (Number.isNaN(n)) {
			this.updateU32(0x14000002);
			return;
		}
		if (Object.is(n, -0)) {
			this.updateU32(0x14000003);
			return;
		}
		f64Scratch[0] = n;
		this.updateU32(0x14000004);
		this.updateU32(i32Scratch[0]!);
		this.updateU32(i32Scratch[1]!);
	}

	updateString(str: string): void {
		const len = str.length;
		this.updateTag(0x15, len);
		let s1 = this.s1;
		let s2 = this.s2;
		let i = 0;
		const pairLimit = len - 1;
		while (i < pairLimit) {
			const w = str.charCodeAt(i) | (str.charCodeAt(i + 1) << 16);
			s1 = xxh32Round(s1, w);
			s2 = xxh32Round(s2, (w ^ PRIME32_2) | 0);
			i += 2;
		}
		if (i < len) {
			const w = str.charCodeAt(i);
			s1 = xxh32Round(s1, w);
			s2 = xxh32Round(s2, (w ^ PRIME32_2) | 0);
		}
		this.s1 = s1;
		this.s2 = s2;
		this.totalBytes = (this.totalBytes + (len << 1)) | 0;
	}

	updateStringArray(arr: readonly string[]): void {
		const len = arr.length;
		this.updateTag(0x22, len);
		for (let i = 0; i < len; i++) {
			this.updateString(arr[i]!);
		}
	}

	updateValue(val: unknown): void {
		if (val === null) {
			this.updateU32(0x10000000);
			return;
		}
		if (val === undefined) {
			this.updateU32(0x11000000);
			return;
		}
		if (typeof val === 'boolean') {
			this.updateU32(val ? 0x12000001 : 0x12000000);
			return;
		}
		if (typeof val === 'number') {
			this.updateNumber(val);
			return;
		}
		if (typeof val === 'string') {
			this.updateString(val);
			return;
		}
		if (Array.isArray(val)) {
			const len = val.length;
			this.updateTag(0x20, len);
			for (let i = 0; i < len; i++) {
				this.updateValue(val[i]);
			}
			this.updateU32(0x21000000);
			return;
		}
		if (typeof val === 'object') {
			const record = val as Record<string, unknown>;
			const keys = Object.keys(record).sort();
			const len = keys.length;
			this.updateTag(0x30, len);
			for (let i = 0; i < len; i++) {
				const k = keys[i]!;
				this.updateString(k);
				this.updateValue(record[k]);
			}
			this.updateU32(0x31000000);
			return;
		}
		this.updateString(typeof val);
	}

	updateMatch(match: VaultQueryMatch): void {
		const file = match.file;
		this.updateString(file.path);
		this.updateString(file.name);
		this.updateString(file.basename);
		this.updateString(file.extension);
		this.updateString(file.parent);
		this.updateNumber(file.created);
		this.updateNumber(file.modified);
		this.updateNumber(file.size);

		this.updateStringArray(match.aliases);
		this.updateStringArray(match.tags);

		const tagLocs = match.tagLocations;
		this.updateTag(0x23, tagLocs.length);
		for (let i = 0; i < tagLocs.length; i++) {
			const loc = tagLocs[i]!;
			this.updateString(loc.tag);
			this.updateString(loc.source);
			this.updateString(loc.origin);
		}

		const headings = match.headings;
		this.updateTag(0x24, headings.length);
		for (let i = 0; i < headings.length; i++) {
			const h = headings[i]!;
			this.updateString(h.text);
			this.updateU32(h.level);
		}

		const links = match.links;
		this.updateTag(0x25, links.length);
		for (let i = 0; i < links.length; i++) {
			const l = links[i]!;
			this.updateString(l.link);
			this.updateString(l.rawTarget);
			if (l.resolvedPath === null) {
				this.updateU32(0x10000000);
			} else {
				this.updateString(l.resolvedPath);
			}
			this.updateString(l.subpath);
			this.updateString(l.displayText);
			this.updateString(l.source);
			this.updateString(l.origin);
		}

		const embeds = match.embeds;
		this.updateTag(0x26, embeds.length);
		for (let i = 0; i < embeds.length; i++) {
			const e = embeds[i]!;
			this.updateString(e.link);
			this.updateString(e.rawTarget);
			if (e.resolvedPath === null) {
				this.updateU32(0x10000000);
			} else {
				this.updateString(e.resolvedPath);
			}
			this.updateString(e.subpath);
			this.updateString(e.displayText);
			this.updateString(e.source);
			this.updateString(e.origin);
		}

		this.updateStringArray(match.blocks);
		this.updateValue(match.properties);
	}

	digest(): Digest64 {
		const hi = xxh32Avalanche((this.s1 + this.totalBytes) | 0);
		const lo = xxh32Avalanche((this.s2 + this.totalBytes) | 0);
		return { hi, lo, hex: formatHex64(hi, lo) };
	}
}

const matchDigestCache = new WeakMap<VaultQueryMatch, Digest64>();

function getMatchDigest(match: VaultQueryMatch): Digest64 {
	const cached = matchDigestCache.get(match);
	if (cached !== undefined) {
		return cached;
	}
	const acc = new XxHash64Accumulator();
	acc.updateMatch(match);
	const digest = acc.digest();
	matchDigestCache.set(match, digest);
	return digest;
}

/**
 * Computes a deterministic 64-bit xxHash hex digest for a single `VaultQueryMatch` POJO,
 * memoized per object reference via a `WeakMap` so matches shared across queries
 * or subscribers within a vault scan are hashed at most once.
 */
export function hashVaultQueryMatch(match: VaultQueryMatch): string {
	return getMatchDigest(match).hex;
}

/**
 * Computes a deterministic 64-bit xxHash hex digest for a `VaultQueryResult` payload
 * across all present query keys and their ordered `VaultQueryMatch` arrays.
 */
export function hashVaultQueryResult(result: VaultQueryResult): string {
	const acc = new XxHash64Accumulator();
	const keys = Object.keys(result).sort();
	acc.updateTag(0x40, keys.length);
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i]!;
		acc.updateString(key);
		const matches = result[key];
		if (!Array.isArray(matches)) {
			acc.updateU32(0x41000000);
			continue;
		}
		acc.updateTag(0x42, matches.length);
		for (let j = 0; j < matches.length; j++) {
			const d = getMatchDigest(matches[j]!);
			acc.updateU32(d.hi);
			acc.updateU32(d.lo);
		}
	}
	return acc.digest().hex;
}

interface ActiveSubscription {
	readonly id: number;
	readonly entries: ReadonlyArray<readonly [string, string]>;
	readonly timeZone: string | undefined;
	readonly propertyTypes: PropertyTypeRegistry | undefined;
	readonly signal: AbortSignal | undefined;
	readonly onUpdate: VaultQueryCallback;
	lastPayloadHash: string;
}

function buildConfigGroupKey(
	timeZone: string | undefined,
	propertyTypes: PropertyTypeRegistry | undefined,
): string {
	const resolvedTz = timeZone !== undefined ? timeZone : resolveDefaultTimeZone();
	const acc = new XxHash64Accumulator();
	acc.updateString(resolvedTz);
	acc.updateValue(propertyTypes ?? null);
	return acc.digest().hex;
}

/**
 * Tracks active reactive `plugin.query(..., onUpdate)` subscribers, coalesces vault
 * change nudges into single-pass deduplicated `runVaultQuery` runs, and invokes each
 * subscriber's `onUpdate` callback only when its reconstructed payload hash changes.
 */
export class ActiveQueryRoster {
	private readonly app: App;
	private readonly logger: LoggerPort | undefined;
	private readonly subscriptions = new Map<number, ActiveSubscription>();
	private nextId = 1;
	private activeNudgePromise: Promise<void> | null = null;
	private rerunPending = false;

	constructor(app: App, logger?: LoggerPort) {
		this.app = app;
		this.logger = logger;
	}

	/** Number of currently active reactive query subscriptions. */
	get size(): number {
		return this.subscriptions.size;
	}

	/**
	 * Registers a reactive query subscriber with its initial result snapshot and
	 * optional `AbortSignal` for automatic cleanup on unload.
	 */
	register(
		queries: Readonly<Record<string, string>>,
		options: VaultQueryOptions | undefined,
		initialResult: VaultQueryResult,
		onUpdate: VaultQueryCallback,
	): () => void {
		const entries = sanitizeQueryEntries(queries);
		const signal = options?.signal;
		if (entries.length === 0 || signal?.aborted === true) {
			return () => {};
		}

		const id = this.nextId++;
		const sub: ActiveSubscription = {
			id,
			entries,
			timeZone: options?.timeZone,
			propertyTypes: options?.propertyTypes,
			signal,
			onUpdate,
			lastPayloadHash: hashVaultQueryResult(initialResult),
		};
		this.subscriptions.set(id, sub);

		const onAbort = () => {
			this.subscriptions.delete(id);
		};
		signal?.addEventListener('abort', onAbort, { once: true });

		return () => {
			signal?.removeEventListener('abort', onAbort);
			this.subscriptions.delete(id);
		};
	}

	/**
	 * Re-evaluates all active subscriptions in a single-pass deduplicated vault scan
	 * per configuration group and notifies subscribers whose payload hash changed.
	 */
	nudge(referenceTimeMs: number = Date.now()): Promise<void> {
		if (this.subscriptions.size === 0) {
			return Promise.resolve();
		}
		if (this.activeNudgePromise !== null) {
			this.rerunPending = true;
			return this.activeNudgePromise;
		}

		const runLoop = async (initialRefTimeMs: number): Promise<void> => {
			let currentRefTimeMs = initialRefTimeMs;
			do {
				this.rerunPending = false;
				await this.executeNudgePass(currentRefTimeMs);
				currentRefTimeMs = Date.now();
			} while (this.rerunPending && this.subscriptions.size > 0);
		};

		const promise = runLoop(referenceTimeMs).finally(() => {
			this.activeNudgePromise = null;
		});
		this.activeNudgePromise = promise;
		return promise;
	}

	/** Removes all active subscriptions immediately. */
	clear(): void {
		this.subscriptions.clear();
		this.rerunPending = false;
	}

	private async executeNudgePass(referenceTimeMs: number): Promise<void> {
		if (this.subscriptions.size === 0) {
			return;
		}

		const groups = new Map<
			string,
			{
				timeZone: string | undefined;
				propertyTypes: PropertyTypeRegistry | undefined;
				subs: ActiveSubscription[];
			}
		>();

		for (const sub of this.subscriptions.values()) {
			if (sub.signal?.aborted) {
				this.subscriptions.delete(sub.id);
				continue;
			}
			const key = buildConfigGroupKey(sub.timeZone, sub.propertyTypes);
			let group = groups.get(key);
			if (!group) {
				group = {
					timeZone: sub.timeZone,
					propertyTypes: sub.propertyTypes,
					subs: [],
				};
				groups.set(key, group);
			}
			group.subs.push(sub);
		}

		for (const group of groups.values()) {
			const queryToDedupKey = new Map<string, string>();
			const dedupQueries: Record<string, string> = Object.create(null) as Record<
				string,
				string
			>;
			let qIdx = 0;

			for (const sub of group.subs) {
				for (const [, rawQuery] of sub.entries) {
					if (!queryToDedupKey.has(rawQuery)) {
						const dedupKey = `__q${qIdx++}`;
						queryToDedupKey.set(rawQuery, dedupKey);
						dedupQueries[dedupKey] = rawQuery;
					}
				}
			}

			const batchResult = await runVaultQuery(
				this.app,
				dedupQueries,
				{
					timeZone: group.timeZone,
					propertyTypes: group.propertyTypes,
					referenceTimeMs,
				},
				this.logger,
			);

			for (const sub of group.subs) {
				if (sub.signal?.aborted || !this.subscriptions.has(sub.id)) {
					this.subscriptions.delete(sub.id);
					continue;
				}

				const subscriberResult: VaultQueryResult = {};
				for (const [name, rawQuery] of sub.entries) {
					const dedupKey = queryToDedupKey.get(rawQuery);
					if (
						dedupKey !== undefined &&
						Object.prototype.hasOwnProperty.call(batchResult, dedupKey)
					) {
						subscriberResult[name] = [...(batchResult[dedupKey] ?? [])];
					}
				}

				const nextHash = hashVaultQueryResult(subscriberResult);
				if (nextHash !== sub.lastPayloadHash) {
					sub.lastPayloadHash = nextHash;
					try {
						await sub.onUpdate(subscriberResult);
					} catch (error) {
						this.logger?.log(
							'error',
							`Reactive query callback failed: ${markSensitive(String(error))}`,
							{
								source: 'query.reactive',
								error: markSensitive(String(error)),
							},
						);
					}
				}
			}
		}
	}
}
