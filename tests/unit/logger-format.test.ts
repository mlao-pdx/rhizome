import { describe, expect, it } from 'vitest';
import {
	escapeMarkdownTableCell,
	formatDescriptions,
	formatLogLine,
	LEVEL_ORDER,
	LOG_FILE_HEADER,
	markSensitive,
	redactQuerySyntax,
	redactSensitiveText,
	shouldLog,
} from '../../src/adapters/logger-format';

describe('LEVEL_ORDER', () => {
	it('defines the three severity levels in ascending order', () => {
		expect(LEVEL_ORDER).toEqual(['debug', 'warn', 'error']);
	});
});

describe('shouldLog', () => {
	it('is true when the level is at or above the threshold', () => {
		expect(shouldLog('warn', 'warn')).toBe(true);
		expect(shouldLog('warn', 'error')).toBe(true);
		expect(shouldLog('debug', 'error')).toBe(true);
		expect(shouldLog('debug', 'warn')).toBe(true);
		expect(shouldLog('debug', 'debug')).toBe(true);
	});

	it('is false when the level is below the threshold or unrecognized', () => {
		expect(shouldLog('warn', 'debug')).toBe(false);
		expect(shouldLog('error', 'warn')).toBe(false);
		expect(shouldLog('error', 'debug')).toBe(false);
		expect(shouldLog('info' as never, 'debug')).toBe(false);
	});
});

describe('redactSensitiveText', () => {
	it('replaces uppercase and lowercase Unicode letters with X/x and digits with 9 while preserving punctuation, whitespace, and ◊', () => {
		expect(redactSensitiveText('Projects/2026/Secret_Note-1.md')).toBe(
			'Xxxxxxxx/9999/Xxxxxx_Xxxx-9.xx',
		);
		expect(redactSensitiveText('◊Rhizome\tÉclair & 漢字 42\n')).toBe(
			'◊Xxxxxxx\tXxxxxx & xx 99\n',
		);
	});

	it('replaces non-ASCII symbols and emoji with interpunct (·) except ◊', () => {
		expect(redactSensitiveText('◊Note 🚀 ©')).toBe('◊Xxxx · ·');
	});
});

describe('redactQuerySyntax', () => {
	it('preserves Rhizome syntax, built-in scopes, virtual properties, and relative anchors while redacting user identifiers and literals', () => {
		const raw =
			'tag:(#project OR #area !archived) [status: != "done"] [file.modified: !@thisweek..@today] /junk\\s+$/i';
		expect(redactQuerySyntax(raw)).toBe(
			'tag:(#xxxxxxx OR #xxxx !xxxxxxxx) [xxxxxx: != "xxxx"] [file.modified: !@thisweek..@today] /xxxx\\s+$/i',
		);
	});

	it('falls back to character-class redaction (Option A) when a query fails parsing with a SYNTAX_ERROR', () => {
		const raw = '[~created: @thismonth] AND [~modified=@thismonth]';
		expect(redactQuerySyntax(raw)).toBe('[~xxxxxxx: @xxxxxxxxx] XXX [~xxxxxxxx=@xxxxxxxxx]');

		const customMalformed = '[SecretProp=2026-10-29] AND [[My Secret Note]]';
		expect(redactQuerySyntax(customMalformed)).toBe(
			'[XxxxxxXxxx=9999-99-99] XXX [[Xx Xxxxxx Xxxx]]',
		);
	});

	it('masks numeric day offsets on relative date anchors while preserving the anchor keyword', () => {
		expect(redactQuerySyntax('[file.created: @today-7d..@today+14d]')).toBe(
			'[file.created: @today-9d..@today+99d]',
		);
	});

	it('redacts sensitive letters and digits inside skipped Liquid inline and block comments while preserving query operators and built-in scopes', () => {
		const raw =
			'{% # SecretNote 42 %} tag:work AND {%- comment -%} Private 99 {%- endcomment -%} [file.modified: >= @today]';
		expect(redactQuerySyntax(raw)).toBe(
			'{% # XxxxxxXxxx 99 %} tag:xxxx AND {%- xxxxxxx -%} Xxxxxxx 99 {%- xxxxxxxxxx -%} [file.modified: >= @today]',
		);

		const commentOnly = '{% # OnlySecret 123 %}';
		expect(redactQuerySyntax(commentOnly)).toBe('{% # XxxxXxxxxx 999 %}');
	});
});

