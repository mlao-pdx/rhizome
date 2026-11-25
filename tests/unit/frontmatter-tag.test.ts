import { describe, expect, it } from 'vitest';
import { initEngineConfig } from '../../src/core/search';
import { renderRhizomeTemplate } from '../../src/core/templates';

describe('{% frontmatter %} tag', () => {
	const PINNED_MS = Date.UTC(2026, 10, 23, 14, 30, 0); // 2026-11-23T14:30Z

	it('supports comma lists, variadic args, array variables, deep as paths, omitted as, nil | default:, literals, and TemporalDrop serialization', async () => {
		const cfgRes = initEngineConfig({
			timeZone: 'UTC',
			propertyTypes: {
				priority: 'number',
				created: 'date',
			},
		});
		expect(cfgRes.ok).toBe(true);
		if (!cfgRes.ok) return;

		const source = [
			'{% assign title = "Kickoff" %}',
			'{% assign rules = "42 as priority, true as active" | split: ", " %}',
			'{% frontmatter "title, nil | default: \'in-progress\' as status, \'Ada\' as meta.owner", "today as created, today + 7d as due", rules %}',
			'FM={{ frontmatter | json }}',
			'PROPS={{ this.properties | json }}',
		].join('\n');

		const res = await renderRhizomeTemplate(source, {
			runQueries: async () => ({}),
			runtimeContext: {
				trigger: 'newNote',
				referenceTimeMs: PINNED_MS,
				timeZone: 'UTC',
				resolvedConfig: cfgRes.config,
			},
		});

		expect(res.ok).toBe(true);
		expect(res.hasFrontmatterMutations).toBe(true);
		expect(res.frontmatter).toEqual({
			title: 'Kickoff',
			status: 'in-progress',
			meta: { owner: 'Ada' },
			created: '2026-11-23',
			due: '2026-11-30',
			priority: 42,
			active: true,
		});
		expect(res.markdown).toContain('"created":"2026-11-23"');
		expect(res.markdown).toContain('"priority":42');
	});

	it('applies last-executed-wins precedence across {% layout %}, {% block %}, and {% render %} partials without pick array promotion', async () => {
		const files: Record<string, string> = {
			'◊Rhizome/layouts/base.md': [
				"{% frontmatter \"'layout-default' as status, 'base' as meta.layer, 'keep' as meta.shared\" %}",
				'{% block main %}{% endblock %}',
			].join('\n'),
			'◊Rhizome/partials/override.md':
				'{% frontmatter "override_status as status, partial_tags as tags" %}',
		};

		const source = [
			'{% layout "base" %}',
			'{% block main %}',
			'{% assign first_tags = "#alpha, #beta" | split: ", " %}',
			'{% frontmatter "first_tags as tags, \'child\' as meta.layer" %}',
			'{% assign second_tags = "gamma" | split: "," %}',
			'{% render "override", override_status: "final-status", partial_tags: second_tags %}',
			'status={{ frontmatter.status }}|layer={{ frontmatter.meta.layer }}|shared={{ frontmatter.meta.shared }}|tags={{ this.tags | join: "," }}',
			'{% endblock %}',
		].join('\n');

		const res = await renderRhizomeTemplate(source, {
			runQueries: async () => ({}),
			readTemplateFile: async (p) => files[p] ?? null,
			runtimeContext: {
				trigger: 'newNote',
				referenceTimeMs: PINNED_MS,
				timeZone: 'UTC',
			},
		});

		expect(res.ok).toBe(true);
		expect(res.frontmatter).toEqual({
			status: 'final-status',
			meta: {
				layer: 'child',
				shared: 'keep',
			},
			// Replaced (last-executed-wins), NOT merged with ['#alpha', '#beta']
			tags: ['gamma'],
		});
		expect(res.markdown).toContain('status=final-status|layer=child|shared=keep|tags=gamma');
	});

	it('promotes tags, aliases, and cssclasses onto virtual this in newNote mode while omitting them from this.properties', async () => {
		const source = [
			'{% assign t = "#Work/Q4, #urgent" | split: ", " %}',
			'{% assign a = "Alias One, Alias Two" | split: ", " %}',
			"{% frontmatter \"t as tags, a as aliases, 'wide-page' as cssclasses, 'open' as state\" %}",
			'tags={{ this.tags | join: "|" }};aliases={{ this.aliases | join: "|" }};css={{ this.cssclasses | join: "|" }};props={{ this.properties | json }}',
		].join('\n');

		const res = await renderRhizomeTemplate(source, {
			runQueries: async () => ({}),
			runtimeContext: {
				trigger: 'newNote',
				referenceTimeMs: PINNED_MS,
				timeZone: 'UTC',
			},
		});

		expect(res.ok).toBe(true);
		expect(res.markdown.trim()).toBe(
			'tags=Work/Q4|urgent;aliases=Alias One|Alias Two;css=wide-page;props={"state":"open"}',
		);
	});

	it('updates {{ frontmatter }} while acting as a non-mutating noop on this in atCursor and dynamicCodeblock modes', async () => {
		const hostMatch = {
			file: { path: 'Notes/Host.md', basename: 'Host' },
			tags: ['original-host-tag'],
			properties: { state: 'host-state' },
		};
		const source = [
			"{%- frontmatter \"'mutated' as state, 'new-tag' as tags\" -%}",
			'{{ ◊.trigger }}|fm={{ frontmatter.state }}|this={{ this.properties.state }}|tags={{ this.tags | join: "," }}',
		].join('\n');

		for (const trigger of ['atCursor', 'dynamicCodeblock'] as const) {
			const res = await renderRhizomeTemplate(source, {
				runQueries: async () => ({}),
				resolveHost: async () => hostMatch,
				runtimeContext: {
					sourcePath: 'Notes/Host.md',
					trigger,
					referenceTimeMs: PINNED_MS,
					timeZone: 'UTC',
				},
			});
			expect(res.ok).toBe(true);
			expect(res.markdown).toBe(
				`${trigger}|fm=mutated|this=host-state|tags=original-host-tag`,
			);
			expect(res.frontmatter).toBeUndefined();
		}
	});

	it('emits INVALID_FRONTMATTER_TAG_ARGS on empty, unquoted, or malformed selectors', async () => {
		const badTemplates = [
			'{% frontmatter %}',
			'{% frontmatter "" %}',
			'{% frontmatter title as name %}',
			'{% frontmatter "\'literal_without_as\'" %}',
			'{% frontmatter "title," %}',
		];

		for (const tpl of badTemplates) {
			const res = await renderRhizomeTemplate(tpl, {
				runQueries: async () => ({}),
				runtimeContext: { trigger: 'newNote', timeZone: 'UTC' },
			});
			expect(res.ok, `Expected '${tpl}' to fail`).toBe(false);
			expect(res.diagnostics[0]?.code).toBe('INVALID_FRONTMATTER_TAG_ARGS');
		}
	});
});
