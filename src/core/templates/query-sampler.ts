import { FORBIDDEN_KEYS } from '@core/search';
import { formatQueryCutoffCallout } from './query-cutoff';
import type { ExtractedQueryBlock, TemplateRuntimeContext } from './types';

/**
 * Deterministic Phase-1 base stride sample target per `{% query %}` block in `rhizome-sample`.
 */
export const BASE_SAMPLE_SIZE = 100;

/**
 * Maximum total sampled records per `{% query %}` block in `rhizome-sample` after Phase-2
 * Referential Integrity (RI) top-up (`<= 100` base + up to `400` RI records).
 */
export const MAX_SAMPLE_SIZE = 500;

/**
 * Maximum Phase-2 Referential Integrity top-up records per `{% query %}` block (`400`).
 */
export const MAX_REFERENTIAL_TOP_UP = MAX_SAMPLE_SIZE - BASE_SAMPLE_SIZE;

/**
 * Per-query sampling and cutoff telemetry captured during `rhizome-sample` execution.
 */
export interface QuerySampleMetrics {
	readonly matchedCount: number;
	readonly sampledCount: number;
	readonly baseStrideCount: number;
	readonly referentialTopUpCount: number;
	readonly downsampled: boolean;
	readonly effectiveCutoff: number;
	readonly cutoffBound: boolean;
	readonly exceedsProductionCutoff: boolean;
}

/**
 * Result returned by `sampleStaticQueryBatch` for Pass-1.5 static queries.
 */
export interface StaticQuerySampleResult {
	readonly sampledPayload: Readonly<Record<string, unknown[]>>;
	readonly calloutsMarkdown: string;
	readonly metricsByName: ReadonlyMap<string, QuerySampleMetrics>;
	readonly linkedPaths: Set<string>;
}

interface InspectableRow {
	readonly file?: { readonly path?: unknown } | undefined;
	readonly links?: ReadonlyArray<{ readonly resolvedPath?: unknown }> | undefined;
	readonly embeds?: ReadonlyArray<{ readonly resolvedPath?: unknown }> | undefined;
	readonly backlinks?: ReadonlyArray<{ readonly path?: unknown }> | undefined;
}

