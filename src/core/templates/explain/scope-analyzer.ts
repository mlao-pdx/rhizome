import { formatInlineCode } from '@core/search';
import { analyzeSync, Tag, type Template } from 'liquidjs';

const BUILTIN_RHIZOME_ROOT_GLOBALS: ReadonlySet<string> = new Set([
	'query',
	'this',
	'now',
	'today',
	'tz',
	'vault',
	'language',
	'platform',
	'template',
	'targetPath',
	'frontmatter',
	'◊',
	'forloop',
	'tablerowloop',
	'block',
	'empty',
	'blank',
	'nil',
	'null',
	'true',
	'false',
]);

const SHADOWABLE_ROOT_GLOBALS: ReadonlySet<string> = new Set([
	'query',
	'this',
	'now',
	'today',
	'tz',
	'vault',
	'language',
	'platform',
	'template',
	'targetPath',
	'frontmatter',
	'◊',
]);

/**
 * Call-site parameter binding passed into `{% render %}` or `{% layout %}`.
 */
export interface CallSiteBindingInfo {
	readonly name: string;
	readonly sourceExpr: string;
	readonly kind: 'named' | 'with' | 'for';
}

/**
 * Caller lexical context passed into `analyzeRenderPartialScope` (Spec §7.3.2).
 */
export interface PartialCallerScopeContext {
	readonly callerLocals: ReadonlySet<string>;
	readonly knownQueryNames: ReadonlySet<string>;
	readonly isDynamicNullTemplate: boolean;
}

/**
 * Static scope and shared-global mutation summary for a `{% render %}` partial call site.
 */
export interface PartialScopeSummary {
	readonly bindings: readonly CallSiteBindingInfo[];
	readonly unboundVariables: readonly string[];
	readonly shadowedNames: readonly string[];
	readonly readsNullTemplate: boolean;
	readonly mutatesFrontmatter: boolean;
	readonly mutatesTargetPath: boolean;
	readonly mutatesHeadingLevel: boolean;
}

interface InspectableRenderTag {
	readonly file?: unknown;
	readonly hash?: { readonly hash?: Record<string, { getText?: () => string } | undefined> };
	readonly with?: { readonly value?: { getText?: () => string }; readonly alias?: unknown };
	readonly forBinding?: { readonly value?: { getText?: () => string }; readonly alias?: unknown };
}

interface InspectableLayoutTag {
	readonly file?: unknown;
	readonly args?: { readonly hash?: Record<string, { getText?: () => string } | undefined> };
	readonly templates?: Template[];
}

function getValText(tok: { getText?: () => string } | undefined): string {
	return tok && typeof tok.getText === 'function' ? tok.getText().trim() : '';
}

/**
 * Classifies a partial AST as **Complex** when it contains conditionals (`if`/`unless`/`case`),
 * loops (`for`/`tablerow`), or nested `render` tags; otherwise **Simple** (Spec §7.3.3).
 */
export function isComplexPartialAst(templates: readonly Template[]): boolean {
	for (const tpl of templates) {
		if (!(tpl instanceof Tag)) continue;
		const name = (tpl as { readonly name?: string }).name ?? '';
		if (
			name === 'if' ||
			name === 'unless' ||
			name === 'case' ||
			name === 'for' ||
			name === 'tablerow' ||
			name === 'render'
		) {
			return true;
		}
		const withChildren = tpl as unknown as {
			readonly templates?: Template[];
		};
		if (Array.isArray(withChildren.templates) && isComplexPartialAst(withChildren.templates)) {
			return true;
		}
	}
	return false;
}

function scanCustomGlobalEffects(templates: readonly Template[]): {
	mutatesFrontmatter: boolean;
	mutatesTargetPath: boolean;
	mutatesHeadingLevel: boolean;
} {
	let mutatesFrontmatter = false;
	let mutatesTargetPath = false;
	let mutatesHeadingLevel = false;

	const walk = (nodes: readonly Template[]): void => {
		for (const tpl of nodes) {
			if (!(tpl instanceof Tag)) continue;
			const tagName = (tpl as { readonly name?: string }).name ?? '';
			if (tagName === 'frontmatter') {
				mutatesFrontmatter = true;
			} else if (tagName === 'targetPath') {
				mutatesTargetPath = true;
			} else if (tagName === 'heading') {
				mutatesHeadingLevel = true;
			}
			const withChildren = tpl as unknown as {
				readonly templates?: Template[];
				readonly elseTemplates?: Template[];
				readonly branches?: readonly { readonly templates?: Template[] }[];
			};
			if (Array.isArray(withChildren.templates)) {
				walk(withChildren.templates);
			}
			if (Array.isArray(withChildren.elseTemplates)) {
				walk(withChildren.elseTemplates);
			}
			if (Array.isArray(withChildren.branches)) {
				const branchList = withChildren.branches as readonly {
					readonly templates?: Template[];
				}[];
				for (const b of branchList) {
					if (Array.isArray(b.templates)) {
						walk(b.templates);
					}
				}
			}
		}
	};

	walk(templates);
	return { mutatesFrontmatter, mutatesTargetPath, mutatesHeadingLevel };
}

/**
 * Extracts call-site parameter bindings and analyzes isolated variable scope, shadowing, null
 * `template.*` reads, and shared `ctx.globals` side effects for a `{% render %}` tag.
 */
