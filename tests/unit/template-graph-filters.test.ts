import { describe, expect, it } from 'vitest';
import {
	linkPathsFilter,
	lookupFilter,
	MAX_TREE_DEPTH,
	MAX_TREE_NODES,
	renderRhizomeTemplate,
	treeFilter,
} from '../../src/core/templates';

function makeNoteMatch(
	path: string,
	options?: {
		readonly up?: readonly string[];
		readonly related?: readonly string[];
		readonly prose?: readonly string[];
		readonly unresolved?: readonly string[];
		readonly properties?: Record<string, unknown>;
	},
) {
	const slash = path.lastIndexOf('/');
	const name = slash === -1 ? path : path.slice(slash + 1);
	const basename = name.replace(/\.md$/, '');
	const links = [
		...(options?.up ?? []).map((target) => ({
			link: target,
			rawTarget: target,
			resolvedPath: target,
			subpath: '',
			displayText: target,
			source: 'frontmatter' as const,
			property: 'Up',
			origin: `[[${path}|${basename}]]`,
		})),
		...(options?.related ?? []).map((target) => ({
			link: target,
			rawTarget: target,
			resolvedPath: target,
			subpath: '',
			displayText: target,
			source: 'frontmatter' as const,
			property: 'related',
			origin: `[[${path}|${basename}]]`,
		})),
		...(options?.prose ?? []).map((target) => ({
			link: target,
			rawTarget: target,
			resolvedPath: target,
			subpath: '',
			displayText: target,
			source: 'inline' as const,
			property: null,
			origin: `[[${path}|${basename}]]`,
		})),
		...(options?.unresolved ?? []).map((target) => ({
			link: target,
			rawTarget: target,
			resolvedPath: null,
			subpath: '',
			displayText: target,
			source: 'frontmatter' as const,
			property: 'Up',
			origin: `[[${path}|${basename}]]`,
		})),
	];

	return {
		file: {
			path,
			name,
			basename,
			extension: 'md',
			parent: slash === -1 ? '/' : path.slice(0, slash),
			created: '2026-10-01T00:00',
			modified: '2026-10-01T00:00',
			size: 100,
		},
		links,
		properties: { ...(options?.properties ?? {}) },
	};
}