describe('escapeMarkdownTableCell', () => {
	it('escapes backslashes, pipes, newlines, carriage returns, and tabs with backslashes', () => {
		expect(escapeMarkdownTableCell('a|b\\c\nd\re\tf')).toBe('a\\|b\\\\c\\nd\\re\\tf');
	});
});

describe('formatDescriptions', () => {
	it('returns identical Description and ‼️Description‼️ when no ‼️...‼️ markers are present', () => {
		const res = formatDescriptions('Rhizome loaded', { version: '0.1.0' });
		expect(res.description).toBe('Rhizome loaded {"version":"0.1.0"}');
		expect(res.unredactedDescription).toBe('Rhizome loaded {"version":"0.1.0"}');
	});

	it('strips ‼️ markers and redacts sensitive content in Description while keeping ‼️...‼️ in ‼️Description‼️', () => {
		const res = formatDescriptions('Compiled query ‼️query1‼️', {
			query: '‼️tag:(#project OR #area) [status: != "done"]‼️',
			executable: true,
			hintCodes: [],
		});
		expect(res.description).toBe(
			'Compiled query xxxxx9 {"query":"tag:(#xxxxxxx OR #xxxx) [xxxxxx: != \\"xxxx\\"]","executable":true,"hintCodes":[]}',
		);
		expect(res.unredactedDescription).toBe(
			'Compiled query ‼️query1‼️ {"query":"‼️tag:(#project OR #area) [status: != \\"done\\"]‼️","executable":true,"hintCodes":[]}',
		);
	});

	it('prevents embedded ‼️ characters inside sensitive values from prematurely closing the redaction span', () => {
		const res = formatDescriptions(
			`${markSensitive('NoteA.md')} linked to ${markSensitive('secret1 ‼️ secret2')}`,
			{
				query: '‼️alpha ‼️ beta‼️',
			},
		);
		expect(res.description).toBe(
			'XxxxX.xx linked to xxxxxx9 !! xxxxxx9 {"query":"xxxxx · xxxx"}',
		);
		expect(res.unredactedDescription).toBe(
			'‼️NoteA.md‼️ linked to ‼️secret1 !! secret2‼️ {"query":"‼️alpha ‼️ beta‼️"}',
		);
	});
});

describe('formatLogLine & LOG_FILE_HEADER', () => {
	it('declares ◊InternalRhizome code 001 frontmatter and the 7-column Markdown table header', () => {
		expect(LOG_FILE_HEADER).toContain('◊InternalRhizome:\n  "001": Do not index or query.');
		expect(LOG_FILE_HEADER).toContain(
			'| Timestamp | Level | Source | Duration | Count | Description | ‼️Description‼️ |',
		);
	});

	it('formats a 7-column Markdown table row extracting source, durationMs, and count from meta', () => {
		const line = formatLogLine(
			'2026-10-29T19:00:06.318Z',
			'debug',
			'Completed vault query run',
			{
				source: 'query.run',
				durationMs: 15,
				count: 129,
				executableCount: 2,
				matchCounts: { '‼️query2‼️': 1, '‼️query3‼️': 2 },
			},
		);
		expect(line).toBe(
			'| 2026-10-29T19:00:06.318Z | DEBUG | query.run | 15 ms | 129 | Completed vault query run {"executableCount":2,"matchCounts":{"xxxxx9":1,"xxxxx9#2":2}} | Completed vault query run {"executableCount":2,"matchCounts":{"‼️query2‼️":1,"‼️query3‼️":2}} |\n',
		);
	});

	it('escapes pipes and control whitespace inside table cells', () => {
		const line = formatLogLine('2026-08-09T00:00:00.000Z', 'warn', 'Check ‼️/a|b/\nnext‼️');
		expect(line).toBe(
			'| 2026-08-09T00:00:00.000Z | WARN | plugin |  |  | Check /x\\|x/\\nxxxx | Check ‼️/a\\|b/\\nnext‼️ |\n',
		);
	});

	it('uppercases every level in the Level column', () => {
		for (const level of ['debug', 'warn', 'error'] as const) {
			expect(formatLogLine('2026-08-09T00:00:00.000Z', level, 'x')).toContain(
				`| ${level.toUpperCase()} |`,
			);
		}
	});
});