export function analyzeRenderPartialScope(
	renderTag: Tag,
	partialTemplates: readonly Template[] | null,
	callerContext?: PartialCallerScopeContext,
): PartialScopeSummary {
	const inspect = renderTag as unknown as InspectableRenderTag;
	const rawFile = typeof inspect.file === 'string' ? inspect.file.trim() : null;
	const bindings: CallSiteBindingInfo[] = [];
	const passedNames = new Set<string>();

	const hashObj = inspect.hash?.hash;
	if (hashObj && typeof hashObj === 'object') {
		for (const [k, v] of Object.entries(hashObj)) {
			bindings.push({ name: k, sourceExpr: getValText(v) || k, kind: 'named' });
			passedNames.add(k);
		}
	}

	if (inspect.with) {
		const alias =
			typeof inspect.with.alias === 'string' && inspect.with.alias.length > 0
				? inspect.with.alias
				: (rawFile ?? 'item');
		bindings.push({
			name: alias,
			sourceExpr: getValText(inspect.with.value),
			kind: 'with',
		});
		passedNames.add(alias);
	}

	if (inspect.forBinding) {
		const forCollectionExpr = getValText(inspect.forBinding.value);
		const alias =
			typeof inspect.forBinding.alias === 'string' && inspect.forBinding.alias.length > 0
				? inspect.forBinding.alias
				: (rawFile ?? 'item');
		bindings.push({
			name: alias,
			sourceExpr: forCollectionExpr,
			kind: 'for',
		});
		passedNames.add(alias);
	}

	const callerLocals = callerContext?.callerLocals;
	const knownQueries = callerContext?.knownQueryNames;
	const shadowedSet = new Set<string>();

	const checkShadow = (candidateName: string): void => {
		if (!candidateName) return;
		if (
			SHADOWABLE_ROOT_GLOBALS.has(candidateName) ||
			callerLocals?.has(candidateName) ||
			knownQueries?.has(candidateName)
		) {
			shadowedSet.add(candidateName);
		}
	};
	for (const pName of passedNames) {
		checkShadow(pName);
	}

	const unboundVariables: string[] = [];
	let readsNullTemplate = false;
	let mutatesFrontmatter = false;
	let mutatesTargetPath = false;
	let mutatesHeadingLevel = false;

	if (partialTemplates && partialTemplates.length > 0) {
		try {
			const staticRes = analyzeSync([...partialTemplates], { partials: false });
			for (const localName of Object.keys(staticRes.locals)) {
				checkShadow(localName);
			}
			if (
				callerContext?.isDynamicNullTemplate &&
				Object.prototype.hasOwnProperty.call(staticRes.variables, 'template') &&
				!passedNames.has('template')
			) {
				readsNullTemplate = true;
			}
			for (const rootName of Object.keys(staticRes.globals)) {
				if (
					rootName.length > 0 &&
					!BUILTIN_RHIZOME_ROOT_GLOBALS.has(rootName) &&
					!passedNames.has(rootName) &&
					(callerLocals === undefined || callerLocals.has(rootName))
				) {
					unboundVariables.push(rootName);
				}
			}
		} catch {
			// Best-effort static analysis
		}
		const effects = scanCustomGlobalEffects(partialTemplates);
		mutatesFrontmatter = effects.mutatesFrontmatter;
		mutatesTargetPath = effects.mutatesTargetPath;
		mutatesHeadingLevel = effects.mutatesHeadingLevel;
	}

	unboundVariables.sort();
	const shadowedNames = [...shadowedSet].sort();
	return Object.freeze({
		bindings: Object.freeze(bindings),
		unboundVariables: Object.freeze(unboundVariables),
		shadowedNames: Object.freeze(shadowedNames),
		readsNullTemplate,
		mutatesFrontmatter,
		mutatesTargetPath,
		mutatesHeadingLevel,
	});
}

/**
 * Extracts named key-value arguments passed to a `{% layout %}` tag.
 */
export function extractLayoutArgsSummary(layoutTag: Tag): {
	readonly rawFile: string | null;
	readonly bindings: readonly CallSiteBindingInfo[];
} {
	const inspect = layoutTag as unknown as InspectableLayoutTag;
	const rawFile = typeof inspect.file === 'string' ? inspect.file.trim() : null;
	const bindings: CallSiteBindingInfo[] = [];
	const hashObj = inspect.args?.hash;
	if (hashObj && typeof hashObj === 'object') {
		for (const [k, v] of Object.entries(hashObj)) {
			bindings.push({ name: k, sourceExpr: getValText(v) || k, kind: 'named' });
		}
	}
	return { rawFile, bindings: Object.freeze(bindings) };
}

/**
 * Formats passed bindings (`key = expr`, `with expr as alias`, `for expr as alias`) as inline Markdown.
 */
export function formatCallSiteBindingsInline(bindings: readonly CallSiteBindingInfo[]): string {
	if (bindings.length === 0) {
		return 'no explicit arguments';
	}
	return bindings
		.map((b) => {
			if (b.kind === 'for') {
				return `each ${formatInlineCode(b.name)} in ${formatInlineCode(b.sourceExpr)}`;
			}
			if (b.kind === 'with') {
				return `${formatInlineCode(b.name)} ← ${formatInlineCode(b.sourceExpr)} (\`with\`)`;
			}
			return `${formatInlineCode(b.name)} ← ${formatInlineCode(b.sourceExpr)}`;
		})
		.join(', ');
}
