import { Temporal } from '@js-temporal/polyfill';
import type { ResolvedPropertyTypeInfo } from './explain-helpers';
import { formatInlineCode } from './explain-helpers';
import type { SearchDiagnostic } from './types';

/**
 * Deterministic Markdown footnote registry that assigns sequential 1-based numeric footnote IDs
 * (`[^1]`, `[^2]`, ...) in first-referenced order while deduplicating by semantic key, and renders
 * their definitions separated by blank lines (`\n\n`).
 */
export class FootnoteRegistry {
	private readonly numberByKey = new Map<string, number>();
	private readonly definitions = new Map<number, string>();

	/**
	 * Marks footnote `key` as referenced (assigning the next sequential number and computing its
	 * definition lazily on first reference) and returns the numbered inline footnote marker `[^N]`.
	 */
	ref(key: string, definition: string | (() => string)): string {
		let num = this.numberByKey.get(key);
		if (num === undefined) {
			num = this.numberByKey.size + 1;
			this.numberByKey.set(key, num);
			const text = typeof definition === 'function' ? definition() : definition;
			this.definitions.set(num, text);
		}
		return `[^${num}]`;
	}

	/**
	 * Returns true if at least one footnote was referenced.
	 */
	hasEntries(): boolean {
		return this.definitions.size > 0;
	}

	/**
	 * Renders all referenced footnote definitions in sequential numeric order,
	 * separated by an empty line (`\n\n`).
	 */
	renderDefinitions(): string {
		const blocks: string[] = [];
		for (const [num, text] of this.definitions.entries()) {
			blocks.push(`[^${num}]: ${text}`);
		}
		return blocks.join('\n\n');
	}
}

export function renderIntervalComparisonDiagram(referenceTimeMs: number, timeZone: string): string {
	let today: Temporal.PlainDate;
	try {
		today = Temporal.Instant.fromEpochMilliseconds(referenceTimeMs)
			.toZonedDateTimeISO(timeZone)
			.toPlainDate();
	} catch {
		today = Temporal.Instant.fromEpochMilliseconds(referenceTimeMs)
			.toZonedDateTimeISO('UTC')
			.toPlainDate();
	}
	const day = (offset: number): string => {
		try {
			return today.add({ days: offset }).toString();
		} catch {
			return today.toString();
		}
	};

	return [
		'```mermaid',
		'gantt',
		'    title [Half-Open) Interval Comparison Matches',
		'    dateFormat YYYY-MM-DD',
		'    axisFormat %Y-%m-%d',
		'    tickInterval 1day',
		'    todayMarker off',
		'',
		'    section Given',
		`    [${day(-1)} <= Criteria < ${day(2)})            :crit,   ${day(-1)}, ${day(2)}`,
		'',
		'    section : OR =',
		`    Value matches exactly           :active, ${day(-1)}, ${day(2)}`,
		`    Value starts and ends within    :active, ${day(0)}, ${day(1)}`,
		'',
		'    section !=',
		`    Value starts before             :active, ${day(-2)}, ${day(1)}`,
		`    Value ends after                :active, ${day(0)}, ${day(3)}`,
		'',
		'    section <',
		`    Value ends at start or before   :active, ${day(-2)}, ${day(-1)}`,
		'',
		'    section <=',
		`    Value ends at end or before     :active, ${day(-2)}, ${day(2)}`,
		'',
		'    section >=',
		`    Value starts at start or after  :active, ${day(-1)}, ${day(3)}`,
		'',
		'    section >',
		`    Value starts at end or after    :active, ${day(2)}, ${day(3)}`,
		'',
		'    section some<br>built-ins',
		`    @yesterday                      :active, ${day(-1)}, ${day(0)}`,
		`    @today                          :active, ${day(0)}, ${day(1)}`,
		`    @tomorrow                       :active, ${day(1)}, ${day(2)}`,
		'```',
	].join('\n');
}

export function refIntervalFootnote(registry: FootnoteRegistry, todayWindowLocal?: string): string {
	return registry.ref('interval', () => {
		const todayExample = todayWindowLocal
			? ` For example, \`@today\` spans \`${todayWindowLocal}\`.`
			: '';
		return `**Half-Open Temporal Intervals (\`[start, end)\`)**: Every date, datetime, or relative token expands into a half-open interval where the start is inclusive and the end is exclusive.${todayExample}`;
	});
}

export function refTimezoneFootnote(
	registry: FootnoteRegistry,
	effectiveTimeZone: string,
	configuredTimeZone: string,
	tzValid: boolean,
): string {
	return registry.ref('tz', () => {
		const fallbackNote = tzValid
			? `Active timezone: ${formatInlineCode(effectiveTimeZone)}.`
			: `Configured timezone ${formatInlineCode(configuredTimeZone)} was invalid, so analysis fell back to \`UTC\`.`;
		return `**Timezone Resolution**: Date-only values (\`YYYY-MM-DD\`), year/month/week grains, and relative anchors (\`@today\`, \`@thisweek\`) are anchored to local wall-clock midnight in the active IANA timezone before converting to UTC epoch milliseconds. ${fallbackNote}`;
	});
}

