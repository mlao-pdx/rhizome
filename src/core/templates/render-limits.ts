import { type Context, type Emitter, type Liquid, Tag, type Template, toValue } from 'liquidjs';
import type { LiquidFilterThis } from './selector-evaluator';

/**
 * Unshadowable `Symbol` key storing an opt-in `RenderTelemetryCollector` on `rootScope`
 * (`ctx.globals`), preserved across `ctx.spawn()` during `rhizome-sample` Pass 2 renders.
 */
export const RENDER_TELEMETRY_SYMBOL = Symbol.for('rhizome.renderTelemetryCollector');

/**
 * Maximum wall-clock execution time (`5,000 ms`) permitted for a single LiquidJS Pass 2
 * template render across all tags, partials, layouts, and Rhizome collection filters.
 */
export const TEMPLATE_RENDER_LIMIT_MS = 5_000;

/**
 * Maximum internal allocation budget (`32,000,000` units) passed to LiquidJS's built-in
 * filter memory limiter (`ctx.memoryLimit`).
 */
export const TEMPLATE_MEMORY_LIMIT = 32_000_000;

/**
 * Maximum character count (`3.25 MiB` / `3,407,872` UTF-16 code units) that a single Pass 2
 * root output, `{% layout %}` body store pass, `{% capture %}` variable budget, or custom
 * formatting filter may emit before aborting.
 */
export const MAX_TEMPLATE_OUTPUT_CHARS = 3_407_872;

/**
 * Iteration stride (`1,024`, power of two for bitmask checks) between `ctx.renderLimit`
 * deadline checks inside custom synchronous Rhizome filter loops.
 */
export const FILTER_LIMIT_CHECK_STRIDE = 1_024;

export const TEMPLATE_OUTPUT_LIMIT_HINT =
	'Narrow the query, pick fewer properties (for example with `| pick`), or limit rendered items (for example with `| slice: 0, 500`).';

export const TEMPLATE_RENDER_TIME_LIMIT_HINT =
	'Narrow the query, simplify nested loops or heavy sorting/grouping, or limit rendered items (for example with `| slice: 0, 200`).';

export const TEMPLATE_MEMORY_LIMIT_HINT =
	'Narrow the query, avoid duplicating large strings or arrays across filters, or limit rendered fields (for example with `| pick` or `| slice`).';

const LIMIT_NUMBER_FORMATTER = new Intl.NumberFormat('en-US');
const BLOCK_MODE_STORE = 1;

type EmitterBucketKind = 'root' | 'layout' | 'capture';

interface RenderOutputBudget {
	hasRootEmitter: boolean;
	inLayoutStore: boolean;
	rootChars: number;
	layoutChars: number;
	captureChars: number;
}

const renderOutputBudgets = new WeakMap<object, RenderOutputBudget>();
const installedRenderers = new WeakSet<object>();

/**
 * Reads a monotonic millisecond timestamp matching LiquidJS's internal `getPerformance().now()`
 * clock source, falling back to `Date.now()` if `performance.now` is unavailable.
 */
export function readMonotonicNowMs(): number {
	if (
		typeof performance === 'object' &&
		performance !== null &&
		typeof performance.now === 'function'
	) {
		return performance.now();
	}
	return Date.now();
}

/**
 * Constructs an `Error` with an actionable `.hint` property when a template or filter
 * exceeds `MAX_TEMPLATE_OUTPUT_CHARS`.
 */
export function createTemplateOutputLimitError(): Error & { readonly hint: string } {
	const mib = (MAX_TEMPLATE_OUTPUT_CHARS / (1024 * 1024)).toFixed(2);
	const formattedChars = LIMIT_NUMBER_FORMATTER.format(MAX_TEMPLATE_OUTPUT_CHARS);
	const err = new Error(
		`Template output exceeded the ${mib} MiB (${formattedChars} character) size limit`,
	) as Error & { hint: string };
	err.hint = TEMPLATE_OUTPUT_LIMIT_HINT;
	return err;
}

function stringifyChunkWithBudget(raw: unknown, maxChars: number): string {
	const value: unknown = toValue(raw);
	if (typeof value === 'string') {
		if (value.length > maxChars) {
			throw createTemplateOutputLimitError();
		}
		return value;
	}
	if (value === null || value === undefined) {
		return '';
	}
	if (Array.isArray(value)) {
		const parts: string[] = [];
		let used = 0;
		for (let i = 0; i < value.length; i++) {
			const part = stringifyChunkWithBudget(value[i], maxChars - used);
			if (part.length > 0) {
				used += part.length;
				if (used > maxChars) {
					throw createTemplateOutputLimitError();
				}
				parts.push(part);
			}
		}
		return parts.join('');
	}
	let scalar = '';
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		scalar = String(value);
	} else if (typeof value === 'symbol') {
		scalar = value.toString();
	} else if (typeof value === 'object' || typeof value === 'function') {
		const toStr = (value as { toString?: unknown }).toString;
		scalar = typeof toStr === 'function' ? String(toStr.call(value)) : '[object Object]';
	}
	if (scalar.length > maxChars) {
		throw createTemplateOutputLimitError();
	}
	return scalar;
}

