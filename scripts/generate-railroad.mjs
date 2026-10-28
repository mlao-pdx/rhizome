import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import prettier from 'prettier';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const RAILROAD_DIR = path.join(ROOT_DIR, 'docs', 'railroad');
const ASSETS_DIR = path.join(RAILROAD_DIR, 'assets');
const README_PATH = path.join(RAILROAD_DIR, 'README.md');

const SVG_STYLE = `<style>
  :root {
    --rr-bg: #f8fafc;
    --rr-card-border: #e2e8f0;
    --rr-track: #334155;
    --rr-term-fill: #e0f2fe;
    --rr-term-stroke: #0284c7;
    --rr-term-text: #0c4a6e;
    --rr-nonterm-fill: #ede9fe;
    --rr-nonterm-stroke: #7c3aed;
    --rr-nonterm-text: #2e1065;
    --rr-comment-text: #475569;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --rr-bg: #0f172a;
      --rr-card-border: #334155;
      --rr-track: #cbd5e1;
      --rr-term-fill: #0c4a6e;
      --rr-term-stroke: #38bdf8;
      --rr-term-text: #f0f9ff;
      --rr-nonterm-fill: #2e1065;
      --rr-nonterm-stroke: #a78bfa;
      --rr-nonterm-text: #f5f3ff;
      --rr-comment-text: #94a3b8;
    }
  }
  svg.railroad-diagram {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }
  rect.railroad-card {
    fill: var(--rr-bg);
    stroke: var(--rr-card-border);
    stroke-width: 1.5;
  }
  svg.railroad-diagram path {
    stroke-width: 2;
    stroke: var(--rr-track);
    fill: none;
  }
  svg.railroad-diagram text {
    font: 600 13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    text-anchor: middle;
  }
  svg.railroad-diagram g.terminal rect {
    fill: var(--rr-term-fill);
    stroke: var(--rr-term-stroke);
    stroke-width: 1.5;
  }
  svg.railroad-diagram g.terminal text {
    fill: var(--rr-term-text);
  }
  svg.railroad-diagram g.non-terminal rect {
    fill: var(--rr-nonterm-fill);
    stroke: var(--rr-nonterm-stroke);
    stroke-width: 1.5;
  }
  svg.railroad-diagram g.non-terminal text {
    fill: var(--rr-nonterm-text);
  }
  svg.railroad-diagram text.comment {
    font: italic 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    fill: var(--rr-comment-text);
  }
</style>`;

