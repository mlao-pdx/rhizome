import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	digestBodyScanResult,
	extractDataviewInlinePropertiesFromLine,
	extractTaskFromLine,
	maskInlineCodeAndMath,
	scanNoteBody,
} from '../../src/core/scanner';
import {
	compileQuery,
	evaluateDoc,
	explainQuery,
	initEngineConfig,
	normalizeObsidianMetadata,
} from '../../src/core/search';
import { buildRhizomeTemplateContext, HOST_QUERY_KEY } from '../../src/core/templates';
import { digestNormalizedDocument } from '../../src/core/cache/doc-digest';

describe('maskInlineCodeAndMath', () => {
	it('masks single and multi-backtick code spans and inline math while preserving exact UTF-16 length', () => {
		const line =
			'Before `[fake:: 1]` middle ``[also:: `fake`]`` math $[math:: 2]$ display $$[disp:: 3]$$ after [real:: 4]';
		const masked = maskInlineCodeAndMath(line);

		expect(masked.length).toBe(line.length);
		expect(masked).not.toContain('fake');
		expect(masked).not.toContain('math::');
		expect(masked).not.toContain('disp::');
		expect(masked).toContain('[real:: 4]');
		expect(masked.indexOf('[real:: 4]')).toBe(line.indexOf('[real:: 4]'));
	});

	it('leaves currency amounts and comments unmasked', () => {
		const line = 'Cost is $5 and $10 %% [hidden:: secret] %% <!-- (htmlHidden:: val) -->';
		const masked = maskInlineCodeAndMath(line);

		expect(masked).toBe(line);
	});
});

describe('extractDataviewInlinePropertiesFromLine', () => {
	it('extracts bracketed and parenthesized fields, nested wikilinks, escaped brackets, and empty values', () => {
		const line =
			'Lead [Owner:: [[People/Alice|Alice]]] (Estimate :: 3h) [Empty::   ] [Escaped:: a \\] b] [[Wiki::NotProp]]';
		const masked = maskInlineCodeAndMath(line);
		const props = extractDataviewInlinePropertiesFromLine(line, masked, 5, 100);

		expect(props).toEqual([
			{
				key: 'Owner',
				value: '[[People/Alice|Alice]]',
				source: 'dataview',
				line: 5,
				position: {
					start: { line: 4, col: 5, offset: 105 },
					end: { line: 4, col: 37, offset: 137 },
				},
			},
			{
				key: 'Estimate',
				value: '3h',
				source: 'dataview',
				line: 5,
				position: {
					start: { line: 4, col: 38, offset: 138 },
					end: { line: 4, col: 54, offset: 154 },
				},
			},
			{
				key: 'Empty',
				value: null,
				source: 'dataview',
				line: 5,
				position: {
					start: { line: 4, col: 55, offset: 155 },
					end: { line: 4, col: 67, offset: 167 },
				},
			},
			{
				key: 'Escaped',
				value: 'a \\] b',
				source: 'dataview',
				line: 5,
				position: {
					start: { line: 4, col: 68, offset: 168 },
					end: { line: 4, col: 86, offset: 186 },
				},
			},
		]);

		// Reject empty or code-masked keys without pairing a later '::' across the rejected '::'
		const malformedLine = '[:: a:: b] [`masked`:: c:: d] [valid:: ok]';
		const malformedProps = extractDataviewInlinePropertiesFromLine(
			malformedLine,
			maskInlineCodeAndMath(malformedLine),
			1,
			0,
		);
		expect(malformedProps.map((p) => ({ key: p.key, value: p.value }))).toEqual([
			{ key: 'valid', value: 'ok' },
		]);
	});
});