class BoundedEmitter implements Emitter {
	public buffer = '';
	public readonly kind: EmitterBucketKind;
	private readonly budget: RenderOutputBudget;

	constructor(budget: RenderOutputBudget, kind: EmitterBucketKind) {
		this.budget = budget;
		this.kind = kind;
	}

	write(html: unknown): void {
		const bucketUsed =
			this.kind === 'root'
				? this.budget.rootChars
				: this.kind === 'layout'
					? this.budget.layoutChars
					: this.budget.captureChars;
		const remainingInBucket = MAX_TEMPLATE_OUTPUT_CHARS - bucketUsed;
		const remainingInBuffer = MAX_TEMPLATE_OUTPUT_CHARS - this.buffer.length;
		const maxAllowed = Math.min(remainingInBucket, remainingInBuffer);
		if (maxAllowed < 0) {
			throw createTemplateOutputLimitError();
		}

		const chunk = stringifyChunkWithBudget(html, maxAllowed);
		const len = chunk.length;
		if (len === 0) {
			return;
		}
		if (this.kind === 'root') {
			this.budget.rootChars += len;
		} else if (this.kind === 'layout') {
			this.budget.layoutChars += len;
		} else {
			this.budget.captureChars += len;
		}
		this.buffer += chunk;
	}
}

/**
 * Formats a canonical AST node identity key `file:begin:end` for a LiquidJS `Template` node.
 */
export function formatAstNodeKey(tpl: Template): string | null {
	const tok = (tpl as { readonly token?: { begin?: unknown; end?: unknown; file?: unknown } })
		.token;
	if (!tok || typeof tok.begin !== 'number' || typeof tok.end !== 'number') {
		return null;
	}
	const file = typeof tok.file === 'string' ? tok.file.trim() : '';
	return `${file}:${tok.begin}:${tok.end}`;
}

function isRenderTagTemplate(tpl: Template): boolean {
	return tpl instanceof Tag && (tpl as { readonly name?: unknown }).name === 'render';
}

/**
 * Opt-in Pass-2 profiler attached only during `rhizome-sample` renders to record cumulative
 * character deltas emitted per AST node onto `'root'` and `'layout'` `BoundedEmitter`s and
 * capture the active `{% render %}` call-site chain if a runtime error is thrown inside a partial.
 */
export class RenderTelemetryCollector {
	public readonly rootNodeChars = new Map<string, number>();
	public readonly layoutStoreNodeChars = new Map<string, number>();
	public readonly activeRenderCallStack: string[] = [];
	public failedRenderCallStack: readonly string[] | null = null;

	public recordChars(kind: 'root' | 'layout', nodeKey: string, delta: number): void {
		if (delta <= 0) {
			return;
		}
		const map = kind === 'root' ? this.rootNodeChars : this.layoutStoreNodeChars;
		map.set(nodeKey, (map.get(nodeKey) ?? 0) + delta);
	}

	public getNodeChars(nodeKey: string): number {
		return this.rootNodeChars.get(nodeKey) ?? this.layoutStoreNodeChars.get(nodeKey) ?? 0;
	}

	public getTemplateChars(tpl: Template): number {
		const key = formatAstNodeKey(tpl);
		return key !== null ? this.getNodeChars(key) : 0;
	}

	public isOnFailedRenderCallStack(nodeKey: string | null): boolean {
		return (
			nodeKey !== null &&
			this.failedRenderCallStack !== null &&
			this.failedRenderCallStack.includes(nodeKey)
		);
	}
}

/**
 * Attaches `collector` onto `rootScope` behind `RENDER_TELEMETRY_SYMBOL` so `renderTemplates`
 * observes it across root, `{% layout %}`, and `ctx.spawn()` (`{% render %}`) contexts.
 */
export function attachRenderTelemetryCollector(
	rootScope: Record<PropertyKey, unknown>,
	collector: RenderTelemetryCollector,
): void {
	Object.defineProperty(rootScope, RENDER_TELEMETRY_SYMBOL, {
		value: collector,
		enumerable: false,
		configurable: false,
		writable: false,
	});
}

function readRenderTelemetryCollector(ctx: Context): RenderTelemetryCollector | null {
	if (!ctx || typeof ctx !== 'object') {
		return null;
	}
	const globals = (ctx as unknown as { globals?: Record<PropertyKey, unknown> }).globals;
	const candidate = globals?.[RENDER_TELEMETRY_SYMBOL];
	return candidate instanceof RenderTelemetryCollector ? candidate : null;
}

