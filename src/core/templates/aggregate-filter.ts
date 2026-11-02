import { isVacuousOccurrence, parseTemporalExpr } from '@core/search';
import type { Context } from 'liquidjs';
import { type ParsedPathSelector, parsePickOrAggSelectors, readDeepPath } from './payload-filters';
import {
	coerceNumericEndpointToTemporalDrop,
	type DisplayGrain,
	finestDisplayGrain,
	formatEpochMsAtGrain,
	normalizeRelativeTemporalString,
	parseFiniteRangeNumber,
	readContextTemporalMeta,
	TemporalDrop,
	unwrapLiquidValue,
} from './temporal-drop';

type AttributeDomain = 'unknown' | 'number' | 'temporal';

/**
 * Per-attribute cumulative metrics at a single index step, augmented with the
 * whole-array `total_*` summary metrics.
 */
export interface AggregateStepMetrics {
	index_count: number;
	value_count: number;
	sum: number | null;
	average: number | null;
	min: number | TemporalDrop | null;
	max: number | TemporalDrop | null;
	interval: [number, number] | TemporalDrop | null;
	total_index_count: number;
	total_value_count: number;
	total_sum: number | null;
	total_average: number | null;
	total_min: number | TemporalDrop | null;
	total_max: number | TemporalDrop | null;
	total_interval: [number, number] | TemporalDrop | null;
}

/**
 * Whole-array summary metrics attached to `result.<attr>` (and mirrored at top-level
 * on `result` when aggregating a single attribute).
 */
export interface AggregateTotalMetrics {
	total_index_count: number;
	total_value_count: number;
	total_sum: number | null;
	total_average: number | null;
	total_min: number | TemporalDrop | null;
	total_max: number | TemporalDrop | null;
	total_interval: [number, number] | TemporalDrop | null;
}

interface AttributeAccumulator {
	readonly selector: ParsedPathSelector;
	domain: AttributeDomain;
	valueCount: number;
	numSum: number;
	numMin: number;
	numMax: number;
	tempMin: TemporalDrop | null;
	tempMax: TemporalDrop | null;
	tempFinestGrain: DisplayGrain | null;
}

function createAttributeAccumulator(selector: ParsedPathSelector): AttributeAccumulator {
	return {
		selector,
		domain: 'unknown',
		valueCount: 0,
		numSum: 0,
		numMin: Number.POSITIVE_INFINITY,
		numMax: Number.NEGATIVE_INFINITY,
		tempMin: null,
		tempMax: null,
		tempFinestGrain: null,
	};
}

function buildCoveringTemporalInterval(
	minDrop: TemporalDrop,
	maxDrop: TemporalDrop,
	grain: DisplayGrain,
	timeZone: string,
	referenceTimeMs: number,
): TemporalDrop {
	const start = minDrop.start;
	const end = Math.max(start + 1, maxDrop.end);
	const leftIso = formatEpochMsAtGrain(start, grain, timeZone);
	const rightIso = formatEpochMsAtGrain(Math.max(start, end - 1), grain, timeZone);
	return new TemporalDrop({
		start,
		end,
		grain,
		isRange: true,
		timeZone,
		referenceTimeMs,
		raw: `${leftIso}..${rightIso}`,
	});
}

function feedCandidateIntoAccumulator(
	acc: AttributeAccumulator,
	rawCandidate: unknown,
	timeZone: string,
	referenceTimeMs: number,
): void {
	const c = unwrapLiquidValue(rawCandidate);
	if (isVacuousOccurrence(c)) {
		return;
	}

	if (c instanceof TemporalDrop) {
		if (acc.domain === 'number') return;
		acc.domain = 'temporal';
		foldTemporalIntoAccumulator(acc, c);
		return;
	}

	if (typeof c === 'number') {
		if (acc.domain === 'temporal') {
			const coerced = coerceNumericEndpointToTemporalDrop(
				c,
				String(c),
				false,
				timeZone,
				referenceTimeMs,
			);
			if (coerced) {
				foldTemporalIntoAccumulator(acc, coerced);
			}
			return;
		}
		if (!Number.isFinite(c)) return;
		const clean = c === 0 ? 0 : c;
		acc.domain = 'number';
		foldNumberIntoAccumulator(acc, clean);
		return;
	}

	if (typeof c === 'string') {
		if (acc.domain !== 'temporal') {
			const num = parseFiniteRangeNumber(c);
			if (num !== null) {
				const clean = num === 0 ? 0 : num;
				acc.domain = 'number';
				foldNumberIntoAccumulator(acc, clean);
				return;
			}
		}
		if (acc.domain !== 'number') {
			const trimmed = c.trim();
			if (trimmed.length > 0) {
				const parsed = parseTemporalExpr(normalizeRelativeTemporalString(trimmed), {
					allowYearOnly: true,
					allowRelative: true,
					timeZone,
					referenceTimeMs,
				});
				if (parsed.ok) {
					const temp = TemporalDrop.fromDateInterval(
						parsed.interval,
						timeZone,
						referenceTimeMs,
					);
					acc.domain = 'temporal';
					foldTemporalIntoAccumulator(acc, temp);
				}
			}
		}
	}
}