describe('extractTaskFromLine & scanNoteBody', () => {
	it('parses all 11 emoji task signifiers, interleaved tags, custom properties, and trailing blockId', () => {
		const line =
			'- [x] Ship release #release/v1 [component:: core] (reviewer:: Bob) 🔺 ➕ 2026-01-01 🛫 2026-01-05 ⏳ 2026-01-10 📅 2026-01-15 ✅ 2026-01-14 ❌ 2026-01-16 🔁 every week 🏁 delete 🆔 rel-1 ⛔ dep-a, dep-b #urgent ^task-blk';
		const masked = maskInlineCodeAndMath(line);
		const task = extractTaskFromLine(line, masked, 12, 240, 10);

		expect(task).not.toBeNull();
		expect(task).toMatchObject({
			line: 12,
			status: 'x',
			statusType: 'DONE',
			completed: true,
			done: true,
			text: 'Ship release #release/v1 [component:: core] (reviewer:: Bob) #urgent',
			cleanText: 'Ship release',
			priority: 'highest',
			priorityNumber: 0,
			created: '2026-01-01',
			start: '2026-01-05',
			scheduled: '2026-01-10',
			due: '2026-01-15',
			completion: '2026-01-14',
			cancelled: '2026-01-16',
			repeat: 'every week',
			onCompletion: 'delete',
			id: 'rel-1',
			dependsOn: ['dep-a', 'dep-b'],
			tags: ['release/v1', 'urgent'],
			blockId: 'task-blk',
			parentLine: 10,
			format: 'emoji',
			properties: {
				component: 'core',
				reviewer: 'Bob',
			},
		});
	});

	it('parses all 11 Dataview task signifiers with optional trailing commas and classifies format accurately', () => {
		const dvLine =
			'1. [/] Migrate schema [priority:: high], [created:: 2026-02-01] (start:: 2026-02-02) [scheduled:: 2026-02-03] [due:: 2026-02-10] [completion:: 2026-02-09] [cancelled:: 2026-02-11] [repeat:: every 2 weeks] [onCompletion:: keep] [id:: mig-1] [dependsOn:: init-1, init-2]';
		const dvTask = extractTaskFromLine(dvLine, maskInlineCodeAndMath(dvLine), 3, 20, null);

		expect(dvTask).toMatchObject({
			line: 3,
			status: '/',
			statusType: 'IN_PROGRESS',
			completed: false,
			done: false,
			text: 'Migrate schema',
			cleanText: 'Migrate schema',
			priority: 'high',
			priorityNumber: 1,
			created: '2026-02-01',
			start: '2026-02-02',
			scheduled: '2026-02-03',
			due: '2026-02-10',
			completion: '2026-02-09',
			cancelled: '2026-02-11',
			repeat: 'every 2 weeks',
			onCompletion: 'keep',
			id: 'mig-1',
			dependsOn: ['init-1', 'init-2'],
			format: 'dataview',
		});

		const mixedLine = '> - [-] Audit logs ⏫ [due:: 2026-03-01]';
		const mixedTask = extractTaskFromLine(
			mixedLine,
			maskInlineCodeAndMath(mixedLine),
			4,
			50,
			null,
		);
		expect(mixedTask).toMatchObject({
			status: '-',
			statusType: 'CANCELLED',
			completed: false,
			done: true,
			priority: 'high',
			due: '2026-03-01',
			format: 'mixed',
		});

		const plainLine = '* [?] Investigate spike';
		const plainTask = extractTaskFromLine(
			plainLine,
			maskInlineCodeAndMath(plainLine),
			5,
			80,
			null,
		);
		expect(plainTask).toMatchObject({
			status: '?',
			statusType: 'ON_HOLD',
			completed: false,
			done: false,
			priority: 'normal',
			priorityNumber: 3,
			format: 'none',
		});

		const nonTaskLine = '+ [~] Informational item 🗓️ 2026-04-01 ⌛ 2026-03-20';
		const nonTask = extractTaskFromLine(
			nonTaskLine,
			maskInlineCodeAndMath(nonTaskLine),
			6,
			100,
			null,
		);
		expect(nonTask).toMatchObject({
			status: '~',
			statusType: 'NON_TASK',
			completed: false,
			done: true,
			due: '2026-04-01',
			scheduled: '2026-03-20',
			format: 'emoji',
		});
	});

	it('skips frontmatter, fenced code, and math blocks, preserves comments, and isolates task properties from note properties', () => {
		const markdown = [
			'---',
			'title: Demo',
			'---',
			'Note prop [status:: active] and hidden %% (secret:: 42) %%',
			'Inline code `[ignored:: 1]` and math $[ignoredMath:: 2]$',
			'```ts',
			'- [ ] Fake task inside code block [leaked:: no]',
			'[codeProp:: ignored]',
			'```',
			'$$',
			'[mathProp:: ignored]',
			'$$',
			'- [ ] Parent task [taskOnly:: alpha] 📅 2026-05-01',
			'  - [x] Child task `[due:: 2099-01-01]` [taskOnly:: beta] ^child-1',
		].join('\n');

		const scanned = scanNoteBody(markdown);
		expect(
			scanned.inlineProperties.map((p) => ({ key: p.key, value: p.value, line: p.line })),
		).toEqual([
			{ key: 'status', value: 'active', line: 4 },
			{ key: 'secret', value: '42', line: 4 },
		]);

		expect(scanned.tasks).toHaveLength(2);
		expect(scanned.tasks[0]).toMatchObject({
			line: 13,
			text: 'Parent task [taskOnly:: alpha]',
			cleanText: 'Parent task',
			due: '2026-05-01',
			parentLine: null,
			properties: { taskOnly: 'alpha' },
		});
		expect(scanned.tasks[1]).toMatchObject({
			line: 14,
			text: 'Child task `[due:: 2099-01-01]` [taskOnly:: beta]',
			cleanText: 'Child task `[due:: 2099-01-01]`',
			due: null,
			blockId: 'child-1',
			parentLine: 13,
			properties: { taskOnly: 'beta' },
		});
	});

	it('integrates scanned tasks and Dataview inline properties into normalizeObsidianMetadata, tasks: scope, and @this.tasks', () => {
		const cfgRes = initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
		if (!cfgRes.ok) throw new Error('Expected valid config');
		const config = cfgRes.config;

		const markdown = [
			'# Roadmap',
			'Owner is [owner:: Alice].',
			'- [ ] Write specification 📅 2026-06-01 [effort:: 2d]',
			'- [x] Review PR ^pr-block',
		].join('\n');

		const scanned = scanNoteBody(markdown);
		const doc = normalizeObsidianMetadata(
			{
				path: 'Projects/Roadmap.md',
				name: 'Roadmap.md',
				basename: 'Roadmap',
				extension: 'md',
				parent: { path: 'Projects' },
				stat: { ctime: 1700000000000, mtime: 1700000000000, size: markdown.length },
			},
			{
				headings: [
					{
						heading: 'Roadmap',
						level: 1,
						position: {
							start: { line: 0, col: 0, offset: 0 },
							end: { line: 0, col: 9, offset: 9 },
						},
					},
				],
				blocks: {
					'pr-block': {
						id: 'pr-block',
						position: {
							start: { line: 3, col: 0, offset: 88 },
							end: { line: 3, col: 26, offset: 114 },
						},
					},
				},
			},
			config,
			scanned.inlineProperties,
			undefined,
			scanned.tasks,
		);

		expect(doc.properties['owner']).toBe('Alice');
		expect(doc.properties['effort']).toBeUndefined();
		expect(doc.propertyLocations).toEqual([
			{
				property: 'owner',
				value: 'Alice',
				source: 'dataview',
				origin: '[[Projects/Roadmap.md#Roadmap|Roadmap]]',
			},
		]);

		expect(doc.tasks).toHaveLength(2);
		expect(doc.tasks[0]?.origin).toBe('[[Projects/Roadmap.md#Roadmap|Roadmap]]');
		expect(Object.getPrototypeOf(doc.tasks[0]?.properties)).toBeNull();
		expect(doc.tasks[0]?.properties['effort']).toBe('2d');
		expect(doc.tasks[1]?.origin).toBe('[[Projects/Roadmap.md#^pr-block|Roadmap]]');

		// Built-in tasks: / task: scope
		const q1 = compileQuery('task:specification', config, 1700000000000);
		expect(q1.executable).toBe(true);
		expect(evaluateDoc(doc, q1.prepared!)).toBe(true);

		// @this.tasks resolution
		const q2 = compileQuery('tasks:@this.tasks.0.cleanText', config, 1700000000000, doc);
		expect(q2.executable).toBe(true);
		expect(evaluateDoc(doc, q2.prepared!)).toBe(true);

		// Liquid template context exposes `this.tasks` on `◊host`
		const tplCtx = buildRhizomeTemplateContext({ [HOST_QUERY_KEY]: [doc] });
		expect((tplCtx['this'] as { tasks: unknown[] }).tasks).toEqual(doc.tasks);

		// Explain plan for tasks: scope
		const explained = explainQuery(
			'tasks:"Write specification"',
			{
				timeZone: 'UTC',
				propertyTypes: {},
			},
			1700000000000,
		);
		expect(explained).toContain('contains `Write specification`');
		expect(explained).toContain('Tasks Scope (`tasks:` / `task:`)');

		// Document digest changes when tasks change
		const docWithoutTasks = normalizeObsidianMetadata(
			{
				path: 'Projects/Roadmap.md',
				name: 'Roadmap.md',
				basename: 'Roadmap',
				extension: 'md',
				parent: { path: 'Projects' },
				stat: { ctime: 1700000000000, mtime: 1700000000000, size: markdown.length },
			},
			null,
			config,
			scanned.inlineProperties,
			undefined,
			[],
		);
		expect(digestNormalizedDocument(doc)).not.toBe(digestNormalizedDocument(docWithoutTasks));
	});

	it('property: prose-only edits that do not introduce tasks or inline properties never alter bodyDigest', () => {
		const safeProseArb = fc
			.string({ maxLength: 60 })
			.filter(
				(s) =>
					!s.includes('::') &&
					!s.includes('\n') &&
					!s.includes('\r') &&
					!/^[\s\t>]*([-*+]|[0-9]+[.)]) +\[.\]/.test(s),
			);

		fc.assert(
			fc.property(safeProseArb, safeProseArb, (proseA, proseB) => {
				const baseTask = '- [ ] Implement feature 📅 2026-07-01 [team:: core]';
				const docA = `${proseA}\n${baseTask}`;
				const docB = `${proseB}\n${baseTask}`;
				const scanA = scanNoteBody(docA);
				const scanB = scanNoteBody(docB);
				expect(scanA.inlineProperties).toEqual([]);
				expect(scanB.inlineProperties).toEqual([]);
				expect(scanA.tasks[0]?.text).toBe(scanB.tasks[0]?.text);
				expect(scanA.tasks[0]?.due).toBe(scanB.tasks[0]?.due);
				expect(scanA.tasks[0]?.properties).toEqual(scanB.tasks[0]?.properties);
			}),
			{ numRuns: 50 },
		);

		// Appending trailing prose lines after tasks/inline properties keeps line/offset of earlier items identical
		fc.assert(
			fc.property(safeProseArb, safeProseArb, (tailA, tailB) => {
				const prefix = '[status:: active]\n- [ ] Ship v1 📅 2026-08-01';
				const resA = scanNoteBody(`${prefix}\n${tailA}`);
				const resB = scanNoteBody(`${prefix}\n${tailB}`);
				expect(digestBodyScanResult(resA)).toBe(digestBodyScanResult(resB));
			}),
			{ numRuns: 50 },
		);
	});
});