function getOrCreateOutputBudget(ctx: Context): RenderOutputBudget {
	const keyObj: object =
		ctx && typeof ctx === 'object' && ctx.renderLimit && typeof ctx.renderLimit === 'object'
			? ctx.renderLimit
			: ctx;
	let budget = renderOutputBudgets.get(keyObj);
	if (!budget) {
		budget = {
			hasRootEmitter: false,
			inLayoutStore: false,
			rootChars: 0,
			layoutChars: 0,
			captureChars: 0,
		};
		renderOutputBudgets.set(keyObj, budget);
	}
	return budget;
}

function isLayoutStorePass(ctx: Context): boolean {
	const getReg = (ctx as { getRegister?: (name: string) => unknown } | undefined)?.getRegister;
	if (typeof getReg !== 'function') {
		return false;
	}
	return getReg.call(ctx, 'blockMode') === BLOCK_MODE_STORE;
}

function* renderTemplatesInstrumented(
	originalRenderTemplates: (
		templates: Template[],
		ctx: Context,
		emitter?: Emitter,
	) => Generator<unknown, unknown, unknown>,
	templates: Template[],
	ctx: Context,
	activeEmitter: BoundedEmitter,
	collector: RenderTelemetryCollector,
): Generator<unknown, unknown, unknown> {
	const kind = activeEmitter.kind === 'root' ? 'root' : 'layout';
	for (const tpl of templates) {
		const before = activeEmitter.buffer.length;
		const isRender = isRenderTagTemplate(tpl);
		const nodeKey = formatAstNodeKey(tpl);
		if (isRender && nodeKey !== null) {
			collector.activeRenderCallStack.push(nodeKey);
		}
		try {
			yield* originalRenderTemplates([tpl], ctx, activeEmitter);
		} catch (err) {
			if (
				collector.failedRenderCallStack === null &&
				collector.activeRenderCallStack.length > 0
			) {
				collector.failedRenderCallStack = Object.freeze([
					...collector.activeRenderCallStack,
				]);
			}
			throw err;
		} finally {
			if (isRender && nodeKey !== null) {
				collector.activeRenderCallStack.pop();
			}
		}
		const delta = activeEmitter.buffer.length - before;
		if (delta > 0 && nodeKey !== null) {
			collector.recordChars(kind, nodeKey, delta);
		}
		const ctxControl = ctx as unknown as {
			breakCalled?: boolean;
			continueCalled?: boolean;
		};
		if (ctxControl.breakCalled || ctxControl.continueCalled) {
			break;
		}
	}
	return activeEmitter.buffer;
}

/**
 * Wraps `liquid.renderer.renderTemplates` idempotently so every render invocation without an
 * explicit emitter writes through a bucketed `BoundedEmitter` keyed on `ctx.renderLimit`,
 * tracking `root`, `{% layout %}`, and `{% capture %}` character budgets separately so each
 * enforces the true `3.25 MiB` (`MAX_TEMPLATE_OUTPUT_CHARS`) limit without double-charging
 * layout or captured strings when they are later emitted to root.
 *
 * @remarks
 * (spec-change, 2026-11-24) Extended per `docs/spec/Extended Explain Plan.md` §7.4 to record
 * opt-in per-AST-node character deltas and `{% render %}` call-site error stacks when a
 * `RenderTelemetryCollector` is attached on `ctx.globals`, with zero overhead in production renders.
 *
 * SUPERSEDED (design, 2026-11-20): LiquidJS `10.30.1`'s built-in `SimpleEmitter` concatenates output into
 * `this.buffer` without charging `ctx.memoryLimit`. Separating `rootChars`, `layoutChars`, and
 * `captureChars` per `ctx.renderLimit` ensures final output is measured at its true size while
 * still capping unrendered `{% capture %}` loops and oversized `{% layout %}` bodies.
 */