function foldNumberIntoAccumulator(acc: AttributeAccumulator, val: number): void {
	acc.valueCount += 1;
	const nextSum = acc.numSum + val;
	acc.numSum = nextSum === 0 ? 0 : nextSum;
	if (val < acc.numMin) acc.numMin = val;
	if (val > acc.numMax) acc.numMax = val;
}

function foldTemporalIntoAccumulator(acc: AttributeAccumulator, drop: TemporalDrop): void {
	acc.valueCount += 1;
	if (
		acc.tempMin === null ||
		drop.start < acc.tempMin.start ||
		(drop.start === acc.tempMin.start && drop.end < acc.tempMin.end)
	) {
		acc.tempMin = drop;
	}
	if (
		acc.tempMax === null ||
		drop.end > acc.tempMax.end ||
		(drop.end === acc.tempMax.end && drop.start > acc.tempMax.start)
	) {
		acc.tempMax = drop;
	}
	acc.tempFinestGrain =
		acc.tempFinestGrain === null
			? drop.grain
			: finestDisplayGrain(acc.tempFinestGrain, drop.grain);
}

interface SnapshotMetrics {
	readonly value_count: number;
	readonly sum: number | null;
	readonly average: number | null;
	readonly min: number | TemporalDrop | null;
	readonly max: number | TemporalDrop | null;
	readonly interval: [number, number] | TemporalDrop | null;
}

function snapshotAccumulator(
	acc: AttributeAccumulator,
	timeZone: string,
	referenceTimeMs: number,
): SnapshotMetrics {
	if (acc.valueCount === 0 || acc.domain === 'unknown') {
		return {
			value_count: 0,
			sum: null,
			average: null,
			min: null,
			max: null,
			interval: null,
		};
	}

	if (acc.domain === 'number') {
		const sum = acc.numSum === 0 ? 0 : acc.numSum;
		const rawAvg = sum / acc.valueCount;
		const average = rawAvg === 0 ? 0 : rawAvg;
		const min = acc.numMin === 0 ? 0 : acc.numMin;
		const max = acc.numMax === 0 ? 0 : acc.numMax;
		return {
			value_count: acc.valueCount,
			sum,
			average,
			min,
			max,
			interval: [min, max],
		};
	}

	const minDrop = acc.tempMin!;
	const maxDrop = acc.tempMax!;
	const grain = acc.tempFinestGrain ?? minDrop.grain;
	const interval = buildCoveringTemporalInterval(
		minDrop,
		maxDrop,
		grain,
		timeZone,
		referenceTimeMs,
	);
	return {
		value_count: acc.valueCount,
		sum: null,
		average: null,
		min: minDrop,
		max: maxDrop,
		interval,
	};
}

/**
 * Liquid `aggregate` (`agg`) filter: computes single-pass cumulative (per-index) and
 * whole-array (`total_*`) aggregations across an array of objects for one or more
 * deep-dotted attributes, returning an indexable array with summary properties attached.
 */
