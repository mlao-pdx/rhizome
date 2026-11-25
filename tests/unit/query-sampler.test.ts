import { describe, expect, it } from 'vitest';
import {
	BASE_SAMPLE_SIZE,
	MAX_SAMPLE_SIZE,
	sampleSingleLazyQuery,
	sampleStaticQueryBatch,
	strideSampleIndices,
	type ExtractedQueryBlock,
} from '../../src/core/templates';

const SPAN = Object.freeze({ startOffset: 0, endOffset: 1, startLine: 1, startColumn: 1 });

function makeQueryBlock(name: string, cutoff = 5_000, explicitCutoff = false): ExtractedQueryBlock {
	return Object.freeze({
		name,
		query: `#${name}`,
		cutoff,
		explicitCutoff,
		headerSpan: SPAN,
		bodySpan: SPAN,
		fullSpan: SPAN,
		file: null,
	});
}

describe('query-sampler (Two-Phase Deterministic RI Sampling)', () => {
	it('computes strictly increasing midpoint-stride indices and keeps <= 100 matches untouched', () => {
		expect(strideSampleIndices(0, 100)).toEqual([]);
		expect(strideSampleIndices(5, 100)).toEqual([0, 1, 2, 3, 4]);

		const s100 = strideSampleIndices(1_000, BASE_SAMPLE_SIZE);
		expect(s100).toHaveLength(100);
		expect(s100[0]).toBe(5);
		expect(s100[99]).toBe(995);
		for (let i = 1; i < s100.length; i++) {
			expect(s100[i]!).toBeGreaterThan(s100[i - 1]!);
		}
	});

	it('preserves cross-query link_paths / lookup referential integrity up to 500 records in original vault order without cascading from augmented sets', () => {
		const projects = Array.from({ length: 10 }, (_, idx) => ({
			file: { path: `Projects/P${idx}.md`, basename: `P${idx}` },
			// P0 links out to Tasks/T501.md..T550.md (which are NOT hit by 100-stride on 1,000 tasks)
			links:
				idx === 0
					? Array.from({ length: 50 }, (__, k) => ({
							resolvedPath: `Tasks/T${k * 10 + 1}.md`,
						}))
					: [],
			embeds: idx === 1 ? [{ resolvedPath: 'Tasks/T777.md' }] : [],
			backlinks: idx === 2 ? [{ path: 'Tasks/T888.md' }] : [],
		}));

		const tasks = Array.from({ length: 1_000 }, (_, idx) => ({
			file: { path: `Tasks/T${idx}.md`, basename: `T${idx}` },
			// T777 links to Subtasks/S333.md — must NOT cascade into LinkedPaths because T777 was only added in Phase 2!
			links: idx === 777 ? [{ resolvedPath: 'Subtasks/S333.md' }] : [],
			embeds: [],
			backlinks: [],
		}));

		const subtasks = Array.from({ length: 1_000 }, (_, idx) => ({
			file: { path: `Subtasks/S${idx}.md`, basename: `S${idx}` },
			links: [],
			embeds: [],
			backlinks: [],
		}));

		const res = sampleStaticQueryBatch(
			[makeQueryBlock('projects'), makeQueryBlock('tasks'), makeQueryBlock('subtasks')],
			{ projects, tasks, subtasks },
		);

		const sampledTasks = res.sampledPayload['tasks'] as Array<{ file: { path: string } }>;
		const taskMetrics = res.metricsByName.get('tasks')!;
		expect(taskMetrics.matchedCount).toBe(1_000);
		expect(taskMetrics.baseStrideCount).toBe(100);
		expect(taskMetrics.referentialTopUpCount).toBe(52); // 50 links + T777 + T888
		expect(taskMetrics.sampledCount).toBe(152);
		expect(taskMetrics.downsampled).toBe(true);

		const sampledPaths = sampledTasks.map((r) => r.file.path);
		expect(sampledPaths).toContain('Tasks/T777.md');
		expect(sampledPaths).toContain('Tasks/T888.md');
		expect(sampledPaths).toContain('Tasks/T1.md');

		// Verify strict original vault order is preserved
		const indicesInFull = sampledPaths.map((p) => Number(p.slice('Tasks/T'.length, -3)));
		for (let i = 1; i < indicesInFull.length; i++) {
			expect(indicesInFull[i]!).toBeGreaterThan(indicesInFull[i - 1]!);
		}

		// Non-cascading check: Subtasks/S333.md was NOT pulled into subtasks because T777 was not in Base_tasks
		const sampledSubtasks = res.sampledPayload['subtasks'] as Array<{ file: { path: string } }>;
		expect(sampledSubtasks).toHaveLength(100);
		expect(sampledSubtasks.some((s) => s.file.path === 'Subtasks/S333.md')).toBe(false);
	});

	it('caps Phase-2 RI top-up at MAX_SAMPLE_SIZE (500) and obeys cutoff vs sample precedence', () => {
		const hub = [
			{
				file: { path: 'Hub.md' },
				links: Array.from({ length: 800 }, (_, idx) => ({
					resolvedPath: `Notes/N${idx}.md`,
				})),
			},
		];
		const notes = Array.from({ length: 1_000 }, (_, idx) => ({
			file: { path: `Notes/N${idx}.md` },
		}));

		const cappedRes = sampleStaticQueryBatch([makeQueryBlock('hub'), makeQueryBlock('notes')], {
			hub,
			notes,
		});
		expect(cappedRes.metricsByName.get('notes')?.sampledCount).toBe(MAX_SAMPLE_SIZE);
		expect(cappedRes.calloutsMarkdown).toBe('');

		// Explicit cutoff <= 100 (`cutoff: 25`) slices in vault order and EMITS runtime cutoff callout
		const smallCutoffRes = sampleStaticQueryBatch(
			[makeQueryBlock('notes', 25, true)],
			{ notes },
			{ sourcePath: 'Host.md' },
		);
		const m25 = smallCutoffRes.metricsByName.get('notes')!;
		expect(m25.cutoffBound).toBe(true);
		expect(m25.sampledCount).toBe(25);
		expect(smallCutoffRes.calloutsMarkdown).toContain(
			'> [!warning]- Query `notes` 1,000 matches; cut-off at 25',
		);

		// Default cutoff (`5,000`) on `6,000` matches suppresses runtime callout in sample preview while flagging exceedsProductionCutoff
		const notes6000 = Array.from({ length: 6_000 }, (_, idx) => ({
			file: { path: `Notes/N${idx}.md` },
		}));
		const overProdCutoffRes = sampleStaticQueryBatch([makeQueryBlock('notes')], {
			notes: notes6000,
		});
		const m6000 = overProdCutoffRes.metricsByName.get('notes')!;
		expect(m6000.cutoffBound).toBe(false);
		expect(m6000.exceedsProductionCutoff).toBe(true);
		expect(m6000.sampledCount).toBe(100);
		expect(overProdCutoffRes.calloutsMarkdown).toBe('');

		// Lazy query sampling augments LinkedPaths for subsequent lazy queries
		const lazyRes = sampleSingleLazyQuery(
			makeQueryBlock('lazyNotes'),
			notes,
			cappedRes.linkedPaths,
		);
		expect(lazyRes.metrics.sampledCount).toBe(MAX_SAMPLE_SIZE);
	});
});
