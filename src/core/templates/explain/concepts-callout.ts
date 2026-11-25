import {
	EXPLAIN_CONCEPT_ORDER,
	type ExplainConceptKey,
	formatInlineCode,
	renderIntervalComparisonDiagram,
} from '@core/search';
import { MAX_REFERENTIAL_TOP_UP, MAX_SAMPLE_SIZE } from '../query-sampler';
import { prefixCalloutBodyLines } from './query-explain-callout';

function renderConceptCardLines(
	key: ExplainConceptKey,
	referenceTimeMs: number,
	timeZone: string,
): string[] {
	switch (key) {
		case 'temporal-intervals':
			return [
				'- **Half-Open Temporal Intervals & Timezone Resolution (`[start, end)`)**: Every date (`YYYY-MM-DD`), month/year/week grain, relative anchor (`@today`, `@thisweek`, `today`, `now`), and range expands into a half-open interval `[start, end)` anchored to local midnight in the active IANA timezone (' +
					formatInlineCode(timeZone) +
					') before converting to UTC epoch milliseconds (`:` and `=` check containment `D ⊆ Q`).',
				...renderIntervalComparisonDiagram(referenceTimeMs, timeZone)
					.split('\n')
					.map((l) => `  ${l}`),
			];
		case 'graph-traversal':
			return [
				'- **Graph Traversal & Hop Bounds (`-->`, `<--`, `{m,n}`)**: Graph filters follow resolved note links (`links`, `embeds`, `backlinks`, or frontmatter/inline property links) along cycle-free simple paths within the specified hop bounds (`0` hops includes reflexive self-matches).',
			];
		case 'cross-query-waves':
			return [
				'- **Cross-Query `@query.<name>` Dependency Waves**: Static queries referencing `@query.<name>` execute in topological Pass-1.5 waves. In `rhizome-sample`, downstream `@query.<name>` filters receive the full unsampled upstream match set so graph reachability stays exact even when `query.<name>` is sampled for Liquid rendering.',
			];
		case 'property-coercion':
			return [
				'- **Property Type Resolution & Coercion (`types.json`)**: Property keys resolve against the vault `types.json` registry (`text`, `multitext`, `number`, `checkbox`, `date`, `datetime`), built-in virtual `file.*` types, or default `text`. Note values that cannot coerce to the configured type are skipped during matching and surfaced above as coercion warnings.',
			];
		case 'template-graph-joins':
			return [
				`- **Template Graph Joins (\`link_paths\`, \`lookup\`, \`tree\`)**: \`link_paths\` extracts deduplicated resolved target paths from a note or array; \`lookup\` joins paths against a query collection while preserving order; \`tree\` assembles cycle-safe parent/child hierarchies. \`rhizome-sample\` augments each query sample with up to \`${MAX_REFERENTIAL_TOP_UP}\` referentially linked records (\`<= ${MAX_SAMPLE_SIZE}\` total) so cross-query joins stay connected.`,
			];
		case 'relative-headings':
			return [
				'- **Relative Headings (`{% heading %}` & `| heading`)**: The active heading level initializes from the enclosing Markdown heading above the codeblock (`H0` at document root), adjusts across `{% heading 1..6 | promote | demote %}` blocks, clamps Markdown headings to `H1..H6`, and falls back to indented list items past `H6`.',
			];
		case 'partials-and-layouts':
			return [
				'- **Partials (`{% render %}`) vs. Layouts (`{% layout %}`)**: `{% render %}` executes partials in an **isolated variable scope** (outer `assign`/`capture` variables are invisible unless passed explicitly, while Rhizome globals `query`, `this`, `now`, `today`, `frontmatter`, `targetPath`, and heading state remain shared). `{% layout %}` shares the outer variable scope and renders named `{% block %}` overrides into the layout frame.',
			];
		case 'template-modes-virtual-this':
			return [
				'- **Template Execution Modes & Virtual `this`**: Notes inside `templatesFolder` preview in simulated `"newNote"` mode (`◊.trigger == "newNote"`), staging `{% targetPath %}` and `{% frontmatter %}` in memory without writing files and re-normalizing virtual `this` before Pass-2 lazy `@this` queries execute. Notes inside `templatesFolder`, `partialsFolder`, and `layoutsFolder` are excluded from vault search results.',
			];
	}
}

/**
 * Renders the single deduplicated, collapsed `> [!abstract]- Concepts Reference (<N> topics)`
 * callout at the bottom of the `rhizome-sample` Explain Stack, or `""` when `0` concepts fired.
 */
export function buildConceptsReferenceCallout(
	triggeredConcepts: ReadonlySet<ExplainConceptKey>,
	referenceTimeMs: number,
	timeZone: string,
): string {
	const ordered = EXPLAIN_CONCEPT_ORDER.filter((key) => triggeredConcepts.has(key));
	if (ordered.length === 0) {
		return '';
	}

	const noun = ordered.length === 1 ? 'topic' : 'topics';
	const header = `> [!abstract]- Concepts Reference (${ordered.length} ${noun})`;
	const bodyLines: string[] = [];

	ordered.forEach((key, idx) => {
		if (idx > 0) {
			bodyLines.push('');
		}
		bodyLines.push(...renderConceptCardLines(key, referenceTimeMs, timeZone));
	});

	return [header, ...prefixCalloutBodyLines(bodyLines)].join('\n');
}
