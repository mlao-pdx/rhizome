import {
	astUsesHostReference,
	collectQueryReferences,
	parseQuery,
	type SourceSpan,
} from '@core/search';
import { Tag, type Template } from 'liquidjs';
import { offsetRangeToSourceSpan, type QueryTagEnvironment } from './query-tag';
import type { ExtractedQueryBlock } from './types';

const THIS_REF_FALLBACK_RE = /@this(?![a-zA-Z0-9_+-])/;
const QUERY_REF_FALLBACK_RE = /@query\.([a-zA-Z_][a-zA-Z0-9_-]*)/g;

interface LoopInspectableTag {
	readonly name: string;
	readonly queryName?: string | null;
	readonly token: Tag['token'];
	readonly forBinding?: unknown;
	readonly templates?: Template[];
	readonly branches?: unknown;
	readonly elseTemplates?: Template[];
}

function getDirectChildTemplates(tag: LoopInspectableTag): Template[] {
	const children: Template[] = [];
	if (Array.isArray(tag.templates)) {
		children.push(...tag.templates);
	}
	if (Array.isArray(tag.branches)) {
		for (const rawBranch of tag.branches as unknown[]) {
			if (rawBranch && typeof rawBranch === 'object') {
				const branchTemplates = (rawBranch as { templates?: unknown }).templates;
				if (Array.isArray(branchTemplates)) {
					children.push(...(branchTemplates as Template[]));
				}
			}
		}
	}
	if (Array.isArray(tag.elseTemplates)) {
		children.push(...tag.elseTemplates);
	}
	return children;
}

function resolveTagSpan(
	rootSource: string,
	env: QueryTagEnvironment,
	currentFile: string | null,
	token: { begin?: unknown; end?: unknown; input?: unknown } | undefined,
): SourceSpan | null {
	if (!token || typeof token.begin !== 'number' || typeof token.end !== 'number') {
		return null;
	}
	const targetSource =
		currentFile !== null
			? (env.fileSources.get(currentFile) ??
				(typeof token.input === 'string' ? token.input : null))
			: rootSource;
	if (typeof targetSource !== 'string') {
		return null;
	}
	return offsetRangeToSourceSpan(targetSource, token.begin, Math.max(token.begin + 1, token.end));
}

/**
 * Returns `true` when `tag` is a `{% render ... for ... %}` loop tag.
 */
export function isRenderLoopTag(tag: {
	readonly name: string;
	readonly forBinding?: unknown;
}): boolean {
	return tag.name === 'render' && tag.forBinding !== undefined;
}

/**
 * Walks an in-file `Template[]` AST and records `QUERY_IN_LOOP_ERROR` whenever a `{% query %}`
 * block appears inside `{% for %}`, `{% tablerow %}`, or a partial invoked via `{% render ... for %}`.
 */
export function validateQueriesNotInLoop(
	rootSource: string,
	env: QueryTagEnvironment,
	templates: readonly Template[],
	currentFile: string | null,
	inLoop: boolean = false,
	onlyQueryNames?: ReadonlySet<string>,
): void {
	for (const tpl of templates) {
		if (!(tpl instanceof Tag)) {
			continue;
		}
		const tag = tpl as unknown as LoopInspectableTag;

		if (tag.name === 'query') {
			if (
				inLoop &&
				(onlyQueryNames === undefined ||
					(typeof tag.queryName === 'string' && onlyQueryNames.has(tag.queryName)))
			) {
				const span = resolveTagSpan(rootSource, env, currentFile, tag.token);
				const inFileSuffix = currentFile !== null ? ` (in '${currentFile}')` : '';
				const alreadyReported = env.diagnostics.some(
					(d) =>
						d.code === 'QUERY_IN_LOOP_ERROR' &&
						d.file === currentFile &&
						d.span?.startOffset === span?.startOffset,
				);
				if (!alreadyReported) {
					env.diagnostics.push(
						Object.freeze({
							code: 'QUERY_IN_LOOP_ERROR',
							severity: 'error',
							issue: `'{% query %}' blocks cannot be nested inside loop tags ('{% for %}', '{% tablerow %}', or '{% render ... for %}')${inFileSuffix}.`,
							hint: "Hoist '{% query %}' outside the loop so the vault is queried once and filter its results inside the loop.",
							span,
							file: currentFile,
						}),
					);
				}
			}
			continue;
		}

		const nextInLoop = inLoop || tag.name === 'for' || tag.name === 'tablerow';
		const children = getDirectChildTemplates(tag);
		if (children.length > 0) {
			validateQueriesNotInLoop(
				rootSource,
				env,
				children,
				currentFile,
				nextInLoop,
				onlyQueryNames,
			);
		}
	}
}

/**
 * Partitions extracted `{% query %}` blocks for `"newNote"` rendering into:
 * - `staticQueries`: queries that neither reference `@this` nor transitively depend on an `@this` query via `@query.<name>`.
 * - `lazyQueryNames`: queries that reference `@this` or transitively depend on a lazy query, deferred to `QueryBlockTag.render(ctx)` in Pass 2.
 */
export function partitionNewNoteQueries(queries: readonly ExtractedQueryBlock[]): {
	readonly staticQueries: readonly ExtractedQueryBlock[];
	readonly lazyQueryNames: ReadonlySet<string>;
} {
	const lazyNames = new Set<string>();
	const depsByQuery = new Map<string, Set<string>>();

	for (const q of queries) {
		const deps = new Set<string>();
		const parsed = parseQuery(q.query);
		let usesHost = false;

		if (parsed.ast !== null) {
			usesHost = astUsesHostReference(parsed.ast);
			for (const ref of collectQueryReferences(parsed.ast)) {
				deps.add(ref.queryName);
			}
		}
		if (!usesHost && THIS_REF_FALLBACK_RE.test(q.query)) {
			usesHost = true;
		}
		QUERY_REF_FALLBACK_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = QUERY_REF_FALLBACK_RE.exec(q.query)) !== null) {
			if (m[1]) {
				deps.add(m[1]);
			}
		}

		depsByQuery.set(q.name, deps);
		if (usesHost) {
			lazyNames.add(q.name);
		}
	}

	let changed = true;
	while (changed) {
		changed = false;
		for (const q of queries) {
			if (lazyNames.has(q.name)) continue;
			const deps = depsByQuery.get(q.name);
			if (deps && [...deps].some((dep) => lazyNames.has(dep))) {
				lazyNames.add(q.name);
				changed = true;
			}
		}
	}

	const staticQueries = queries.filter((q) => !lazyNames.has(q.name));
	return {
		staticQueries,
		lazyQueryNames: lazyNames,
	};
}

/**
 * Extracts `file.path` strings from a matched query result bucket before cutoff slicing,
 * preserving full match sets for downstream `@query.<name>` lazy waves.
 */
export function extractMatchedDocumentPaths(rows: unknown): readonly string[] {
	if (!Array.isArray(rows)) {
		return Object.freeze([]);
	}
	const paths: string[] = [];
	for (const row of rows as readonly unknown[]) {
		if (row && typeof row === 'object' && 'file' in row) {
			const fileObj = (row as { file?: unknown }).file;
			if (fileObj && typeof fileObj === 'object' && 'path' in fileObj) {
				const p = (fileObj as { path?: unknown }).path;
				if (typeof p === 'string' && p.length > 0) {
					paths.push(p);
				}
			}
		}
	}
	return Object.freeze(paths);
}