export function refRegexFootnote(registry: FootnoteRegistry): string {
	return registry.ref(
		'regex',
		'**Regular Expression Evaluation**: Patterns use JavaScript (`ECMAScript`) regular expression syntax with the `u` (Unicode) flag enabled. On `number`, `date`, and `datetime` properties, regular expressions test the raw authored string (`entry.raw`); on text, tag, and scope targets, they test each normalized string value.',
	);
}

function slugifyScopeName(scope: string): string {
	const slug = scope
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || 'custom';
}

export function refScopeFootnote(registry: FootnoteRegistry, canonicalScope: string): string {
	switch (canonicalScope) {
		case 'tag':
			return registry.ref(
				'scope-tag',
				'**Tag Scope (`#tag` / `tag:`)**: Searches tags across frontmatter, inline properties, and the note body. The default match is hierarchical and case-insensitive; comparison operators use exact equality or alphabetical ordering.',
			);
		case 'file':
			return registry.ref(
				'scope-file',
				'**File Scope (`file:` / `filename:`)**: Searches the note filename both with extension (`file.name`) and without extension (`file.basename`), with case-insensitive substring matching by default.',
			);
		case 'path':
			return registry.ref(
				'scope-path',
				'**Path Scope (`path:` / `folder:`)**: Searches the note vault-relative path (`file.path`), with case-insensitive substring matching by default.',
			);
		case 'ext':
			return registry.ref(
				'scope-ext',
				'**Extension Scope (`ext:` / `extension:`)**: Matches the note file extension (`file.extension`), with case-insensitive exact equality by default after stripping any leading `.` from the query value.',
			);
		case 'aliases':
			return registry.ref(
				'scope-aliases',
				'**Aliases Scope (`aliases:` / `alias:`)**: Searches all note `aliases` declared in frontmatter and inline properties using case-insensitive substring matching for `:` (or exact/alphabetical comparison for `=`, `!=`, `<`, `<=`, `>`, `>=`).',
			);
		case 'cssclasses':
			return registry.ref(
				'scope-cssclasses',
				'**CSS Classes Scope (`cssclasses:` / `cssclass:`)**: Matches frontmatter `cssclasses` using case-insensitive exact equality (or alphabetical comparison for `<`, `<=`, `>`, `>=`).',
			);
		case 'headings':
			return registry.ref(
				'scope-headings',
				'**Headings Scope (`headings:` / `heading:` / `header:` / `headers:`)**: Searches markdown section heading text (`#` through `######`) in the note, with case-insensitive substring matching by default.',
			);
		case 'links':
			return registry.ref(
				'scope-links',
				'**Outgoing Links Scope (`links:` / `link:` / `outlink:`)**: Searches outgoing links from frontmatter and note body (`link`, `rawTarget`, resolved vault path `resolvedPath`, and `displayText`), with case-insensitive substring matching by default.',
			);
		case 'embeds':
			return registry.ref(
				'scope-embeds',
				'**Embeds Scope (`embeds:` / `embed:`)**: Searches embedded notes and attachments (`link`, `rawTarget`, and resolved vault path `resolvedPath`), with case-insensitive substring matching by default.',
			);
		case 'blocks':
			return registry.ref(
				'scope-blocks',
				'**Blocks Scope (`blocks:` / `block:`)**: Matches note block identifiers (`^block-id`), with case-insensitive exact equality by default after stripping any leading `^` from the query value.',
			);
		case 'backlinks':
			return registry.ref(
				'scope-backlinks',
				'**Backlinks Scope (`backlinks:` / `backlink:`)**: Searches the source notes that resolve links to this note, matching each source vault path and basename with case-insensitive substring matching by default. Link counts are returned in the payload but are not matched.',
			);
		default: {
			const id = `scope-custom-${slugifyScopeName(canonicalScope)}`;
			const code = formatInlineCode(`${canonicalScope}:`);
			return registry.ref(
				id,
				`**Custom Scope (${code})**: Evaluates the registered custom scope extractor and matcher for ${code} against each note.`,
			);
		}
	}
}