function escapeXmlAttr(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function escapeXmlText(value) {
	return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function loadChevrotainDiagramsBuilder() {
	const diagramsDir = path.join(ROOT_DIR, 'node_modules', 'chevrotain', 'diagrams');
	const railroadCode = fs.readFileSync(
		path.join(diagramsDir, 'vendor', 'railroad-diagrams.js'),
		'utf8',
	);
	const builderCode = fs.readFileSync(
		path.join(diagramsDir, 'src', 'diagrams_builder.js'),
		'utf8',
	);

	const railroadExports = {};
	const railroadModule = { exports: railroadExports };
	vm.runInNewContext(railroadCode, {
		exports: railroadExports,
		module: railroadModule,
	});

	const FakeSVGPrototype = Object.getPrototypeOf(railroadModule.exports.Diagram.prototype);
	FakeSVGPrototype.escapeString = escapeXmlText;
	FakeSVGPrototype.toString = function toString() {
		let str = `<${this.tagName}`;
		const isGroup = this.tagName === 'g' || this.tagName === 'svg';
		if (this.tagName === 'svg') {
			str += ' xmlns="http://www.w3.org/2000/svg" role="img"';
		}
		for (const attr of Object.keys(this.attrs)) {
			const val = this.attrs[attr];
			if (val === undefined || val === null) {
				continue;
			}
			str += ` ${attr}="${escapeXmlAttr(val)}"`;
		}
		str += '>';
		if (isGroup) {
			str += '\n';
		}
		if (this.tagName === 'svg') {
			const width = Number(this.attrs.width) || 0;
			const height = Number(this.attrs.height) || 0;
			const cardW = Math.max(0, width - 2);
			const cardH = Math.max(0, height - 2);
			str += `${SVG_STYLE}\n<rect class="railroad-card" x="1" y="1" width="${cardW}" height="${cardH}" rx="8" ry="8"></rect>\n`;
		}
		if (typeof this.children === 'string') {
			str += escapeXmlText(this.children);
		} else {
			for (const child of this.children) {
				str += child;
			}
		}
		str += `</${this.tagName}>\n`;
		return str;
	};

	const builderExports = {};
	const builderModule = { exports: builderExports };
	vm.runInNewContext(builderCode, {
		exports: builderExports,
		module: builderModule,
		require(id) {
			if (id === '../vendor/railroad-diagrams') {
				return railroadModule.exports;
			}
			throw new Error(`Unexpected require("${id}") in diagrams_builder.js`);
		},
	});

	return builderModule.exports;
}

function writeFileIfChanged(filePath, content) {
	if (fs.existsSync(filePath)) {
		const current = fs.readFileSync(filePath, 'utf8');
		if (current === content) {
			return false;
		}
	}
	fs.writeFileSync(filePath, content, 'utf8');
	return true;
}

const RULE_METADATA = {
	query: {
		ebnf: 'Query ::= OrExpression? EOF',
		description:
			'Entry rule for filter queries. An empty or whitespace-only query lowers to `MATCH_ALL`.',
	},
	orExpression: {
		ebnf: 'OrExpression ::= AndExpression ( "OR" AndExpression )*',
		description:
			'Document-level disjunction (`OR`). Lower precedence than `AND` and unary negation.',
	},
	andExpression: {
		ebnf: 'AndExpression ::= NotExpression ( "AND"? NotExpression )*',
		description:
			'Document-level conjunction. Adjacent expressions without an explicit `AND` keyword are implicitly conjoined.',
	},
	notExpression: {
		ebnf: 'NotExpression ::= ( "NOT" | BangNot ) NotExpression | Primary',
		description:
			'Document-level unary negation (`NOT` or prefix `!`) or a `Primary` filter atom. Each negation increments syntactic nesting depth by `+1`.',
	},
	primary: {
		ebnf: 'Primary ::= Parenthesized | PropertyFilter | ScopedOperator | TagShorthand | BareLeafValue',
		description:
			'Disambiguated atomic document-level filter unit: parenthesized group, bracketed property filter, `scope:value` operator, `#tag` shorthand, or bare full-text search term.',
	},
	parenthesized: {
		ebnf: 'Parenthesized ::= "(" OrExpression ")"',
		description:
			'Groups a document-level boolean expression inside `(...)`. Increments syntactic nesting depth by `+1`.',
	},
	propertyFilter: {
		ebnf: 'PropertyFilter ::= "[" PropertyKey ( ":" ValueNotExpr | CompOp ValueLeaf )? "]"',
		description:
			'Bracketed frontmatter or virtual file property filter (`[key]` existence check, `[key: value]` colon match, or `[key >= value]` comparison).',
	},
	scopedOperator: {
		ebnf: 'ScopedOperator ::= ScopeName ":" ValueNotExpr',
		description:
			'Scoped filter operator (`tag:`, `file:`, `path:`, `content:`, `headings:`, `links:`, or registered custom scopes).',
	},
	valueOrExpr: {
		ebnf: 'ValueOrExpr ::= ValueAndExpr ( "OR" ValueAndExpr )*',
		description:
			'Value-level disjunction inside `scope:(...)` or `[key:(...)]`, evaluated against the same scope or property.',
	},
	valueAndExpr: {
		ebnf: 'ValueAndExpr ::= ValueNotExpr ( "AND"? ValueNotExpr )*',
		description:
			'Value-level conjunction inside `scope:(...)` or `[key:(...)]`. Supports both explicit `AND` and implicit juxtaposition.',
	},
	valueNotExpr: {
		ebnf: 'ValueNotExpr ::= ( "NOT" | BangNot ) ValueNotExpr | "(" ValueOrExpr ")" | WikiLinkValue | ValueLeaf',
		description:
			'Value-level negation (`NOT` or prefix `!`), nested parenthesized value group, `[[wikilink]]`, or leaf value. Both unary negation and `(` increment syntactic nesting depth by `+1`.',
	},
	propertyKey: {
		ebnf: 'PropertyKey ::= QuotedString | Identifier',
		description:
			'Frontmatter or virtual property name inside `[...]`. Quoted strings allow spaces and special characters (e.g. `["Due Date" < @today]`).',
	},
	scopeName: {
		ebnf: 'ScopeName ::= Identifier',
		description:
			'Unquoted identifier naming a built-in scope (or alias) or a custom scope before `:`.',
	},
	tagShorthand: {
		ebnf: 'TagShorthand ::= TagLiteral',
		description:
			'Top-level `#tag` shorthand (e.g. `#work/urgent`), lowered identically to `tag:#work/urgent`.',
	},
	bareLeafValue: {
		ebnf: 'BareLeafValue ::= QuotedString | RegexLiteral | DateTimeLiteral | Identifier',
		description:
			'Unscoped full-text search term matched against note title/filename, aliases, and body text.',
	},
	valueLeaf: {
		ebnf: 'ValueLeaf ::= QuotedString | RegexLiteral | DateTimeLiteral | TagLiteral | Identifier',
		description:
			'Leaf value on the right-hand side of `:`, comparison operators (`=`, `!=`, `<`, `<=`, `>`, `>=`), or inside value-level boolean expressions (`ValueNotExpr`), including negative numbers (`-10.5`) and hyphen-prefixed identifiers (`-draft`).',
	},
};

const SECTIONS = [
	{
		title: '1. Top-Level Query & Document Boolean Expressions',
		intro: 'These productions define top-level query entry, operator precedence (`OR` < `AND` < `NOT`/`!`), implicit conjunction, and atomic document filters.',
		rules: [
			'query',
			'orExpression',
			'andExpression',
			'notExpression',
			'primary',
			'parenthesized',
		],
	},
	{
		title: '2. Property Filters & Scoped Operators',
		intro: 'Bracketed property filters (`[key]`, `[key: value]`, `[key op value]`) and `scope:value` operators delegate colon right-hand sides to `valueNotExpr` and comparison right-hand sides to `valueLeaf`.',
		rules: ['propertyFilter', 'scopedOperator'],
	},
	{
		title: '3. Value-Level Boolean Expressions',
		intro: 'On `:` right-hand sides and inside `scope:(...)` or `[key:(...)]`, boolean operators combine or negate value matchers within that scope or property without repeating the prefix.',
		rules: ['valueOrExpr', 'valueAndExpr', 'valueNotExpr'],
	},
	{
		title: '4. Keys, Scopes & Leaf Values',
		intro: 'Terminal-level productions disambiguating property keys, scope identifiers, `#tag` shorthands, bare full-text terms, and value leaves.',
		rules: ['propertyKey', 'scopeName', 'tagShorthand', 'bareLeafValue', 'valueLeaf'],
	},
];

function escapeMarkdownTableCell(text) {
	return String(text).replace(/\|/g, '\\|');
}

export async function generateRailroadDocs() {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const { SearchParser, ALL_TOKENS, MAX_QUERY_LENGTH, MAX_SYNTACTIC_DEPTH } = await jiti.import(
		path.join(ROOT_DIR, 'src', 'core', 'search', 'index.ts'),
	);

	const parser = new SearchParser();
	const productions = parser.getSerializedGastProductions();
	const builder = loadChevrotainDiagramsBuilder();

	fs.mkdirSync(ASSETS_DIR, { recursive: true });

	const expectedSvgFiles = new Set();
	const rulesByName = new Map();

	for (const rule of productions) {
		if (rule.type !== 'Rule') {
			continue;
		}
		rulesByName.set(rule.name, rule);
		const diagram = builder.convertProductionToDiagram(rule, rule.name);
		diagram.format();
		diagram.attrs['aria-label'] = `${rule.name} railroad diagram`;

		const svgContent = diagram.toString();
		const svgFileName = `${rule.name}.svg`;
		expectedSvgFiles.add(svgFileName);
		writeFileIfChanged(path.join(ASSETS_DIR, svgFileName), svgContent);
	}

	// Remove any orphaned .svg files in docs/railroad/assets/
	for (const entry of fs.readdirSync(ASSETS_DIR)) {
		if (entry.endsWith('.svg') && !expectedSvgFiles.has(entry)) {
			fs.unlinkSync(path.join(ASSETS_DIR, entry));
		}
	}

	const documentedRules = new Set(SECTIONS.flatMap((section) => section.rules));
	for (const ruleName of rulesByName.keys()) {
		if (!documentedRules.has(ruleName)) {
			throw new Error(
				`Grammar rule "${ruleName}" in SearchParser is missing from SECTIONS in scripts/generate-railroad.mjs.`,
			);
		}
	}

	const nonSkippedTokenCount = ALL_TOKENS.filter(
		(tok) => tok.GROUP !== 'whitespace' && tok.name !== 'WhiteSpace',
	).length;

	const lines = [
		'# Filter Syntax Railroad Diagrams',
		'',
		'> **Auto-generated from [`src/core/search/parser.ts`](../../src/core/search/parser.ts) and [`src/core/search/tokens.ts`](../../src/core/search/tokens.ts).**',
		'> Normative semantics, type coercion, and diagnostic rules are specified in [`docs/spec/Filter Syntax.md`](../spec/Filter%20Syntax.md).',
		'',
		'## Overview',
		'',
		`Rhizome parses filter queries with a single-pass Chevrotain lexer and a disambiguated LL(k) \`CstParser\` (\`SearchParser\`) comprising **${rulesByName.size} grammar productions** and **${nonSkippedTokenCount} lexical tokens** (plus skipped whitespace).`,
		'',
		'### Visual Legend',
		'',
		"- **Rounded pills** (blue) represent **lexical terminals** consumed directly from the token stream (labelled with their human-readable token `label`, e.g. `'['`, `'OR'`, `'quoted string'`, `'comparison operator'`).",
		'- **Rectangular boxes** (purple) represent **non-terminal subrules** referencing another production in this document.',
		'- **Syntactic Resource Limits**: Maximum query length is **`' +
			MAX_QUERY_LENGTH +
			'` UTF-16 code units**; maximum syntactic nesting depth across unary negation (`NOT` / `!`) and parenthesized groups (`(...)`) is **`' +
			MAX_SYNTACTIC_DEPTH +
			'` levels**.',
		'',
	];

	for (const section of SECTIONS) {
		lines.push(`## ${section.title}`, '', section.intro, '');
		for (const ruleName of section.rules) {
			const rule = rulesByName.get(ruleName);
			if (!rule) {
				throw new Error(`Missing grammar rule "${ruleName}" in SearchParser.`);
			}
			const meta = RULE_METADATA[ruleName];
			if (!meta) {
				throw new Error(`Missing metadata for grammar rule "${ruleName}".`);
			}
			lines.push(
				`### \`${ruleName}\``,
				'',
				meta.description,
				'',
				'```ebnf',
				meta.ebnf,
				'```',
				'',
				`![${ruleName}](./assets/${ruleName}.svg)`,
				'',
			);
		}
	}

	lines.push(
		'## 5. Lexical Tokens Reference',
		'',
		'Tokens are evaluated by `SearchLexer` in priority order (`ALL_TOKENS`). Every non-skipped token defines a concise `label` used in both the railroad diagrams above and runtime `SYNTAX_ERROR` messages.',
		'',
		'| Priority | Token Name | Diagram & Diagnostic `label` | Pattern |',
		'| --- | --- | --- | --- |',
	);

	ALL_TOKENS.forEach((tok, idx) => {
		const priority = idx + 1;
		const name = `\`${tok.name}\``;
		const isSkipped = tok.GROUP === 'whitespace' || tok.name === 'WhiteSpace';
		const label = isSkipped ? '*(skipped)*' : `\`'${escapeMarkdownTableCell(tok.LABEL)}'\``;
		const patternStr =
			tok.PATTERN instanceof RegExp ? tok.PATTERN.source : String(tok.PATTERN ?? '');
		const patternCell = `\`/${escapeMarkdownTableCell(patternStr)}/\``;
		lines.push(`| ${priority} | ${name} | ${label} | ${patternCell} |`);
	});

	lines.push('');

	const rawMarkdown = lines.join('\n');
	const prettierConfig = (await prettier.resolveConfig(README_PATH)) ?? {};
	const formattedMarkdown = await prettier.format(rawMarkdown, {
		...prettierConfig,
		filepath: README_PATH,
	});

	writeFileIfChanged(README_PATH, formattedMarkdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
	await generateRailroadDocs();
}
