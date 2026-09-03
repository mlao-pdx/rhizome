import type { Rule } from 'eslint';

/**
 * Disallows more than one `@remarks` block tag in a single TSDoc comment.
 *
 * @see docs/dev/tsdoc-conventions.md
 * @remarks
 * `tsdoc/syntax` (`eslint-plugin-tsdoc`) validates TSDoc grammar, but a
 * repeated `@remarks` tag is not a grammar violation — `@microsoft/tsdoc`'s
 * parser silently keeps only the *last* `@remarks` block it finds and
 * discards the rest, with no warning. That makes a duplicate `@remarks`
 * tag a silent-data-loss bug rather than a build failure, which is
 * precisely the gap this rule closes. See `docs/dev/tsdoc-conventions.md`
 * for the one-`@remarks`-per-symbol convention this rule enforces.
 */
const rule: Rule.RuleModule = {
	meta: {
		type: 'problem',
		docs: {
			description: 'Disallow more than one @remarks tag in a single TSDoc comment.',
		},
		schema: [],
		messages: {
			duplicateRemarks:
				'This doc comment has {{count}} @remarks tags. TSDoc only keeps the ' +
				'last one — earlier @remarks blocks are silently discarded, not ' +
				'merged. Combine them into a single @remarks block instead. See ' +
				'docs/dev/tsdoc-conventions.md for the one-@remarks-per-symbol format.',
		},
	},
	create(context) {
		return {
			Program() {
				const sourceCode = context.sourceCode;
				for (const comment of sourceCode.getAllComments()) {
					// Only TSDoc-style `/** ... */` comments are in scope — a plain
					// `/* ... */` block comment's value does not start with `*`.
					if (comment.type !== 'Block' || !comment.value.startsWith('*')) {
						continue;
					}
					const remarksTags = comment.value.match(/^[ \t]*\*[ \t]*@remarks\b/gm) ?? [];
					if (remarksTags.length > 1 && comment.loc) {
						context.report({
							loc: comment.loc,
							messageId: 'duplicateRemarks',
							data: { count: String(remarksTags.length) },
						});
					}
				}
			},
		};
	},
};

export default rule;