function compareQueryNames(a: string, b: string): number {
	const lowerA = a.toLowerCase();
	const lowerB = b.toLowerCase();
	if (lowerA < lowerB) return -1;
	if (lowerA > lowerB) return 1;
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function readRowFilePath(row: unknown): string | null {
	if (!row || typeof row !== 'object') {
		return null;
	}
	const file = (row as InspectableRow).file;
	if (!file || typeof file !== 'object') {
		return null;
	}
	return typeof file.path === 'string' && file.path.length > 0 ? file.path : null;
}

/**
 * Computes `count` strictly increasing, deterministic midpoint-stride indices in `[0, totalLength)`.
 */
export function strideSampleIndices(totalLength: number, count: number): number[] {
	if (count <= 0 || totalLength <= 0) {
		return [];
	}
	if (totalLength <= count) {
		const all: number[] = [];
		for (let i = 0; i < totalLength; i++) {
			all.push(i);
		}
		return all;
	}
	const indices: number[] = [];
	for (let k = 0; k < count; k++) {
		indices.push(Math.floor(((k + 0.5) * totalLength) / count));
	}
	return indices;
}

/**
 * Collects outgoing `links[].resolvedPath`, outgoing `embeds[].resolvedPath`, and incoming
 * `backlinks[].path` from `rows` into `target`.
 */
export function collectLinkedPathsFromRows(rows: readonly unknown[], target: Set<string>): void {
	for (const rawRow of rows) {
		if (!rawRow || typeof rawRow !== 'object') {
			continue;
		}
		const row = rawRow as InspectableRow;
		if (Array.isArray(row.links)) {
			const links = row.links as readonly { readonly resolvedPath?: unknown }[];
			for (const link of links) {
				if (
					link &&
					typeof link === 'object' &&
					typeof link.resolvedPath === 'string' &&
					link.resolvedPath.length > 0
				) {
					target.add(link.resolvedPath);
				}
			}
		}
		if (Array.isArray(row.embeds)) {
			const embeds = row.embeds as readonly { readonly resolvedPath?: unknown }[];
			for (const embed of embeds) {
				if (
					embed &&
					typeof embed === 'object' &&
					typeof embed.resolvedPath === 'string' &&
					embed.resolvedPath.length > 0
				) {
					target.add(embed.resolvedPath);
				}
			}
		}
		if (Array.isArray(row.backlinks)) {
			const backlinks = row.backlinks as readonly { readonly path?: unknown }[];
			for (const backlink of backlinks) {
				if (
					backlink &&
					typeof backlink === 'object' &&
					typeof backlink.path === 'string' &&
					backlink.path.length > 0
				) {
					target.add(backlink.path);
				}
			}
		}
	}
}

interface Phase1Entry {
	readonly block: ExtractedQueryBlock;
	readonly fullRows: readonly unknown[];
	readonly effectiveCutoff: number;
	readonly exceedsProductionCutoff: boolean;
	readonly cutoffBound: boolean;
	readonly baseIndices: readonly number[];
	readonly baseRows: readonly unknown[];
}

function runPhase1ForQuery(block: ExtractedQueryBlock, fullRows: readonly unknown[]): Phase1Entry {
	const matchedCount = fullRows.length;
	const effectiveCutoff = block.cutoff > 0 ? block.cutoff : Number.POSITIVE_INFINITY;
	const exceedsProductionCutoff = block.cutoff > 0 && matchedCount > block.cutoff;

	if (effectiveCutoff <= BASE_SAMPLE_SIZE) {
		if (matchedCount > effectiveCutoff) {
			const sliced = fullRows.slice(0, effectiveCutoff);
			const baseIndices: number[] = [];
			for (let i = 0; i < sliced.length; i++) {
				baseIndices.push(i);
			}
			return {
				block,
				fullRows,
				effectiveCutoff,
				exceedsProductionCutoff: true,
				cutoffBound: true,
				baseIndices,
				baseRows: sliced,
			};
		}
		const baseIndices = strideSampleIndices(matchedCount, matchedCount);
		return {
			block,
			fullRows,
			effectiveCutoff,
			exceedsProductionCutoff: false,
			cutoffBound: false,
			baseIndices,
			baseRows: fullRows,
		};
	}

	const sampleCap = Math.min(BASE_SAMPLE_SIZE, effectiveCutoff);
	const baseIndices = strideSampleIndices(matchedCount, sampleCap);
	const baseRows =
		baseIndices.length === matchedCount ? fullRows : baseIndices.map((i) => fullRows[i]!);
	return {
		block,
		fullRows,
		effectiveCutoff,
		exceedsProductionCutoff,
		cutoffBound: false,
		baseIndices,
		baseRows,
	};
}

function finalizePhase2ForQuery(
	p1: Phase1Entry,
	linkedPaths: ReadonlySet<string>,
): {
	readonly sampledRows: unknown[];
	readonly metrics: QuerySampleMetrics;
} {
	const matchedCount = p1.fullRows.length;
	if (p1.cutoffBound || matchedCount <= p1.baseIndices.length) {
		const frozenRows = Object.freeze([...p1.baseRows]) as unknown as unknown[];
		return {
			sampledRows: frozenRows,
			metrics: Object.freeze({
				matchedCount,
				sampledCount: frozenRows.length,
				baseStrideCount: frozenRows.length,
				referentialTopUpCount: 0,
				downsampled: false,
				effectiveCutoff: p1.effectiveCutoff,
				cutoffBound: p1.cutoffBound,
				exceedsProductionCutoff: p1.exceedsProductionCutoff,
			}),
		};
	}

	const remainingCapacity = Math.max(
		0,
		Math.min(MAX_SAMPLE_SIZE, p1.effectiveCutoff) - p1.baseIndices.length,
	);
	let pickedRiIndices: number[] = [];

	if (remainingCapacity > 0 && linkedPaths.size > 0) {
		const baseIndexSet = new Set<number>(p1.baseIndices);
		const candidateRiIndices: number[] = [];
		for (let idx = 0; idx < matchedCount; idx++) {
			if (baseIndexSet.has(idx)) {
				continue;
			}
			const path = readRowFilePath(p1.fullRows[idx]);
			if (path !== null && linkedPaths.has(path)) {
				candidateRiIndices.push(idx);
			}
		}
		if (candidateRiIndices.length <= remainingCapacity) {
			pickedRiIndices = candidateRiIndices;
		} else {
			const strideOnRi = strideSampleIndices(candidateRiIndices.length, remainingCapacity);
			pickedRiIndices = strideOnRi.map((k) => candidateRiIndices[k]!);
		}
	}

	const combinedIndices =
		pickedRiIndices.length > 0
			? [...p1.baseIndices, ...pickedRiIndices].sort((a, b) => a - b)
			: [...p1.baseIndices];
	const sampledRows = Object.freeze(
		combinedIndices.map((idx) => p1.fullRows[idx]!),
	) as unknown as unknown[];

	return {
		sampledRows,
		metrics: Object.freeze({
			matchedCount,
			sampledCount: sampledRows.length,
			baseStrideCount: p1.baseIndices.length,
			referentialTopUpCount: pickedRiIndices.length,
			downsampled: sampledRows.length < matchedCount,
			effectiveCutoff: p1.effectiveCutoff,
			cutoffBound: false,
			exceedsProductionCutoff: p1.exceedsProductionCutoff,
		}),
	};
}

/**
 * Applies two-phase deterministic Referential Integrity (RI) sampling across a batch of Pass-1.5
 * static queries (`100` base stride + up to `400` RI top-up, preserving original vault order).
 */
export function sampleStaticQueryBatch(
	queries: readonly ExtractedQueryBlock[],
	fullPayload: Readonly<Record<string, unknown[]>>,
	runtimeContext?: TemplateRuntimeContext,
): StaticQuerySampleResult {
	const phase1Entries: Phase1Entry[] = [];
	const linkedPaths = new Set<string>();

	for (const q of queries) {
		if (
			FORBIDDEN_KEYS.has(q.name) ||
			!Object.prototype.hasOwnProperty.call(fullPayload, q.name)
		) {
			continue;
		}
		const raw = fullPayload[q.name];
		const fullRows = Array.isArray(raw) ? raw : [];
		const p1 = runPhase1ForQuery(q, fullRows);
		phase1Entries.push(p1);
		collectLinkedPathsFromRows(p1.baseRows, linkedPaths);
	}

	const derived = Object.create(null) as Record<string, unknown[]>;
	for (const key of Object.keys(fullPayload)) {
		if (!FORBIDDEN_KEYS.has(key)) {
			derived[key] = fullPayload[key]!;
		}
	}

	const metricsByName = new Map<string, QuerySampleMetrics>();
	const cutoffBoundEntries: Array<{
		readonly block: ExtractedQueryBlock;
		readonly matchedCount: number;
	}> = [];

	for (const p1 of phase1Entries) {
		const { sampledRows, metrics } = finalizePhase2ForQuery(p1, linkedPaths);
		derived[p1.block.name] = sampledRows;
		metricsByName.set(p1.block.name, metrics);
		if (metrics.cutoffBound) {
			cutoffBoundEntries.push({ block: p1.block, matchedCount: metrics.matchedCount });
		}
	}

	cutoffBoundEntries.sort((a, b) => compareQueryNames(a.block.name, b.block.name));
	const calloutsMarkdown = cutoffBoundEntries
		.map((item) => formatQueryCutoffCallout(item.block, item.matchedCount, runtimeContext))
		.join('\n\n');

	return {
		sampledPayload: Object.freeze(derived),
		calloutsMarkdown,
		metricsByName,
		linkedPaths,
	};
}

/**
 * Applies two-phase deterministic RI sampling to a single reached Pass-2 lazy `@this` query
 * against `linkedPaths`, contributing its Phase-1 `Base_lazy` links into `linkedPaths` for
 * any subsequent lazy queries.
 */
export function sampleSingleLazyQuery(
	queryBlock: ExtractedQueryBlock,
	fullRows: readonly unknown[],
	linkedPaths: Set<string>,
	runtimeContext?: TemplateRuntimeContext,
): {
	readonly effectiveRows: unknown[];
	readonly calloutMarkdown: string;
	readonly metrics: QuerySampleMetrics;
} {
	const p1 = runPhase1ForQuery(queryBlock, fullRows);
	const { sampledRows, metrics } = finalizePhase2ForQuery(p1, linkedPaths);
	collectLinkedPathsFromRows(p1.baseRows, linkedPaths);
	const calloutMarkdown = metrics.cutoffBound
		? formatQueryCutoffCallout(queryBlock, metrics.matchedCount, runtimeContext)
		: '';
	return {
		effectiveRows: sampledRows,
		calloutMarkdown,
		metrics,
	};
}
