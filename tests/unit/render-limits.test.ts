import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	MAX_TEMPLATE_OUTPUT_CHARS,
	parsedTemplateHasLoopTag,
	parseRhizomeTemplatePass1,
	parseRhizomeTemplatePass1Async,
	renderParsedRhizomeTemplate,
	renderRhizomeTemplate,
	RenderTelemetryCollector,
	TEMPLATE_RENDER_LIMIT_MS,
} from '../../src/core/templates';

describe('LiquidJS Pass 2 Render Safeguards (5,000 ms & 3.25 MiB)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('exports calibrated fixed constants', () => {
		expect(TEMPLATE_RENDER_LIMIT_MS).toBe(5_000);
		expect(MAX_TEMPLATE_OUTPUT_CHARS).toBe(3_407_872);
	});

	it('aborts root output exceeding 3.25 MiB with TEMPLATE_RENDER_ERROR and actionable hint', async () => {
		const chunk = 'x'.repeat(100_000);
		const items = new Array(36).fill(chunk);
		const parsed = parseRhizomeTemplatePass1(
			'{% query q %}#x{% endquery %}{% for item in query.q %}{{ item }}{% endfor %}',
		);

		const res = await renderParsedRhizomeTemplate(
			'{% query q %}#x{% endquery %}{% for item in query.q %}{{ item }}{% endfor %}',
			parsed,
			{ q: items },
		);

		expect(res.ok).toBe(false);
		expect(res.diagnostics).toHaveLength(1);
		expect(res.diagnostics[0]?.code).toBe('TEMPLATE_RENDER_ERROR');
		expect(res.diagnostics[0]?.issue).toContain('3.25 MiB');
		expect(res.diagnostics[0]?.hint).toContain('Narrow the query');
	});

	it('enforces the cumulative 3.25 MiB BoundedEmitter cap inside {% capture %}, {% render %}, and {% layout %}', async () => {
		const chunk = 'a'.repeat(100_000);
		const items = new Array(36).fill(chunk);

		// 1. {% capture %} loop that overwrites a variable without emitting to root
		const captureSource =
			'{% query q %}#x{% endquery %}{% for item in query.q %}{% capture buf %}{{ item }}{% endcapture %}{% endfor %}done';
		const captureRes = await renderRhizomeTemplate(captureSource, {
			runQueries: async () => ({ q: items }),
		});
		expect(captureRes.ok).toBe(false);
		expect(captureRes.diagnostics[0]?.code).toBe('TEMPLATE_RENDER_ERROR');
		expect(captureRes.diagnostics[0]?.issue).toContain('3.25 MiB');

		// 2. {% render 'row' %} partial blowup
		const files = new Map<string, string>([
			['◊Rhizome/partials/row.md', '{{ val }}'],
			['◊Rhizome/layouts/frame.md', 'Header\n{% block %}{% endblock %}\nFooter'],
		]);
		const partialSource =
			"{% query q %}#x{% endquery %}{% for item in query.q %}{% render 'row', val: item %}{% endfor %}";
		const partialRes = await renderRhizomeTemplate(partialSource, {
			runQueries: async () => ({ q: items }),
			readTemplateFile: async (p) => files.get(p) ?? null,
		});
		expect(partialRes.ok).toBe(false);
		expect(partialRes.diagnostics[0]?.code).toBe('TEMPLATE_RENDER_ERROR');
		expect(partialRes.diagnostics[0]?.issue).toContain('3.25 MiB');

		// 3. {% layout 'frame' %} body blowup
		const layoutSource =
			"{% layout 'frame' %}{% query q %}#x{% endquery %}{% for item in query.q %}{{ item }}{% endfor %}";
		const layoutRes = await renderRhizomeTemplate(layoutSource, {
			runQueries: async () => ({ q: items }),
			readTemplateFile: async (p) => files.get(p) ?? null,
		});
		expect(layoutRes.ok).toBe(false);
		expect(layoutRes.diagnostics[0]?.code).toBe('TEMPLATE_RENDER_ERROR');
		expect(layoutRes.diagnostics[0]?.issue).toContain('3.25 MiB');

		// 4. Separate true-size accounting: ~2.5 MiB (2,600,000 chars, >50% of 3.25 MiB) succeeds
		// in BOTH {% layout %} and {% capture %} + {{ buf }} without double-charging!
		const items25Mb = new Array(26).fill(chunk);
		const layoutTrueSizeRes = await renderRhizomeTemplate(layoutSource, {
			runQueries: async () => ({ q: items25Mb }),
			readTemplateFile: async (p) => files.get(p) ?? null,
		});
		expect(layoutTrueSizeRes.ok).toBe(true);
		expect(layoutTrueSizeRes.markdown.length).toBeGreaterThan(2_600_000);

		const capturePrintSource =
			'{% query q %}#x{% endquery %}{% capture buf %}{% for item in query.q %}{{ item }}{% endfor %}{% endcapture %}{{ buf }}';
		const captureTrueSizeRes = await renderRhizomeTemplate(capturePrintSource, {
			runQueries: async () => ({ q: items25Mb }),
		});
		expect(captureTrueSizeRes.ok).toBe(true);
		expect(captureTrueSizeRes.markdown.length).toBe(2_600_000);

		// 5. Direct array stringification ({{ query.q }}) enforces remaining character budget incrementally
		let stringifiedElements = 0;
		const trackedArray = Array.from({ length: 40 }, () => ({
			toString() {
				stringifiedElements += 1;
				return chunk;
			},
		}));
		const directArrayRes = await renderRhizomeTemplate(
			'{% query q %}#x{% endquery %}{{ query.q }}',
			{
				runQueries: async () => ({ q: trackedArray }),
			},
		);
		expect(directArrayRes.ok).toBe(false);
		expect(directArrayRes.diagnostics[0]?.code).toBe('TEMPLATE_RENDER_ERROR');
		expect(stringifiedElements).toBeLessThan(40);
	});

	it.each([
		['list', '{{ query.q | list }}'],
		['table', '{{ query.q | table }}'],
		['heading', '{{ query.q | heading }}'],
		['sentence', '{{ query.q | map: "body" | sentence }}'],
	])(
		'enforces the 3.25 MiB output cap inside custom %s filter before allocating oversized Markdown',
		async (_filterName, expr) => {
			const bigVal = 'z'.repeat(100_000);
			const rows = new Array(36).fill({ body: bigVal });
			const source = `{% query q %}#x{% endquery %}${expr}`;
			const parsed = parseRhizomeTemplatePass1(source);

			const res = await renderParsedRhizomeTemplate(source, parsed, { q: rows });

			expect(res.ok).toBe(false);
			expect(res.diagnostics[0]?.code).toBe('TEMPLATE_RENDER_ERROR');
			expect(res.diagnostics[0]?.issue).toContain('3.25 MiB');
			expect(res.diagnostics[0]?.hint).toContain('Narrow the query');
		},
	);

	it('enforces the 5,000 ms renderLimit across Liquid {% for %} loops with actionable hint', async () => {
		let fakeNow = 1_000;
		vi.spyOn(performance, 'now').mockImplementation(() => {
			fakeNow += 2_000;
			return fakeNow;
		});

		const source =
			'{% query q %}#x{% endquery %}{% for item in query.q %}{{ item }}{% endfor %}';
		const parsed = parseRhizomeTemplatePass1(source);
		const res = await renderParsedRhizomeTemplate(source, parsed, {
			q: ['a', 'b', 'c', 'd', 'e'],
		});

		expect(res.ok).toBe(false);
		expect(res.diagnostics[0]?.code).toBe('TEMPLATE_RENDER_ERROR');
		expect(res.diagnostics[0]?.issue).toContain('5,000 ms');
		expect(res.diagnostics[0]?.hint).toContain('Narrow the query');
	});

	it.each([
		['sort', '{{ query.q | sort: "n" | size }}'],
		['sort_natural', '{{ query.q | sort_natural: "s" | size }}'],
		['group_by', '{{ query.q | group_by: "s" | size }}'],
		['where', '{{ query.q | where: "s", "match" | size }}'],
		['reject', '{{ query.q | reject: "s", "match" | size }}'],
		['map', '{{ query.q | map: "s" | size }}'],
		['uniq', '{{ query.q | uniq: "s" | size }}'],
		['pick', '{{ query.q | pick: "s" | size }}'],
		['aggregate', '{{ query.q | aggregate: "n" | size }}'],
		['list', '{{ query.q | list }}'],
		['table', '{{ query.q | table }}'],
		['heading', '{{ query.q | heading }}'],
	])(
		'enforces the 5,000 ms renderLimit inside custom %s filter every 1,024 items',
		async (_name, expr) => {
			const rows = Array.from({ length: 2_500 }, (_, i) => ({
				n: 2_500 - i,
				s: `item-${i}`,
			}));
			const source = `{% query q %}#x{% endquery %}${expr}`;
			const parsed = parseRhizomeTemplatePass1(source);

			let fakeNow = 10_000;
			let calls = 0;
			vi.spyOn(performance, 'now').mockImplementation(() => {
				calls += 1;
				// First few calls establish Context.renderLimit deadline; subsequent filter stride check crosses +5,000 ms
				if (calls > 2) {
					fakeNow += 6_000;
				}
				return fakeNow;
			});

			const res = await renderParsedRhizomeTemplate(source, parsed, { q: rows });

			expect(res.ok).toBe(false);
			expect(res.diagnostics[0]?.code).toBe('TEMPLATE_RENDER_ERROR');
			expect(res.diagnostics[0]?.issue).toContain('5,000 ms');
			expect(res.diagnostics[0]?.hint).toContain('Narrow the query');
		},
	);

	it('parsedTemplateHasLoopTag detects for/tablerow in inline or partial templates while ignoring comments and raw blocks', async () => {
		const summary = '{% query q %}#x{% endquery %}Count: {{ query.q.size }}';
		expect(parsedTemplateHasLoopTag(summary, parseRhizomeTemplatePass1(summary))).toBe(false);

		const commented =
			'{% comment %}{% for x in query.q %}{{ x }}{% endfor %}{% endcomment %}{{ vault }}';
		expect(parsedTemplateHasLoopTag(commented, parseRhizomeTemplatePass1(commented))).toBe(
			false,
		);

		const rawBlock = '{% raw %}{% tablerow x in query.q %}{{ x }}{% endtablerow %}{% endraw %}';
		expect(parsedTemplateHasLoopTag(rawBlock, parseRhizomeTemplatePass1(rawBlock))).toBe(false);

		const inlineFor = '{% for x in query.q %}{{ x }}{% endfor %}';
		expect(parsedTemplateHasLoopTag(inlineFor, parseRhizomeTemplatePass1(inlineFor))).toBe(
			true,
		);

		const inlineTablerow = '{%- tablerow x in query.q %}{{ x }}{% endtablerow -%}';
		expect(
			parsedTemplateHasLoopTag(inlineTablerow, parseRhizomeTemplatePass1(inlineTablerow)),
		).toBe(true);

		const partialSource = "{% render 'loop-list' %}";
		const parsedWithPartial = await parseRhizomeTemplatePass1Async(
			partialSource,
			undefined,
			async (path) =>
				path === '◊Rhizome/partials/loop-list.md'
					? '{% for item in query.q %}- {{ item }}\n{% endfor %}'
					: null,
		);
		expect(parsedTemplateHasLoopTag(partialSource, parsedWithPartial)).toBe(true);
	});

	it('enforces the 3.25 MiB cap across staged frontmatter + Markdown and records AST telemetry & failing partial call stacks', async () => {
		const bigText = 'm'.repeat(2_000_000);
		const fmOverflowSource =
			'{% query q %}#x{% endquery %}{% assign big = query.q[0] %}{% frontmatter "big as body_copy" %}{{ big }}';
		const fmOverflowRes = await renderRhizomeTemplate(fmOverflowSource, {
			runQueries: async () => ({ q: [bigText] }),
			runtimeContext: { trigger: 'newNote', timeZone: 'UTC' },
		});
		expect(fmOverflowRes.ok).toBe(false);
		expect(fmOverflowRes.diagnostics[0]?.code).toBe('TEMPLATE_RENDER_ERROR');
		expect(fmOverflowRes.diagnostics[0]?.issue).toContain('3.25 MiB');

		// Telemetry collector captures loop deltas, ignores unrendered {% capture %}, and records 2nd {% render %} failure
		const files = new Map<string, string>([
			[
				'◊Rhizome/partials/row.md',
				'{% if fail %}{{ today..yesterday }}{% else %}{{ val }}{% endif %}',
			],
		]);
		const telemetrySource = [
			'{% query q %}#x{% endquery %}',
			'{% capture hidden %}{{ "ignored" }}{% endcapture %}',
			'{% for x in query.q %}{{ x }}{% endfor %}',
			"{% render 'row', val: 'ok', fail: false %}",
			"{% render 'row', val: 'ok2', fail: false %}",
		].join('\n');
		const parsed = await parseRhizomeTemplatePass1Async(
			telemetrySource,
			undefined,
			async (p) => files.get(p) ?? null,
		);
		const collector = new RenderTelemetryCollector();
		const okRes = await renderParsedRhizomeTemplate(
			telemetrySource,
			parsed,
			{ q: ['hello', 'world'] },
			undefined,
			undefined,
			{ telemetry: collector },
		);
		expect(okRes.ok).toBe(true);
		expect(collector.rootNodeChars.size).toBeGreaterThan(0);

		const fail2Source = [
			'{% query q %}#x{% endquery %}',
			"{% render 'row', val: 'ok', fail: false %}",
			"{% render 'row', val: 'boom', fail: true %}",
		].join('\n');
		const parsed2 = await parseRhizomeTemplatePass1Async(
			fail2Source,
			undefined,
			async (p) => files.get(p) ?? null,
		);
		const collector2 = new RenderTelemetryCollector();
		const errRes = await renderParsedRhizomeTemplate(
			fail2Source,
			parsed2,
			{ q: ['hello'] },
			undefined,
			undefined,
			{ telemetry: collector2 },
		);
		expect(errRes.ok).toBe(false);
		expect(collector2.failedRenderCallStack).not.toBeNull();
		expect(collector2.failedRenderCallStack).toHaveLength(1);
	});
});
