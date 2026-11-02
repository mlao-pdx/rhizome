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

interface GroupedAttributeSelector {
	readonly outputKey: string;
	readonly segmentPaths: (readonly string[])[];
}

interface AttributeAccumulator {
	readonly group: GroupedAttributeSelector;
	domain: AttributeDomain;
	valueCount: number;
	numSum: number;
	numMin: number;
	numMax: number;
	tempMin: TemporalDrop | null;
	tempMax: TemporalDrop | null;
	tempFinestGrain: DisplayGrain | null;
	cachedNumInterval: [number, number] | null;
	cachedTempInterval: TemporalDrop | null;
}

function groupSelectorsByOutputKey(
	selectors: readonly ParsedPathSelector[],
): GroupedAttributeSelector[] {
	const groups: GroupedAttributeSelector[] = [];
	const byKey = new Map<string, GroupedAttributeSelector>();

	for (const sel of selectors) {
		const existing = byKey.get(sel.outputKey);
		if (existing) {
			existing.segmentPaths.push(sel.segments);
		} else {
			const group: GroupedAttributeSelector = {
				outputKey: sel.outputKey,
				segmentPaths: [sel.segments],
			};
			byKey.set(sel.outputKey, group);
			groups.push(group);
		}
	}

	return groups;
}

function createAttributeAccumulator(group: GroupedAttributeSelector): AttributeAccumulator {
	return {
		group,
		domain: 'unknown',
		valueCount: 0,
		numSum: 0,
		numMin: Number.POSITIVE_INFINITY,
		numMax: Number.NEGATIVE_INFINITY,
		tempMin: null,
		tempMax: null,
		tempFinestGrain: null,
		cachedNumInterval: null,
		cachedTempInterval: null,
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
	let boundsChanged = false;
	if (val < acc.numMin) {
		acc.numMin = val;
		boundsChanged = true;
	}
	if (val > acc.numMax) {
		acc.numMax = val;
		boundsChanged = true;
	}
	if (boundsChanged) {
		acc.cachedNumInterval = null;
	}
}

function foldTemporalIntoAccumulator(acc: AttributeAccumulator, drop: TemporalDrop): void {
	acc.valueCount += 1;
	let boundsChanged = false;
	if (
		acc.tempMin === null ||
		drop.start < acc.tempMin.start ||
		(drop.start === acc.tempMin.start && drop.end < acc.tempMin.end)
	) {
		acc.tempMin = drop;
		boundsChanged = true;
	}
	if (
		acc.tempMax === null ||
		drop.end > acc.tempMax.end ||
		(drop.end === acc.tempMax.end && drop.start > acc.tempMax.start)
	) {
		acc.tempMax = drop;
		boundsChanged = true;
	}
	const nextGrain =
		acc.tempFinestGrain === null
			? drop.grain
			: finestDisplayGrain(acc.tempFinestGrain, drop.grain);
	if (nextGrain !== acc.tempFinestGrain) {
		acc.tempFinestGrain = nextGrain;
		boundsChanged = true;
	}
	if (boundsChanged) {
		acc.cachedTempInterval = null;
	}
}

function buildStepMetricsFromAccumulator(
	acc: AttributeAccumulator,
	indexCount: number,
	totalIndexCount: number,
	timeZone: string,
	referenceTimeMs: number,
): AggregateStepMetrics {
	if (acc.valueCount === 0 || acc.domain === 'unknown') {
		return {
			index_count: indexCount,
			value_count: 0,
			sum: null,
			average: null,
			min: null,
			max: null,
			interval: null,
			total_index_count: totalIndexCount,
			total_value_count: 0,
			total_sum: null,
			total_average: null,
			total_min: null,
			total_max: null,
			total_interval: null,
		};
	}

	if (acc.domain === 'number') {
		const sum = acc.numSum === 0 ? 0 : acc.numSum;
		const rawAvg = sum / acc.valueCount;
		const average = rawAvg === 0 ? 0 : rawAvg;
		const min = acc.numMin === 0 ? 0 : acc.numMin;
		const max = acc.numMax === 0 ? 0 : acc.numMax;
		if (acc.cachedNumInterval === null) {
			acc.cachedNumInterval = [min, max];
		}
		return {
			index_count: indexCount,
			value_count: acc.valueCount,
			sum,
			average,
			min,
			max,
			interval: acc.cachedNumInterval,
			total_index_count: totalIndexCount,
			total_value_count: 0,
			total_sum: null,
			total_average: null,
			total_min: null,
			total_max: null,
			total_interval: null,
		};
	}

	const minDrop = acc.tempMin!;
	const maxDrop = acc.tempMax!;
	const grain = acc.tempFinestGrain ?? minDrop.grain;
	if (acc.cachedTempInterval === null) {
		acc.cachedTempInterval = buildCoveringTemporalInterval(
			minDrop,
			maxDrop,
			grain,
			timeZone,
			referenceTimeMs,
		);
	}
	return {
		index_count: indexCount,
		value_count: acc.valueCount,
		sum: null,
		average: null,
		min: minDrop,
		max: maxDrop,
		interval: acc.cachedTempInterval,
		total_index_count: totalIndexCount,
		total_value_count: 0,
		total_sum: null,
		total_average: null,
		total_min: null,
		total_max: null,
		total_interval: null,
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
	const groupedSelectors = groupSelectorsByOutputKey(selectors);
	const totalIndexCount = rows.length;

	const accumulators = groupedSelectors.map((group) => createAttributeAccumulator(group));
	const stepsByRow: AggregateStepMetrics[][] = [];

	// Pass 1: Single scan across all rows, folding all segmentPaths per grouped outputKey
	for (let i = 0; i < totalIndexCount; i++) {
		const row = rows[i];
		const indexCount = i + 1;
		const rowSteps: AggregateStepMetrics[] = [];
		for (let s = 0; s < accumulators.length; s++) {
			const acc = accumulators[s]!;
			for (const segments of acc.group.segmentPaths) {
				const rawVal = readDeepPath(row, segments);
				if (Array.isArray(rawVal)) {
					for (const candidate of rawVal) {
						feedCandidateIntoAccumulator(acc, candidate, timeZone, referenceTimeMs);
					}
				} else {
					feedCandidateIntoAccumulator(acc, rawVal, timeZone, referenceTimeMs);
				}
			}
			rowSteps.push(
				buildStepMetricsFromAccumulator(
					acc,
					indexCount,
					totalIndexCount,
					timeZone,
					referenceTimeMs,
				),
			);
		}
		stepsByRow.push(rowSteps);
	}

	// Compute whole-array `total_*` summary per attribute from final accumulator state
	const totalMetricsByAttr: AggregateTotalMetrics[] = accumulators.map((acc, s) => {
		const finalStep =
			totalIndexCount > 0
				? stepsByRow[totalIndexCount - 1]![s]!
				: buildStepMetricsFromAccumulator(
						acc,
						0,
						totalIndexCount,
						timeZone,
						referenceTimeMs,
					);
		return {
			total_index_count: totalIndexCount,
			total_value_count: finalStep.value_count,
			total_sum: finalStep.sum,
			total_average: finalStep.average,
			total_min: finalStep.min,
			total_max: finalStep.max,
			total_interval: finalStep.interval,
		};
	});

	// Pass 2: Back-patch `total_*` in-place on each stepMetrics and assemble result
	const result = [] as unknown as unknown[] & Record<string, unknown>;
	const isSingleAttr = accumulators.length === 1;

	for (let i = 0; i < totalIndexCount; i++) {
		const indexCount = i + 1;
		const stepObj: Record<string, unknown> = {};
		const rowSteps = stepsByRow[i]!;

		for (let s = 0; s < accumulators.length; s++) {
			const stepMetrics = rowSteps[s]!;
			const totals = totalMetricsByAttr[s]!;
			stepMetrics.total_value_count = totals.total_value_count;
			stepMetrics.total_sum = totals.total_sum;
			stepMetrics.total_average = totals.total_average;
			stepMetrics.total_min = totals.total_min;
			stepMetrics.total_max = totals.total_max;
			stepMetrics.total_interval = totals.total_interval;

			if (isSingleAttr) {
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

		for (let s = 0; s < accumulators.length; s++) {
			const attrKey = accumulators[s]!.group.outputKey;
			stepObj[attrKey] = rowSteps[s]!;
		}

		stepObj.index_count = indexCount;
		stepObj.total_index_count = totalIndexCount;

		result.push(stepObj);
	}

	if (isSingleAttr) {
		const totals = totalMetricsByAttr[0]!;
		result.total_value_count = totals.total_value_count;
		result.total_sum = totals.total_sum;
		result.total_average = totals.total_average;
		result.total_min = totals.total_min;
		result.total_max = totals.total_max;
		result.total_interval = totals.total_interval;
	}

	for (let s = 0; s < accumulators.length; s++) {
		const attrKey = accumulators[s]!.group.outputKey;
		const totals = totalMetricsByAttr[s]!;
		result[attrKey] = { ...totals };
	}

	result.total_index_count = totalIndexCount;

	return result;
}