export function aggregateFilter(
	this: { context?: Context } | void,
	input: unknown,
	...args: unknown[]
): unknown[] & Record<string, unknown> {
	const ctx = this && typeof this === 'object' && 'context' in this ? this.context : undefined;
	const { timeZone, referenceTimeMs } = readContextTemporalMeta(ctx);

	const unwrappedInput = unwrapLiquidValue(input);
	const rows: readonly unknown[] = Array.isArray(unwrappedInput) ? unwrappedInput : [];
	const selectors = parsePickOrAggSelectors(args);
	const totalIndexCount = rows.length;

	const accumulators = selectors.map((sel) => createAttributeAccumulator(sel));
	const stepSnapshotsPerRow: SnapshotMetrics[][] = [];

	// Pass 1: Single scan across all rows, unrolling array values per attribute
	for (let i = 0; i < totalIndexCount; i++) {
		const row = rows[i];
		const rowSnaps: SnapshotMetrics[] = [];
		for (let s = 0; s < accumulators.length; s++) {
			const acc = accumulators[s]!;
			const rawVal = readDeepPath(row, acc.selector.segments);
			const candidates = Array.isArray(rawVal) ? rawVal : [rawVal];
			for (const candidate of candidates) {
				feedCandidateIntoAccumulator(acc, candidate, timeZone, referenceTimeMs);
			}
			rowSnaps.push(snapshotAccumulator(acc, timeZone, referenceTimeMs));
		}
		stepSnapshotsPerRow.push(rowSnaps);
	}

	// Compute whole-array `total_*` summary per attribute
	const totalMetricsByAttr: AggregateTotalMetrics[] = accumulators.map((acc) => {
		const finalSnap = snapshotAccumulator(acc, timeZone, referenceTimeMs);
		return {
			total_index_count: totalIndexCount,
			total_value_count: finalSnap.value_count,
			total_sum: finalSnap.sum,
			total_average: finalSnap.average,
			total_min: finalSnap.min,
			total_max: finalSnap.max,
			total_interval: finalSnap.interval,
		};
	});

	// Pass 2: Assemble indexable result array with per-index and root summary maps
	const result = [] as unknown as unknown[] & Record<string, unknown>;

	for (let i = 0; i < totalIndexCount; i++) {
		const indexCount = i + 1;
		const stepObj: Record<string, unknown> = {
			index_count: indexCount,
			total_index_count: totalIndexCount,
		};
		const rowSnaps = stepSnapshotsPerRow[i]!;

		for (let s = 0; s < accumulators.length; s++) {
			const attrKey = accumulators[s]!.selector.outputKey;
			const snap = rowSnaps[s]!;
			const totals = totalMetricsByAttr[s]!;
			const stepMetrics: AggregateStepMetrics = {
				index_count: indexCount,
				value_count: snap.value_count,
				sum: snap.sum,
				average: snap.average,
				min: snap.min,
				max: snap.max,
				interval: snap.interval,
				total_index_count: totals.total_index_count,
				total_value_count: totals.total_value_count,
				total_sum: totals.total_sum,
				total_average: totals.total_average,
				total_min: totals.total_min,
				total_max: totals.total_max,
				total_interval: totals.total_interval,
			};
			stepObj[attrKey] = stepMetrics;

			if (accumulators.length === 1) {
				stepObj.value_count = stepMetrics.value_count;
				stepObj.sum = stepMetrics.sum;
				stepObj.average = stepMetrics.average;
				stepObj.min = stepMetrics.min;
				stepObj.max = stepMetrics.max;
				stepObj.interval = stepMetrics.interval;
				stepObj.total_value_count = stepMetrics.total_value_count;
				stepObj.total_sum = stepMetrics.total_sum;
				stepObj.total_average = stepMetrics.total_average;
				stepObj.total_min = stepMetrics.total_min;
				stepObj.total_max = stepMetrics.total_max;
				stepObj.total_interval = stepMetrics.total_interval;
			}
		}

		result.push(stepObj);
	}

	result.total_index_count = totalIndexCount;

	for (let s = 0; s < accumulators.length; s++) {
		const attrKey = accumulators[s]!.selector.outputKey;
		const totals = totalMetricsByAttr[s]!;
		result[attrKey] = { ...totals };

		if (accumulators.length === 1) {
			result.total_value_count = totals.total_value_count;
			result.total_sum = totals.total_sum;
			result.total_average = totals.total_average;
			result.total_min = totals.total_min;
			result.total_max = totals.total_max;
			result.total_interval = totals.total_interval;
		}
	}

	return result;
}
