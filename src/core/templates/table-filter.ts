import { FORBIDDEN_KEYS } from '@core/search';
import { isPlainRecord, type LiquidFilterThis } from './selector-evaluator';
import { isVacuousSortOrGroupValue, readContextLanguage } from './sort-group-filters';
import { TemporalDrop, unwrapLiquidValue } from './temporal-drop';

/**
 * Column alignment mode for the Liquid `table` filter.
 */
export type TableColumnAlignment = 'left' | 'center' | 'right';

const ALIGNMENT_DIVIDERS: Readonly<Record<TableColumnAlignment, string>> = Object.freeze({
	left: ':---',
	center: ':---:',
	right: '---:',
});

const listFormatCache = new Map<string, Intl.ListFormat>();

/**
 * Returns a cached `Intl.ListFormat` configured with `{ style: 'long', type: 'conjunction' }`
 * for `language`, falling back to `'en'` if `language` is invalid or unsupported.
 */
export function getConjunctionListFormatter(language: string): Intl.ListFormat {
	const cleanLang = language.trim() || 'en';
	let formatter = listFormatCache.get(cleanLang);
	if (formatter) return formatter;

	try {
		formatter = new Intl.ListFormat(cleanLang, {
			style: 'long',
			type: 'conjunction',
		});
	} catch {
		formatter = new Intl.ListFormat('en', {
			style: 'long',
			type: 'conjunction',
		});
	}
	listFormatCache.set(cleanLang, formatter);
	return formatter;
}

/**
 * Parses exception-based column alignment arguments for the `table` filter.
 *
 * Each argument (or comma-separated segment within a string argument) may begin with:
 * - `'<'` for left alignment (`:---`)
 * - `'^'` for center alignment (`:---:`)
 * - `'>'` for right alignment (`---:`)
 * - Any other character defaults to `'left'` (`:---`) with the full trimmed token as the column name.
 *
 * Later specifications for the same exact (case-sensitive) column name override earlier ones.
 */
export function parseTableAlignments(
	args: readonly unknown[],
): ReadonlyMap<string, TableColumnAlignment> {
	const alignments = new Map<string, TableColumnAlignment>();

	const visitEntry = (rawEntry: string): void => {
		const trimmed = rawEntry.trim();
		if (trimmed.length === 0) return;

		const firstChar = trimmed[0];
		let alignment: TableColumnAlignment = 'left';
		let colName = trimmed;

		if (firstChar === '<') {
			alignment = 'left';
			colName = trimmed.slice(1).trim();
		} else if (firstChar === '^') {
			alignment = 'center';
			colName = trimmed.slice(1).trim();
		} else if (firstChar === '>') {
			alignment = 'right';
			colName = trimmed.slice(1).trim();
		}

		if (colName.length === 0 || FORBIDDEN_KEYS.has(colName)) {
			return;
		}
		alignments.set(colName, alignment);
	};

	const visitArg = (arg: unknown): void => {
		const u = unwrapLiquidValue(arg);
		if (typeof u === 'string') {
			for (const piece of u.split(',')) {
				visitEntry(piece);
			}
			return;
		}
		if (Array.isArray(u)) {
			for (const item of u) {
				visitArg(item);
			}
		}
	};

	for (const arg of args) {
		visitArg(arg);
	}

	return alignments;
}

/**
 * Formats a scalar value (`string`, finite `number`, `boolean`, or `TemporalDrop`) for table/list
 * rendering without coercing strings, or returns `null` when the value is vacuous or non-scalar.
 */
export function formatTableScalar(val: unknown): string | null {
	const u = unwrapLiquidValue(val);
	if (typeof u === 'string') {
		return u.length > 0 ? u : null;
	}
	if (typeof u === 'number') {
		if (!Number.isFinite(u)) return null;
		return String(u === 0 ? 0 : u);
	}
	if (typeof u === 'boolean') {
		return u ? 'true' : 'false';
	}
	if (u instanceof TemporalDrop) {
		const rendered = u.toString();
		return rendered.length > 0 ? rendered : null;
	}
	return null;
}

/**
 * Formats a plain object as a single-line ellipsized summary (`{...}`, `{k: v, ...}`,
 * or `{first: v1, ..., last: vn}`) based on its non-vacuous scalar properties.
 */
export function formatEllipsizedObject(obj: Record<string, unknown>): string {
	const scalarPairs: string[] = [];
	for (const key of Object.keys(obj)) {
		if (FORBIDDEN_KEYS.has(key)) continue;
		const formattedScalar = formatTableScalar(obj[key]);
		if (formattedScalar !== null) {
			scalarPairs.push(`${key}: ${formattedScalar}`);
		}
	}

	if (scalarPairs.length === 0) {
		return '{...}';
	}
	if (scalarPairs.length === 1) {
		return `{${scalarPairs[0]!}, ...}`;
	}
	const first = scalarPairs[0]!;
	const last = scalarPairs[scalarPairs.length - 1]!;
	return `{${first}, ..., ${last}}`;
}

