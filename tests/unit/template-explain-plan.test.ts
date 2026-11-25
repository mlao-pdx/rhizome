import { describe, expect, it } from 'vitest';
import {
	buildTemplateExplainPlanCallout,
	formatHumanCharSize,
	formatNodeSizeBadge,
	parseRhizomeTemplatePass1Async,
	renderParsedRhizomeTemplate,
	RenderTelemetryCollector,
} from '../../src/core/templates';

describe('Template Explain Plan & Spec §§7.2-7.4 Rules', () => {
	it('formats B/KB/MB units with >= 500 step-up and scales [~...] badges by driving query ratio', () => {
		expect(formatHumanCharSize(499)).toBe('499 B');
		expect(formatHumanCharSize(500)).toBe('0.5 KB');
		expect(formatHumanCharSize(12_700)).toBe('12.4 KB');
		expect(formatHumanCharSize(511_900)).toBe('499.9 KB');
		expect(formatHumanCharSize(512_000)).toBe('0.5 MB');

		// Unscaled 100 chars < 500 B noise floor -> empty; scaled 10x (1,000 B) -> ` [~1 KB]`
		expect(formatNodeSizeBadge(100, 1_000, 1)).toBe('');
		expect(formatNodeSizeBadge(100, 1_000, 10)).toBe(' [~1 KB]');
	});

	it('summarizes loops once without unrolling, expands Simple partials on 1st call & collapses 2nd+, expands Complex partials on 2nd+ calls in nested callout boxes, and checks caller scope, shadowing, & null template.*', async () => {
		const files = new Map<string, string>([
			[
				'◊Rhizome/partials/card.md',
				'- {{ item.file.basename }} (leak={{ outer_secret }} typo={{ non_existent_global }})\n{% assign targetPath = "shadow" %}\n{% frontmatter "\'touched\' as status" %}',
			],
			[
				'◊Rhizome/partials/complex.md',
				'{% if flag %}{{ template.file.basename }}{% endif %}',
			],
		]);
		const source = [
			'{% assign outer_secret = "hidden" %}',
			'{% query items %}#item{% endquery %}',
			'{% heading 2 %}',
			'{{ "Section" | heading }}',
			'{% for row in query.items %}',
			'  {% render "card", item: row %}',
			'{% endfor %}',
			'{% render "card", item: query.items[0] %}',
			'{% render "complex", flag: true %}',
			'{% render "complex", flag: false %}',
			'{% endheading %}',
		].join('\n');

		const parsed = await parseRhizomeTemplatePass1Async(
			source,
			undefined,
			async (p) => files.get(p) ?? null,
		);
		const telemetry = new RenderTelemetryCollector();
		const rows = Array.from({ length: 10 }, (_, idx) => ({
			file: { basename: `Item_${String(idx).padStart(2, '0')}_${'x'.repeat(50)}` },
		}));
		const renderRes = await renderParsedRhizomeTemplate(
			source,
			parsed,
			{ items: rows },
			{ headingLevel: 1, trigger: 'dynamicCodeblock', template: null },
			undefined,
			{ allowFailedQueries: true, telemetry },
		);

		const plan = buildTemplateExplainPlanCallout({
			source,
			parsed,
			renderResult: renderRes,
			runtimeContext: { headingLevel: 1, trigger: 'dynamicCodeblock', template: null },
			metricsByName: new Map([
				[
					'items',
					{
						matchedCount: 1_000,
						sampledCount: 10,
						baseStrideCount: 10,
						referentialTopUpCount: 0,
						downsampled: true,
						effectiveCutoff: 5_000,
						cutoffBound: false,
						exceedsProductionCutoff: true,
					},
				],
			]),
			waveByQueryName: new Map([['items', 1]]),
			lazyQueryNames: new Set(),
			telemetry,
		});

		expect(plan.hasWarnings).toBe(true);
		expect(plan.calloutMarkdown).toContain('> [!warning]- Template Explain Plan');
		expect(plan.calloutMarkdown).toContain('1 query exceeds production cutoff');
		// Loop appears ONCE statically with scaled [~...] badge
		expect(plan.calloutMarkdown.match(/Loops each `row` in `query\.items`/g)).toHaveLength(1);
		expect(plan.calloutMarkdown).toMatch(/Loops each `row` in `query\.items`.*\[~\d/);
		// Nested scope box on 1st Simple partial call; flags `outer_secret` (exists in caller) and NOT `non_existent_global`, plus shadowing on `targetPath`
		expect(plan.calloutMarkdown).toContain(
			'>     > [!abstract] **Partial `{% render %}` → [[◊Rhizome/partials/card.md]]**',
		);
		expect(plan.calloutMarkdown).toContain(
			'References outer caller variable(s) `outer_secret`',
		);
		expect(plan.calloutMarkdown).not.toContain('unbound outer: `non_existent_global`');
		expect(plan.calloutMarkdown).toContain('***`targetPath`***');
		// 2nd Simple partial call collapses to 1-line summary
		expect(plan.calloutMarkdown).toContain('repeat call #2');
		// Complex partial expands on BOTH 1st and 2nd static occurrences and flags null `template.*` in dynamicCodeblock
		expect(
			plan.calloutMarkdown.match(
				/\[!abstract\] \*\*Partial `\{% render %\}` → \[\[◊Rhizome\/partials\/complex\.md\]\]\*\*/g,
			),
		).toHaveLength(2);
		expect(plan.calloutMarkdown).toContain('Null `template` warning');
	});

	it('inverts {% layout %} frames, supports anonymous {% block %} child content & non-orphan {% capture %}, flags orphaned named-only layout content, and force-expands failing 2nd+ {% render %} call sites', async () => {
		const files = new Map<string, string>([
			[
				'◊Rhizome/layouts/named-only.md',
				'# Frame\n{% block header %}Default Header{% endblock %}\n{% block body %}{% endblock %}',
			],
			['◊Rhizome/layouts/anon-slot.md', '# Wrapper\n{% block %}{% endblock %}'],
			[
				'◊Rhizome/partials/boom.md',
				'{% if fail %}{{ today..yesterday }}{% else %}ok{% endif %}',
			],
		]);

		// 1. Named-only layout with {% capture %} + orphaned text: {% capture %} is setup, orphaned text triggers warning
		const layoutSource = [
			"{% layout 'named-only' %}",
			'Orphaned text outside any named block!',
			'{% block body %}Overridden Body{% endblock %}',
		].join('\n');
		const parsedLayout = await parseRhizomeTemplatePass1Async(
			layoutSource,
			undefined,
			async (p) => files.get(p) ?? null,
		);
		const layoutRender = await renderParsedRhizomeTemplate(
			layoutSource,
			parsedLayout,
			{},
			undefined,
			undefined,
			{ allowFailedQueries: true },
		);
		const layoutPlan = buildTemplateExplainPlanCallout({
			source: layoutSource,
			parsed: parsedLayout,
			renderResult: layoutRender,
			metricsByName: new Map(),
			waveByQueryName: new Map(),
			lazyQueryNames: new Set(),
		});
		expect(layoutPlan.hasWarnings).toBe(true);
		expect(layoutPlan.calloutMarkdown).toContain('Orphaned child content');
		expect(layoutPlan.calloutMarkdown).toContain(
			'Layout slot `{% block %}` `header` *(renders layout default)*',
		);
		expect(layoutPlan.calloutMarkdown).toContain(
			'Layout slot `{% block %}` `body` *(overridden by child template)*',
		);

		// 2. Anonymous {% block %}{% endblock %} layout with {% capture %} + child body: NOT orphaned, child body inlined into anonymous slot!
		const anonSource = [
			"{% layout 'anon-slot' %}",
			'{% capture title_var %}Hello{% endcapture %}',
			'{{ title_var }} World',
		].join('\n');
		const parsedAnon = await parseRhizomeTemplatePass1Async(
			anonSource,
			undefined,
			async (p) => files.get(p) ?? null,
		);
		const anonRender = await renderParsedRhizomeTemplate(
			anonSource,
			parsedAnon,
			{},
			undefined,
			undefined,
			{ allowFailedQueries: true },
		);
		const anonPlan = buildTemplateExplainPlanCallout({
			source: anonSource,
			parsed: parsedAnon,
			renderResult: anonRender,
			metricsByName: new Map(),
			waveByQueryName: new Map(),
			lazyQueryNames: new Set(),
		});
		expect(anonPlan.hasWarnings).toBe(false);
		expect(anonPlan.calloutMarkdown).not.toContain('Orphaned child content');
		expect(anonPlan.calloutMarkdown).toContain(
			'Layout slot `{% block %}` *(anonymous)* *(overridden by child template)*',
		);
		expect(anonPlan.calloutMarkdown).toContain('Outputs `{{ title_var }}`');

		// 3. Force-expand 2nd Simple {% render %} call site when runtime error occurs inside it
		const simpleBoomFiles = new Map<string, string>([
			['◊Rhizome/partials/simple-boom.md', '{{ start_d..end_d }}'],
		]);
		const fail2Source = [
			"{% render 'simple-boom', start_d: '2026-10-01', end_d: '2026-10-05' %}",
			"{% render 'simple-boom', start_d: '2026-10-05', end_d: '2026-10-01' %}",
		].join('\n');
		const parsedFail2 = await parseRhizomeTemplatePass1Async(
			fail2Source,
			undefined,
			async (p) => simpleBoomFiles.get(p) ?? null,
		);
		const telemetry = new RenderTelemetryCollector();
		const errRes = await renderParsedRhizomeTemplate(
			fail2Source,
			parsedFail2,
			{},
			undefined,
			undefined,
			{ allowFailedQueries: true, telemetry },
		);
		expect(errRes.ok).toBe(false);
		const errPlan = buildTemplateExplainPlanCallout({
			source: fail2Source,
			parsed: parsedFail2,
			renderResult: errRes,
			metricsByName: new Map(),
			waveByQueryName: new Map(),
			lazyQueryNames: new Set(),
			telemetry,
		});
		expect(errPlan.calloutMarkdown).toContain(
			'> [!danger]+ Template Explain Plan — `TEMPLATE_RENDER_ERROR` (Failed)',
		);
		expect(errPlan.calloutMarkdown).toContain(
			'expanded: runtime error occurred inside this call site',
		);
	});
});
