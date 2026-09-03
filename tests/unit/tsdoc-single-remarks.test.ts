import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import tsdocSingleRemarks from '../../eslint-rules/tsdoc-single-remarks';

const linter = new Linter();

function lint(code: string) {
	const results = linter.verify(code, {
		languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
		plugins: { local: { rules: { 'tsdoc-single-remarks': tsdocSingleRemarks } } },
		rules: { 'local/tsdoc-single-remarks': 'error' },
	});
	return results;
}

describe('tsdoc-single-remarks', () => {
	it('flags a doc comment with two @remarks tags', () => {
		const messages = lint(`
/**
 * Summary.
 *
 * @remarks
 * First reason.
 * @remarks
 * Second reason.
 */
function foo() {}
`);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.messageId).toBe('duplicateRemarks');
		expect(messages[0]?.message).toContain('docs/dev/tsdoc-conventions.md');
	});

	it('allows a doc comment with a single @remarks tag', () => {
		const messages = lint(`
/**
 * Summary.
 *
 * @remarks
 * Only reason.
 */
function foo() {}
`);
		expect(messages).toHaveLength(0);
	});

	it('allows a doc comment with no @remarks tag', () => {
		const messages = lint(`
/**
 * Summary only, no remarks.
 */
function foo() {}
`);
		expect(messages).toHaveLength(0);
	});

	it('ignores plain (non-TSDoc) block comments mentioning @remarks twice', () => {
		const messages = lint(`
/* @remarks one @remarks two, not a doc comment */
function foo() {}
`);
		expect(messages).toHaveLength(0);
	});
});