/**
 * Formats a single raw cell value for a Markdown table according to its runtime shape:
 * - Vacuous values (`null`, `undefined`, `""`, `[]`, `{}`) render as `""`.
 * - Scalars (`string`, finite `number`, `boolean`, `TemporalDrop`) render directly without coercion.
 * - Non-empty plain objects render as single-line ellipsized summaries (`{...}`, `{k: v, ...}`, or `{first: v1, ..., last: vn}`).
 * - Non-empty arrays filter out vacuous items, ellipsize nested objects/arrays, and join via locale-aware `Intl.ListFormat`.
 */
export function formatTableCellValue(val: unknown, language = 'en'): string {
	if (isVacuousSortOrGroupValue(val)) {
		return '';
	}
	const u = unwrapLiquidValue(val);

	const scalar = formatTableScalar(u);
	if (scalar !== null) {
		return scalar;
	}

	if (isPlainRecord(u)) {
		return formatEllipsizedObject(u);
	}

	if (Array.isArray(u)) {
		const renderedItems: string[] = [];
		for (const rawEl of u as readonly unknown[]) {
			if (isVacuousSortOrGroupValue(rawEl)) continue;
			const el = unwrapLiquidValue(rawEl);
			const elScalar = formatTableScalar(el);
			if (elScalar !== null) {
				renderedItems.push(elScalar);
			} else if (isPlainRecord(el)) {
				renderedItems.push(formatEllipsizedObject(el));
			} else if (Array.isArray(el)) {
				renderedItems.push('{...}');
			}
		}
		if (renderedItems.length === 0) {
			return '';
		}
		return getConjunctionListFormatter(language).format(renderedItems);
	}

	return '';
}

/**
 * Escapes a formatted header or cell string for safe inclusion inside a single GFM / Obsidian
 * table cell by normalizing line breaks (`\r\n`, `\r`, `\n`) to `<br>` and escaping unescaped
 * pipe characters (`|`) as `\|`.
 */
export function escapeTableCell(raw: string): string {
	if (raw.length === 0) return '';
	return raw
		.replace(/\r\n|\r|\n/g, '<br>')
		.replace(/(\\*)\|/g, (_, slashes: string) =>
			slashes.length % 2 === 0 ? `${slashes}\\|` : `${slashes}|`,
		);
}

/**
 * Liquid `table` filter: renders a plain object or an array of plain objects as a GitHub Flavored
 * Markdown (GFM) / Obsidian table using root-level object keys in first-seen order as column headers
 * and optional `<Col`, `^Col`, `>Col` alignment specifications.
 */
export function tableFilter(
	this: LiquidFilterThis | void,
	input: unknown,
	...args: unknown[]
): string {
	const unwrapped = unwrapLiquidValue(input);
	let rows: Record<string, unknown>[];

	if (Array.isArray(unwrapped)) {
		rows = [];
		for (const item of unwrapped) {
			const uItem = unwrapLiquidValue(item);
			if (isPlainRecord(uItem)) {
				rows.push(uItem);
			}
		}
	} else if (isPlainRecord(unwrapped)) {
		rows = [unwrapped];
	} else {
		return '';
	}

	if (rows.length === 0) {
		return '';
	}

	const columns: string[] = [];
	const seenColumns = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (FORBIDDEN_KEYS.has(key) || seenColumns.has(key)) continue;
			seenColumns.add(key);
			columns.push(key);
		}
	}

	if (columns.length === 0) {
		return '';
	}

	const alignments = parseTableAlignments(args);
	const ctx = this && typeof this === 'object' && 'context' in this ? this.context : undefined;
	const language = readContextLanguage(ctx);

	const headerCells = columns.map((col) => escapeTableCell(col));
	const dividerCells = columns.map((col) => {
		const align = alignments.get(col) ?? 'left';
		return ALIGNMENT_DIVIDERS[align];
	});

	const lines: string[] = [`| ${headerCells.join(' | ')} |`, `| ${dividerCells.join(' | ')} |`];

	for (const row of rows) {
		const rowCells = columns.map((col) => {
			if (!Object.prototype.hasOwnProperty.call(row, col)) {
				return '';
			}
			const formatted = formatTableCellValue(row[col], language);
			return escapeTableCell(formatted);
		});
		lines.push(`| ${rowCells.join(' | ')} |`);
	}

	return lines.join('\n');
}
