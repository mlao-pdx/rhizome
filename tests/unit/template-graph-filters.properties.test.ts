import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	isTreeNode,
	linkPathsFilter,
	listFilter,
	lookupFilter,
	MAX_TREE_DEPTH,
	type TreeNode,
	treeFilter,
} from '../../src/core/templates';
import { assertProperty } from '../support/assertProperty';

function countDescendants(node: TreeNode): number {
	let total = 0;
	for (const child of node.children) {
		total += 1 + countDescendants(child);
	}
	return total;
}

function collectVisitedIds(nodes: readonly TreeNode[], out = new Set<string>()): Set<string> {
	for (const node of nodes) {
		const rec = node.item as { id: string };
		out.add(rec.id);
		collectVisitedIds(node.children, out);
	}
	return out;
}

function assertAcyclicAndDepthInvariants(
	nodes: readonly TreeNode[],
	expectedDepth: number,
	ancestors = new Set<string>(),
): void {
	for (const node of nodes) {
		expect(isTreeNode(node)).toBe(true);
		expect(node.depth).toBe(expectedDepth);
		expect(node.depth).toBeLessThanOrEqual(MAX_TREE_DEPTH);
		expect(node.size).toBe(countDescendants(node));

		const id = (node.item as { id: string }).id;
		expect(ancestors.has(id)).toBe(false);
		ancestors.add(id);
		assertAcyclicAndDepthInvariants(node.children, expectedDepth + 1, ancestors);
		ancestors.delete(id);
	}
}

describe('Template graph filters property invariants', () => {
	it('treeFilter terminates acyclically, preserves exact descendant sizes, visits every item when roots is omitted, and renders cleanly via listFilter', async () => {
		const graphItemsArb = fc
			.integer({ min: 0, max: 10 })
			.chain((n) =>
				fc.array(
					fc.subarray(
						Array.from({ length: n }, (_, k) => `node_${k}`),
						{ maxLength: Math.min(2, n) },
					),
					{ minLength: n, maxLength: n },
				),
			)
			.map((parentsPerNode) =>
				parentsPerNode.map((parents, idx) => ({
					id: `node_${idx}`,
					title: `Item ${idx}`,
					parents,
				})),
			);

		await assertProperty(
			'templates/graph-filters__tree-acyclic-completeness-and-list-rendering',
			fc.property(graphItemsArb, (items) => {
				const snapshotBefore = JSON.stringify(items);
				const roots = treeFilter(items, 'parents', undefined, 'id');

				// Non-mutation of input items
				expect(JSON.stringify(items)).toBe(snapshotBefore);

				// Every branch is strictly cycle-free and depth/size are exact
				assertAcyclicAndDepthInvariants(roots, 0);

				// When `roots` is omitted, every input item appears at least once (including pure/disconnected cycles)
				const visited = collectVisitedIds(roots);
				expect(visited.size).toBe(items.length);

				// Rendering through `listFilter` produces clean Markdown without throwing
				const md = listFilter(roots, 'title');
				if (items.length === 0) {
					expect(md).toBe('');
				} else {
					for (const item of items) {
						expect(md).toContain(item.title);
					}
				}
			}),
		);
	});

	it('lookupFilter and linkPathsFilter preserve non-mutation, deduplication, and scalar vs array shape invariants', async () => {
		const linkListArb = fc.array(
			fc.record({
				resolvedPath: fc.option(fc.constantFrom('a.md', 'b.md', 'c.md'), { nil: null }),
				property: fc.option(fc.constantFrom('up', 'Up', 'UP', 'related'), { nil: null }),
			}),
			{ maxLength: 8 },
		);

		await assertProperty(
			'templates/graph-filters__link-paths-and-lookup-shape-invariants',
			fc.property(linkListArb, (links) => {
				const note = { file: { path: 'self.md' }, links };
				const before = JSON.stringify(note);

				const allPaths = linkPathsFilter(note);
				const upPaths = linkPathsFilter(note, 'up');

				expect(JSON.stringify(note)).toBe(before);
				expect(new Set(allPaths).size).toBe(allPaths.length);
				expect(new Set(upPaths).size).toBe(upPaths.length);
				for (const p of upPaths) {
					expect(allPaths).toContain(p);
				}

				const foreign = [
					{ file: { path: 'a.md', basename: 'A' } },
					{ file: { path: 'b.md', basename: 'B' } },
				];
				const arrProjected = lookupFilter(
					[note],
					foreign,
					'links | link_paths: "up"',
				) as unknown[];
				expect(Array.isArray(arrProjected[0])).toBe(true);

				const scalarProjected = lookupFilter(
					[{ target: 'a.md' }, { target: 'missing.md' }],
					foreign,
					'target',
				) as unknown[];
				expect(scalarProjected[0]).toBe(foreign[0]);
				expect(scalarProjected[1]).toBeNull();
			}),
		);
	});
});
