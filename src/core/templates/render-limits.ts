import { type Context, type Emitter, type Liquid, type Template, toValue } from 'liquidjs';
import type { LiquidFilterThis } from './selector-evaluator';

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
	private readonly budget: RenderOutputBudget;
	private readonly kind: EmitterBucketKind;

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

/**
 * Wraps `liquid.renderer.renderTemplates` idempotently so every render invocation without an
 * explicit emitter writes through a bucketed `BoundedEmitter` keyed on `ctx.renderLimit`,
 * tracking `root`, `{% layout %}`, and `{% capture %}` character budgets separately so each
 * enforces the true `3.25 MiB` (`MAX_TEMPLATE_OUTPUT_CHARS`) limit without double-charging
 * layout or captured strings when they are later emitted to root.
 *
 * @remarks
 * (design, 2026-11-20) LiquidJS `10.30.1`'s built-in `SimpleEmitter` concatenates output into
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
		if (emitter !== undefined) {
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