describe('Template graph shaping filters: link_paths, lookup, tree & list integration', () => {
	it('link_paths extracts deduplicated resolvedPaths from notes or NormalizedLink arrays with case-insensitive property filtering', () => {
		const note = makeNoteMatch('Tasks/T1.md', {
			up: ['Projects/P1.md', 'Projects/P1.md', 'Projects/P2.md'],
			related: ['Notes/Ref.md'],
			prose: ['Notes/Prose.md'],
			unresolved: ['Ghost.md'],
		});

		expect(linkPathsFilter(note)).toEqual([
			'Projects/P1.md',
			'Projects/P2.md',
			'Notes/Ref.md',
			'Notes/Prose.md',
		]);
		expect(linkPathsFilter(note, 'up')).toEqual(['Projects/P1.md', 'Projects/P2.md']);
		expect(linkPathsFilter(note.links, 'RELATED')).toEqual(['Notes/Ref.md']);
		expect(linkPathsFilter(note, 'nonexistent')).toEqual([]);
	});

	it('lookup supports direct projection and inline `as` enrichment while preserving scalar vs array shape', async () => {
		const p1 = makeNoteMatch('Projects/Apollo.md', {
			properties: { code: 'AP-1', lead: 'Alice' },
		});
		const p2 = makeNoteMatch('Projects/Gemini.md', {
			properties: { code: 'GM-2', lead: 'Bob' },
		});
		const t1 = makeNoteMatch('Tasks/Stage1.md', {
			up: ['Projects/Apollo.md', 'Projects/Gemini.md'],
			properties: { projCode: 'AP-1' },
		});
		const t2 = makeNoteMatch('Tasks/Orphan.md', {
			up: [],
			properties: { projCode: 'MISSING' },
		});

		// 1. Array localSelector -> returns matched foreign array per item
		const directArr = lookupFilter([t1, t2], [p1, p2], 'links | link_paths: "up"');
		expect(directArr).toEqual([[p1, p2], []]);

		// 2. Scalar localSelector + custom foreignSelector -> returns single match or null
		const directScalar = lookupFilter(
			[t1, t2],
			[p1, p2],
			'properties.projCode',
			'properties.code',
		);
		expect(directScalar).toEqual([p1, null]);

		// 3. Inline `as` object enrichment inside a full Liquid template pipeline without mutating inputs
		const tpl = [
			'{% query projects %}#project{% endquery %}',
			'{% query tasks %}#task{% endquery %}',
			'{% assign enriched = query.tasks | lookup: query.projects, \'links | link_paths: "up" as parents\' %}',
			'{% for t in enriched %}{{ t.file.basename }}: {{ t.parents | map: "file.basename" | join: ", " }}\n{% endfor %}',
		].join('\n');

		const rendered = await renderRhizomeTemplate(tpl, {
			runQueries: async () => ({
				projects: [p1, p2],
				tasks: [t1, t2],
			}),
		});
		expect(rendered.ok).toBe(true);
		expect(rendered.markdown.trim()).toBe('Stage1: Apollo, Gemini\nOrphan:');
		expect('parents' in t1).toBe(false);
	});

	it('tree builds nested hierarchies with natural roots, explicit roots (in-set & external host), multi-parent DAGs, and deterministic cycle breaking', () => {
		const goal = makeNoteMatch('Goals/Vision.md');
		const p1 = makeNoteMatch('Projects/P1.md', { up: ['Goals/Vision.md'] });
		const p2 = makeNoteMatch('Projects/P2.md', { up: ['Goals/Vision.md'] });
		// Shared task belongs to BOTH P1 and P2 (multi-parent DAG!)
		const sharedTask = makeNoteMatch('Tasks/Shared.md', {
			up: ['Projects/P1.md', 'Projects/P2.md'],
		});

		const natural = treeFilter([goal, p1, p2, sharedTask], 'links | link_paths: "up"');
		expect(natural).toHaveLength(1);
		expect(natural[0]?.item).toBe(goal);
		expect(natural[0]?.depth).toBe(0);
		expect(natural[0]?.size).toBe(4); // p1 + sharedTask + p2 + sharedTask = 4 rendered descendants
		expect(natural[0]?.children.map((c) => c.item)).toEqual([p1, p2]);
		expect(natural[0]?.children[0]?.children.map((c) => c.item)).toEqual([sharedTask]);
		expect(natural[0]?.children[1]?.children.map((c) => c.item)).toEqual([sharedTask]);
		expect(natural[0]?.children[0]?.children[0]?.depth).toBe(2);
		expect(natural[0]?.children[0]?.children[0]?.size).toBe(0);

		// External root anchor (`goal` passed as `roots` when `items` only contains descendants `[p1, p2, sharedTask]`)
		const fromExternalHost = treeFilter([p1, p2, sharedTask], 'links | link_paths: "up"', goal);
		expect(fromExternalHost.map((n) => n.item)).toEqual([p1, p2]);
		expect(fromExternalHost[0]?.children.map((c) => c.item)).toEqual([sharedTask]);

		// Pure cycle with zero natural roots breaks deterministically at the first item in input order
		const cycA = makeNoteMatch('Cycle/A.md', { up: ['Cycle/B.md'] });
		const cycB = makeNoteMatch('Cycle/B.md', { up: ['Cycle/A.md'] });
		const broken = treeFilter([cycA, cycB], 'links | link_paths: "up"');
		expect(broken).toHaveLength(1);
		expect(broken[0]?.item).toBe(cycA);
		expect(broken[0]?.children).toHaveLength(1);
		expect(broken[0]?.children[0]?.item).toBe(cycB);
		expect(broken[0]?.children[0]?.children).toEqual([]);
	});

	it('enforces MAX_TREE_DEPTH = 64 and MAX_TREE_NODES = 10,000 against combinatorial DAG blowups', () => {
		// 1. Chain of 70 nodes truncates cleanly at depth 64
		const chain = Array.from({ length: 70 }, (_, idx) => ({
			id: `n${idx}`,
			parent: idx === 0 ? null : `n${idx - 1}`,
		}));
		const deepTree = treeFilter(chain, 'parent', undefined, 'id');
		let maxSeenDepth = 0;
		let cursor = deepTree[0];
		while (cursor) {
			maxSeenDepth = Math.max(maxSeenDepth, cursor.depth);
			cursor = cursor.children[0];
		}
		expect(maxSeenDepth).toBe(MAX_TREE_DEPTH);

		// 2. Binary-layered diamond DAG (each layer points to both nodes in previous layer -> 2^k blowup!)
		// 16 layers of 2 nodes = only 32 input items, which would materialize > 65,000 TreeNodes without MAX_TREE_NODES!
		const dagItems: Array<{ id: string; parents: string[] }> = [
			{ id: 'r0', parents: [] },
			{ id: 'r1', parents: [] },
		];
		for (let layer = 1; layer <= 16; layer++) {
			const prev = [
				`${layer === 1 ? 'r' : `l${layer - 1}_`}0`,
				`${layer === 1 ? 'r' : `l${layer - 1}_`}1`,
			];
			dagItems.push({ id: `l${layer}_0`, parents: prev });
			dagItems.push({ id: `l${layer}_1`, parents: prev });
		}
		expect(() => treeFilter(dagItems, 'parents', undefined, 'id')).toThrow(
			MAX_TREE_NODES.toLocaleString('en-US'),
		);
	});

	it('renders TreeNode hierarchies through `list` with per-level markers, pick selectors, and inline horizon', async () => {
		const goal = makeNoteMatch('Goals/Roadmap.md');
		const p1 = makeNoteMatch('Projects/Core.md', { up: ['Goals/Roadmap.md'] });
		const t1 = makeNoteMatch('Tasks/Lexer.md', { up: ['Projects/Core.md'] });
		const t2 = makeNoteMatch('Tasks/Parser.md', { up: ['Projects/Core.md'] });

		const fullTpl = [
			'{%- query items -%}{%- endquery -%}',
			'{{ query.items | tree: \'links | link_paths: "up"\' | list: "-", "1.", "-", "file.basename" }}',
		].join('');

		const res1 = await renderRhizomeTemplate(fullTpl, {
			runQueries: async () => ({ items: [goal, p1, t1, t2] }),
		});
		expect(res1.ok).toBe(true);
		expect(res1.markdown).toBe(
			['- Roadmap', '  1. Core', '    - Lexer', '    - Parser'].join('\n'),
		);

		// Inline horizon at depth 3 when only 2 style levels (`"-", "1."`) are configured
		const horizonTpl = [
			'{%- query items -%}{%- endquery -%}',
			'{{ query.items | tree: \'links | link_paths: "up"\' | list: "-", "1.", "file.basename" }}',
		].join('');
		const res2 = await renderRhizomeTemplate(horizonTpl, {
			runQueries: async () => ({ items: [goal, p1, t1, t2] }),
		});
		expect(res2.ok).toBe(true);
		expect(res2.markdown).toBe(['- Roadmap', '  1. Core', '    - Lexer and Parser'].join('\n'));

		// Vacuous parent picked field preserves descendant subtree with fallback `{...}` bullet
		const untitledGoal = makeNoteMatch('Goals/Untitled.md', { properties: {} });
		const titledChild = makeNoteMatch('Projects/Titled.md', {
			up: ['Goals/Untitled.md'],
			properties: { title: 'Visible Child' },
		});
		const vacuousParentTpl = [
			'{%- query items -%}{%- endquery -%}',
			'{{ query.items | tree: \'links | link_paths: "up"\' | list: "properties.title" }}',
		].join('');
		const res3 = await renderRhizomeTemplate(vacuousParentTpl, {
			runQueries: async () => ({ items: [untitledGoal, titledChild] }),
		});
		expect(res3.ok).toBe(true);
		expect(res3.markdown).toBe(['- {...}', '  - Visible Child'].join('\n'));
	});
});
