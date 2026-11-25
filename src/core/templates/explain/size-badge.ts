import type { QuerySampleMetrics } from '../query-sampler';
import { MAX_TEMPLATE_OUTPUT_CHARS } from '../render-limits';

/**
 * Minimum extrapolated character emission (`500 B`) required to display an inline `[~...]` size badge.
 */
export const SIZE_BADGE_NOISE_FLOOR_CHARS = 500;

/**
 * Minimum AST-node character emission (`50 KB` / `51,200` chars) required to qualify as a hotspot.
 */
export const HOTSPOT_MIN_CHARS = 51_200;

/**
 * Minimum fraction (`25%`) of total block output required (alongside `HOTSPOT_MIN_CHARS`) to flag a hotspot.
 */
export const HOTSPOT_OUTPUT_SHARE = 0.25;

/**
 * Extrapolated full-scale output warning threshold (`2.5 MB` / `2,621,440` chars, below the `3.25 MB` cap).
 */
export const EXTRAPOLATED_SIZE_WARN_CHARS = 2_621_440;

const KB_STEP = 1024;
const MB_STEP = 1024 * 1024;
const UNIT_STEP_THRESHOLD = 500;

function formatOneDecimalMax(val: number): string {
	return val.toFixed(1).replace(/\.0$/, '');
}

/**
 * Formats a character count per Spec §7.4.2: `B`, `KB`, and `MB` using `1024` steps, stepping up
 * to the next unit whenever the displayed value reaches `>= 500`, with at most 3 digits before
 * and 1 digit after the decimal point (e.g. `499 B`, `0.5 KB`, `12.4 KB`, `499.9 KB`, `0.5 MB`).
 */
export function formatHumanCharSize(chars: number): string {
	const safe = Math.max(0, Math.round(chars));
	if (safe < UNIT_STEP_THRESHOLD) {
		return `${safe} B`;
	}
	const inKb = safe / KB_STEP;
	const roundedKb = Math.round(inKb * 10) / 10;
	if (roundedKb < UNIT_STEP_THRESHOLD) {
		return `${formatOneDecimalMax(Math.max(0.5, roundedKb))} KB`;
	}
	const inMb = safe / MB_STEP;
	const roundedMb = Math.round(inMb * 10) / 10;
	return `${formatOneDecimalMax(Math.max(0.5, roundedMb))} MB`;
}

/**
 * Computes the post-cutoff production-to-sample scale ratio `min(matchedCount, effectiveCutoff) / sampledCount`
 * for a given `queryName` (or `1` when unsampled / unknown).
 */
export function resolveQueryScaleFactor(
	queryName: string | null | undefined,
	metricsByName: ReadonlyMap<string, QuerySampleMetrics>,
): number {
	if (!queryName) {
		return 1;
	}
	const m = metricsByName.get(queryName);
	if (!m || !m.downsampled || m.sampledCount <= 0) {
		return 1;
	}
	const prodCount = Number.isFinite(m.effectiveCutoff)
		? Math.min(m.matchedCount, m.effectiveCutoff)
		: m.matchedCount;
	return Math.max(1, prodCount / m.sampledCount);
}

/**
 * Formats a compact inline AST-node size badge (` [~1.2 KB]`, or ` · ⚠️ [~1.2 MB]` on hotspots),
 * scaling `sampleChars` by `scaleFactor` (driving query's post-cutoff production-to-sample ratio).
 */
export function formatNodeSizeBadge(
	sampleChars: number,
	totalSampleChars: number,
	scaleFactor = 1,
): string {
	const effectiveChars = Math.round(sampleChars * Math.max(1, scaleFactor));
	if (effectiveChars < SIZE_BADGE_NOISE_FLOOR_CHARS) {
		return '';
	}
	const sizeLabel = formatHumanCharSize(effectiveChars);
	const isHotspot =
		effectiveChars >= EXTRAPOLATED_SIZE_WARN_CHARS ||
		(sampleChars >= HOTSPOT_MIN_CHARS &&
			totalSampleChars > 0 &&
			sampleChars / totalSampleChars >= HOTSPOT_OUTPUT_SHARE);
	if (isHotspot) {
		return ` · ⚠️ [~${sizeLabel}]`;
	}
	return ` [~${sizeLabel}]`;
}

/**
 * Extrapolated full-scale output size estimate computed across attributed and unattributed emissions.
 */
export interface FullScaleSizeEstimate {
	readonly hasDownsampledQueries: boolean;
	readonly estimatedFullChars: number;
	readonly estimatedUncappedChars: number | null;
	readonly exceedsWarningThreshold: boolean;
	readonly exceedsHardCap: boolean;
}

/**
 * Computes full-scale production output size by summing fixed/unattributed characters alongside
 * per-query attributed variable emissions scaled by each driving query's `min(M, effectiveCutoff) / S`
 * ratio (and uncapped `M / S` when `M > cutoff`).
 */
export function estimateFullScaleOutput(
	sampleTotalChars: number,
	attributedSampleCharsByQuery: ReadonlyMap<string, number>,
	metricsByName: ReadonlyMap<string, QuerySampleMetrics>,
): FullScaleSizeEstimate {
	let hasDownsampled = false;
	let anyExceedsCutoff = false;
	let totalAttributedSample = 0;
	let scaledCappedSum = 0;
	let scaledUncappedSum = 0;

	for (const m of metricsByName.values()) {
		if (m.downsampled && m.sampledCount > 0) {
			hasDownsampled = true;
		}
		if (m.exceedsProductionCutoff && m.sampledCount > 0) {
			anyExceedsCutoff = true;
		}
	}

	for (const [qName, sampleChars] of attributedSampleCharsByQuery) {
		if (sampleChars <= 0) continue;
		totalAttributedSample += sampleChars;
		const m = metricsByName.get(qName);
		if (m && m.sampledCount > 0 && (m.downsampled || m.exceedsProductionCutoff)) {
			const prodCount = Number.isFinite(m.effectiveCutoff)
				? Math.min(m.matchedCount, m.effectiveCutoff)
				: m.matchedCount;
			const cappedRatio = Math.max(1, prodCount / m.sampledCount);
			const uncappedRatio = Math.max(1, m.matchedCount / m.sampledCount);
			scaledCappedSum += sampleChars * cappedRatio;
			scaledUncappedSum += sampleChars * uncappedRatio;
		} else {
			scaledCappedSum += sampleChars;
			scaledUncappedSum += sampleChars;
		}
	}

	const unattributedChars = Math.max(0, sampleTotalChars - totalAttributedSample);
	const estimatedFullChars = Math.round(unattributedChars + scaledCappedSum);
	const estimatedUncappedChars = anyExceedsCutoff
		? Math.round(unattributedChars + scaledUncappedSum)
		: null;

	return Object.freeze({
		hasDownsampledQueries: hasDownsampled,
		estimatedFullChars,
		estimatedUncappedChars,
		exceedsWarningThreshold: estimatedFullChars >= EXTRAPOLATED_SIZE_WARN_CHARS,
		exceedsHardCap: estimatedFullChars > MAX_TEMPLATE_OUTPUT_CHARS,
	});
}