export function installBoundedTemplateRenderer(liquid: Liquid): void {
	const renderer = liquid.renderer as unknown as {
		renderTemplates: (
			templates: Template[],
			ctx: Context,
			emitter?: Emitter,
		) => Generator<unknown, unknown, unknown>;
	};
	if (installedRenderers.has(renderer)) {
		return;
	}
	installedRenderers.add(renderer);

	const originalRenderTemplates = renderer.renderTemplates.bind(renderer);
	renderer.renderTemplates = function* (
		templates: Template[],
		ctx: Context,
		emitter?: Emitter,
	): Generator<unknown, unknown, unknown> {
		const collector = readRenderTelemetryCollector(ctx);

		if (emitter !== undefined) {
			if (
				collector !== null &&
				emitter instanceof BoundedEmitter &&
				(emitter.kind === 'root' || emitter.kind === 'layout')
			) {
				return yield* renderTemplatesInstrumented(
					originalRenderTemplates,
					templates,
					ctx,
					emitter,
					collector,
				);
			}
			return yield* originalRenderTemplates(templates, ctx, emitter);
		}
		const keepOutputType = Boolean(
			(ctx as { opts?: { keepOutputType?: unknown } } | undefined)?.opts?.keepOutputType,
		);
		if (keepOutputType) {
			return yield* originalRenderTemplates(templates, ctx, undefined);
		}

		const budget = getOrCreateOutputBudget(ctx);
		if (!budget.hasRootEmitter) {
			budget.hasRootEmitter = true;
			const rootEmitter = new BoundedEmitter(budget, 'root');
			if (collector !== null) {
				return yield* renderTemplatesInstrumented(
					originalRenderTemplates,
					templates,
					ctx,
					rootEmitter,
					collector,
				);
			}
			return yield* originalRenderTemplates(templates, ctx, rootEmitter);
		}

		if (!budget.inLayoutStore && isLayoutStorePass(ctx)) {
			// Reset per-layout pass counter so chained layouts measure true per-layout body size,
			// while guarding `inLayoutStore` so nested `{% capture %}` tags inside the layout body
			// charge `captureChars`.
			budget.inLayoutStore = true;
			budget.layoutChars = 0;
			const layoutEmitter = new BoundedEmitter(budget, 'layout');
			try {
				if (collector !== null) {
					return yield* renderTemplatesInstrumented(
						originalRenderTemplates,
						templates,
						ctx,
						layoutEmitter,
						collector,
					);
				}
				return yield* originalRenderTemplates(templates, ctx, layoutEmitter);
			} finally {
				budget.inLayoutStore = false;
			}
		}

		const captureEmitter = new BoundedEmitter(budget, 'capture');
		return yield* originalRenderTemplates(templates, ctx, captureEmitter);
	};
}

/**
 * Checks the active LiquidJS `ctx.renderLimit` deadline against `readMonotonicNowMs()`,
 * throwing LiquidJS's native `"template render limit exceeded"` error if the render has
 * exceeded `TEMPLATE_RENDER_LIMIT_MS`. No-op when invoked outside a LiquidJS `Context`.
 */
export function checkFilterRenderLimit(filterThis: LiquidFilterThis | void): void {
	if (!filterThis || typeof filterThis !== 'object') {
		return;
	}
	const renderLimit = (
		filterThis.context as { renderLimit?: { check?: (now: number) => void } } | undefined
	)?.renderLimit;
	if (renderLimit && typeof renderLimit.check === 'function') {
		renderLimit.check(readMonotonicNowMs());
	}
}

/**
 * Throws an actionable `3.25 MiB` template output size error when `chars` exceeds
 * `MAX_TEMPLATE_OUTPUT_CHARS`.
 */
export function checkFilterOutputSize(chars: number): void {
	if (chars > MAX_TEMPLATE_OUTPUT_CHARS) {
		throw createTemplateOutputLimitError();
	}
}

/**
 * Estimates serialized YAML frontmatter character length for a plain staged `frontmatter` object
 * (including `---\n...\n---\n` delimiters when non-empty), throwing `createTemplateOutputLimitError()`
 * immediately if accumulated characters exceed `maxChars`.
 */
export function measureSerializedFrontmatterCharsBounded(
	value: unknown,
	maxChars: number = MAX_TEMPLATE_OUTPUT_CHARS,
): number {
	let total = 0;

	const addChars = (delta: number): void => {
		total += delta;
		if (total > maxChars) {
			throw createTemplateOutputLimitError();
		}
	};

	const walk = (node: unknown, depth: number): void => {
		if (node === null || node === undefined) {
			addChars(4);
			return;
		}
		if (typeof node === 'string') {
			addChars(node.length + 2);
			return;
		}
		if (typeof node === 'number' || typeof node === 'boolean') {
			addChars(String(node).length);
			return;
		}
		if (Array.isArray(node)) {
			if (node.length === 0) {
				addChars(2);
				return;
			}
			for (let i = 0; i < node.length; i++) {
				addChars(depth * 2 + 3);
				walk(node[i], depth + 1);
			}
			return;
		}
		if (typeof node === 'object') {
			const keys = Object.keys(node);
			if (keys.length === 0) {
				addChars(2);
				return;
			}
			if (depth === 0) {
				addChars(8); // leading & trailing ---\n
			}
			for (const key of keys) {
				addChars(depth * 2 + key.length + 3);
				walk((node as Record<string, unknown>)[key], depth + 1);
			}
		}
	};

	if (value && typeof value === 'object' && !Array.isArray(value)) {
		if (Object.keys(value).length === 0) {
			return 0;
		}
	}
	walk(value, 0);
	return total;
}