export function refPropertyFootnote(
	registry: FootnoteRegistry,
	lowerKey: string,
	typeInfo: ResolvedPropertyTypeInfo,
): string {
	if (typeInfo.origin === 'virtual') {
		switch (lowerKey) {
			case 'file.modified':
				return registry.ref(
					'prop-file-modified',
					'**Predetermined Property (`file.modified`)**: Built-in virtual `datetime` property representing the file last-modified timestamp (`stat.mtime`), evaluated as a 1 ms UTC instant `[mtime, mtime + 1)`.',
				);
			case 'file.created':
				return registry.ref(
					'prop-file-created',
					'**Predetermined Property (`file.created`)**: Built-in virtual `datetime` property representing the file creation timestamp (`stat.ctime`), evaluated as a 1 ms UTC instant `[ctime, ctime + 1)`.',
				);
			case 'file.size':
				return registry.ref(
					'prop-file-size',
					'**Predetermined Property (`file.size`)**: Built-in virtual `number` property representing the file size in bytes (`stat.size`).',
				);
			case 'file.extension':
				return registry.ref(
					'prop-file-extension',
					'**Predetermined Property (`file.extension`)**: Built-in virtual `text` property representing the file extension without a leading dot (e.g., `"md"`).',
				);
			case 'file.name':
				return registry.ref(
					'prop-file-name',
					'**Predetermined Property (`file.name`)**: Built-in virtual `text` property representing the filename including extension (e.g., `"Note.md"`).',
				);
			case 'file.basename':
				return registry.ref(
					'prop-file-basename',
					'**Predetermined Property (`file.basename`)**: Built-in virtual `text` property representing the filename without extension (e.g., `"Note"`).',
				);
			case 'file.path':
				return registry.ref(
					'prop-file-path',
					'**Predetermined Property (`file.path`)**: Built-in virtual `text` property representing the full vault-relative path (e.g., `"folder/Note.md"`).',
				);
			case 'file.parent':
				return registry.ref(
					'prop-file-parent',
					'**Predetermined Property (`file.parent`)**: Built-in virtual `text` property representing the vault-relative parent folder path (or `""` at vault root).',
				);
		}
	}

	if (typeInfo.origin === 'default') {
		return registry.ref(
			'prop-untyped',
			'**Untyped Property (Default `text`)**: This property key has no explicit entry in the `propertyTypes` registry, so it defaults to `text` semantics (`:` substring match, `=`/`!=` exact match, `<`/`<=`/`>`/`>=` alphabetical comparison, all case-insensitive).',
		);
	}

	switch (typeInfo.type) {
		case 'text':
			return registry.ref(
				'prop-text',
				'**Configured `text` Property**: Configured in `propertyTypes` as `text`. Evaluates case-insensitively: `:` checks substring containment, `=` and `!=` check exact string equality, and `<`, `<=`, `>`, `>=` compare strings alphabetically.',
			);
		case 'multitext':
			return registry.ref(
				'prop-multitext',
				'**Configured `multitext` Property**: Configured in `propertyTypes` as `multitext` (list of strings). Existentially quantified across list entries: a note matches if at least one valid element satisfies the operator (`:` substring, `=`/`!=` exact equality, `<`/`<=`/`>`/`>=` alphabetical, all case-insensitive).',
			);
		case 'number':
			return registry.ref(
				'prop-number',
				'**Configured `number` Property**: Configured in `propertyTypes` as `number`. Coerces stored values to finite IEEE-754 numbers and compares them numerically (`:` and `=` test numeric equality; `!=`, `<`, `<=`, `>`, `>=` test numeric ordering).',
			);
		case 'checkbox':
			return registry.ref(
				'prop-checkbox',
				'**Configured `checkbox` Property**: Configured in `propertyTypes` as `checkbox` (boolean `true` or `false`). Supports `:` and `=` for boolean equality and `!=` for boolean inequality; ordering operators and regexes are not supported.',
			);
		case 'date':
			return registry.ref(
				'prop-date',
				'**Configured `date` Property**: Configured in `propertyTypes` as `date`. Stored dates and query literals expand into half-open UTC epoch millisecond intervals `[start, end)` in the active timezone and are compared using interval algebra.',
			);
		case 'datetime':
			return registry.ref(
				'prop-datetime',
				'**Configured `datetime` Property**: Configured in `propertyTypes` as `datetime`. Stored timestamps and query literals expand into half-open UTC epoch millisecond intervals `[start, end)` in the active timezone and are compared using interval algebra.',
			);
	}
}

export function refDiagnosticFootnote(
	registry: FootnoteRegistry,
	diagIndexOneBased: number,
	diag: SearchDiagnostic,
): string {
	const id = `diag-${diagIndexOneBased}`;
	return registry.ref(id, () => {
		const sevLabel =
			diag.severity === 'error' ? 'Error' : diag.severity === 'warning' ? 'Warning' : 'Hint';
		const fixSuffix = diag.hint ? ` Fix: ${diag.hint}` : '';
		return `**${sevLabel} ${diagIndexOneBased} (\`${diag.code}\`)**: ${diag.issue}${fixSuffix}`;
	});
}
