import { formatAuthoredFilter, resolvePropertyTypeWithOrigin } from './explain-helpers';
import type {
	PropertyFilterNode,
	PropertyTypeRegistry,
	ScopedFilterNode,
	SearchAST,
} from './types';

/**
 * Escapes arbitrary user text so it can be embedded safely inside a double-quoted Mermaid node label.
 */
export function escapeMermaidLabel(raw: string): string {
	let out = '';
	for (const ch of raw) {
		switch (ch) {
			case '&':
				out += '&amp;';
				break;
			case '"':
				out += '&quot;';
				break;
			case '<':
				out += '&lt;';
				break;
			case '>':
				out += '&gt;';
				break;
			case '[':
				out += '&#91;';
				break;
			case ']':
				out += '&#93;';
				break;
			case '(':
				out += '&#40;';
				break;
			case ')':
				out += '&#41;';
				break;
			case '{':
				out += '&#123;';
				break;
			case '}':
				out += '&#125;';
				break;
			case '|':
				out += '&#124;';
				break;
			case '`':
				out += '&#96;';
				break;
			case '\r':
				out += '\\r';
				break;
			case '\n':
				out += '\\n';
				break;
			default:
				out += ch;
				break;
		}
	}
	return out;
}

export interface MermaidRenderContext {
	readonly propertyTypes: Readonly<PropertyTypeRegistry>;
	readonly invalidPropertyNodes: ReadonlySet<PropertyFilterNode>;
	readonly unknownScopeNodes: ReadonlySet<ScopedFilterNode>;
	readonly invalidRegexNodes: ReadonlySet<SearchAST>;
}

/**
 * Renders a compact-leaf Mermaid `flowchart TD` fenced code block for a `SearchAST`.
 */
export function renderExplainMermaid(ast: SearchAST, ctx: MermaidRenderContext): string {
	const lines: string[] = ['```mermaid', 'flowchart TD', '    Root(["Match Note?"])'];
	let counter = 0;

	function visit(node: SearchAST): string {
		counter++;
		const id = `N${counter}`;

		switch (node.type) {
			case 'MATCH_ALL': {
				lines.push(`    ${id}["Match every note in vault (MATCH_ALL)"]`);
				return id;
			}
			case 'LOGICAL': {
				const groupSuffix = node.parenthesized ? ' (parenthesized)' : '';
				const header =
					node.operator === 'AND' ? `ALL (AND)${groupSuffix}` : `ANY (OR)${groupSuffix}`;
				const subtitle =
					node.operator === 'AND'
						? 'Every branch below must match'
						: 'At least one branch below must match';
				lines.push(
					`    ${id}{"${escapeMermaidLabel(header)}<br/>${escapeMermaidLabel(subtitle)}"}`,
				);
				for (const child of node.children) {
					const childId = visit(child);
					lines.push(`    ${id} --> ${childId}`);
				}
				return id;
			}
			case 'NOT': {
				const syntaxDesc = node.syntax === '-' ? '-' : 'NOT';
				lines.push(
					`    ${id}["EXCLUDE (${escapeMermaidLabel(syntaxDesc)})<br/>Note must NOT match child"]`,
				);
				const childId = visit(node.child);
				lines.push(`    ${id} --> ${childId}`);
				return id;
			}
			case 'SCOPED_FILTER': {
				const authored = escapeMermaidLabel(formatAuthoredFilter(node));
				const isInvalid =
					ctx.unknownScopeNodes.has(node) || ctx.invalidRegexNodes.has(node);
				let subtitle: string;
				if (isInvalid) {
					subtitle = `❌ Invalid scope filter (${escapeMermaidLabel(node.rawScope)})`;
				} else if (node.rawScope === '#') {
					subtitle = 'Scope: tag (shorthand #)';
				} else if (node.rawScope.trim().toLowerCase() !== node.scope.toLowerCase()) {
					const compound = node.expr.type !== 'VALUE_LEAF' ? ', compound expr' : '';
					subtitle = `Scope: ${escapeMermaidLabel(node.scope)} (alias ${escapeMermaidLabel(node.rawScope)}:${compound})`;
				} else {
					const compound = node.expr.type !== 'VALUE_LEAF' ? ' (compound expr)' : '';
					subtitle = `Scope: ${escapeMermaidLabel(node.scope)}${compound}`;
				}
				lines.push(`    ${id}["${authored}<br/>${subtitle}"]`);
				return id;
			}
			case 'PROPERTY_FILTER': {
				const authored = escapeMermaidLabel(formatAuthoredFilter(node));
				const typeInfo = resolvePropertyTypeWithOrigin(node.key, ctx.propertyTypes);
				const isInvalid =
					ctx.invalidPropertyNodes.has(node) || ctx.invalidRegexNodes.has(node);
				let subtitle: string;
				if (isInvalid) {
					subtitle = `❌ Invalid property filter (${escapeMermaidLabel(node.key)}: ${typeInfo.type})`;
				} else if (node.operator === 'EXISTS') {
					subtitle = `Property: ${escapeMermaidLabel(node.key)} (${typeInfo.type}) — EXISTS`;
				} else {
					subtitle = `Property: ${escapeMermaidLabel(node.key)} (${typeInfo.type}, op ${escapeMermaidLabel(node.operator)})`;
				}
				lines.push(`    ${id}["${authored}<br/>${subtitle}"]`);
				return id;
			}
			case 'TEXT_MATCH': {
				const authored = escapeMermaidLabel(formatAuthoredFilter(node));
				const isInvalid = ctx.invalidRegexNodes.has(node);
				let subtitle: string;
				if (isInvalid) {
					subtitle = '❌ Invalid regex in bare term';
				} else if (node.matcher.kind === 'regex') {
					subtitle = 'Bare regex (basename, path, aliases, tags)';
				} else {
					subtitle = 'Bare text (basename, path, aliases, tags)';
				}
				lines.push(`    ${id}["${authored}<br/>${subtitle}"]`);
				return id;
			}
		}
	}

	const rootChildId = visit(ast);
	lines.push(`    Root --> ${rootChildId}`);
	lines.push('```');
	return lines.join('\n');
}
