import { deepFreeze } from '@core/cache/deep-freeze';
import {
	FORBIDDEN_KEYS,
	initEngineConfig,
	type NormalizedDocument,
	normalizeObsidianMetadata,
	type ObsidianFileInput,
	type ResolvedEngineConfig,
} from '@core/search';
import type { Context } from 'liquidjs';
import { isPlainRecord } from './selector-evaluator';
import { resolveInitialNewNoteTargetPath } from './target-path';
import { TemporalDrop, unwrapLiquidValue } from './temporal-drop';
import type {
	TargetPathClaimPort,
	TemplateRuntimeContext,
	TemplateTargetTabMode,
	TemplateTrigger,
} from './types';

/**
 * Unshadowable `Symbol` key storing the mutable per-block `TemplateTargetState` on `root`
 * (`ctx.globals`), preserved by reference across `{% render %}` (`ctx.spawn()`) and `{% layout %}`.
 */
export const TEMPLATE_TARGET_STATE_SYMBOL = Symbol.for('rhizome.templateTargetState');

const EMPTY_FROZEN_ARRAY: readonly never[] = Object.freeze([]);
const fallbackConfigByZone = new Map<string, ResolvedEngineConfig>();

function getFallbackEngineConfig(timeZone: string): ResolvedEngineConfig {
	let cached = fallbackConfigByZone.get(timeZone);
	if (cached !== undefined) {
		return cached;
	}
	const res = initEngineConfig({ timeZone, propertyTypes: {} });
	if (res.ok) {
		fallbackConfigByZone.set(timeZone, res.config);
		return res.config;
	}
	const utcRes = initEngineConfig({ timeZone: 'UTC', propertyTypes: {} });
	if (!utcRes.ok) {
		throw new Error('Failed to initialize fallback UTC engine config.');
	}
	fallbackConfigByZone.set(timeZone, utcRes.config);
	return utcRes.config;
}

/**
 * Recursively converts a Liquid runtime value into a YAML/JSON-safe value suitable for
 * `FileManager.processFrontMatter()`, unwrapping `TemporalDrop` via `.toString()`.
 */
export function serializeFrontmatterValue(val: unknown): unknown {
	const u = unwrapLiquidValue(val);
	if (u === null || u === undefined) {
		return null;
	}
	if (u instanceof TemporalDrop) {
		return u.toString();
	}
	if (u instanceof Date) {
		return Number.isNaN(u.getTime()) ? null : u.toISOString();
	}
	if (typeof u === 'string' || typeof u === 'boolean') {
		return u;
	}
	if (typeof u === 'number') {
		return Number.isFinite(u) ? (u === 0 ? 0 : u) : null;
	}
	if (Array.isArray(u)) {
		return (u as readonly unknown[]).map((item) => serializeFrontmatterValue(item));
	}
	if (isPlainRecord(u)) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(u)) {
			if (FORBIDDEN_KEYS.has(key)) continue;
			out[key] = serializeFrontmatterValue(u[key]);
		}
		return out;
	}
	if (typeof u === 'bigint') {
		return u.toString();
	}
	if (typeof u === 'symbol') {
		return u.description ?? '';
	}
	return null;
}

/**
 * Deeply clones and freezes a plain frontmatter record so Liquid templates reading
 * `{{ frontmatter }}` observe an immutable snapshot.
 */
export function cloneFrozenFrontmatterSnapshot(
	raw: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const cloned = serializeFrontmatterValue(raw) as Record<string, unknown>;
	return deepFreeze(cloned);
}

function buildVirtualObsidianFileInput(
	targetPath: string,
	referenceTimeMs: number,
): ObsidianFileInput {
	const slashIdx = targetPath.lastIndexOf('/');
	const parentPath = slashIdx === -1 ? '' : targetPath.slice(0, slashIdx);
	const name = slashIdx === -1 ? targetPath : targetPath.slice(slashIdx + 1);
	const dotIdx = name.lastIndexOf('.');
	const basename = dotIdx > 0 ? name.slice(0, dotIdx) : name;
	const extension = dotIdx > 0 ? name.slice(dotIdx + 1) : 'md';
	return {
		path: targetPath,
		name,
		basename,
		extension,
		parent: parentPath.length > 0 ? { path: parentPath } : null,
		stat: {
			ctime: referenceTimeMs,
			mtime: referenceTimeMs,
			size: 0,
		},
	};
}

/**
 * Builds a frozen virtual `NormalizedDocument` for an in-flight `"newNote"` block from its
 * current `targetPath`, serialized `frontmatterRaw`, pinned `referenceTimeMs`, and `resolvedConfig`.
 */
export function buildVirtualNormalizedDocument(
	targetPath: string,
	frontmatterRaw: Readonly<Record<string, unknown>>,
	referenceTimeMs: number,
	resolvedConfig: ResolvedEngineConfig,
): NormalizedDocument {
	const fileInput = buildVirtualObsidianFileInput(targetPath, referenceTimeMs);
	const doc = normalizeObsidianMetadata(
		fileInput,
		{ frontmatter: frontmatterRaw },
		resolvedConfig,
	);
	doc.backlinks = EMPTY_FROZEN_ARRAY;
	return deepFreeze(doc);
}

/**
 * Projects the 14 user-facing `VaultQueryMatch` fields onto a frozen `this` object.
 */
export function projectHostObjectFromDocument(
	doc: NormalizedDocument,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		file: doc.file,
		aliases: doc.aliases,
		aliasLocations: doc.aliasLocations,
		tags: doc.tags,
		tagLocations: doc.tagLocations,
		cssclasses: doc.cssclasses,
		headings: doc.headings,
		links: doc.links,
		embeds: doc.embeds,
		blocks: doc.blocks,
		tasks: doc.tasks,
		properties: doc.properties,
		propertyLocations: doc.propertyLocations,
		backlinks: doc.backlinks ?? EMPTY_FROZEN_ARRAY,
	});
}

/**
 * Per-block mutable state holder attached behind `TEMPLATE_TARGET_STATE_SYMBOL` on `ctx.globals`.
 */
export interface TemplateTargetState {
	readonly trigger: TemplateTrigger;
	readonly blockIndex: number;
	readonly referenceTimeMs: number;
	readonly timeZone: string;
	readonly configDir: string | null;
	readonly resolvedConfig: ResolvedEngineConfig;
	readonly claimRegistry: TargetPathClaimPort | undefined;
	readonly rootRecord: Record<string, unknown>;
	targetPath: string;
	tabMode: TemplateTargetTabMode;
	frontmatterRaw: Record<string, unknown>;
	frontmatterSnapshot: Readonly<Record<string, unknown>>;
	hasFrontmatterMutations: boolean;
	virtualDoc: NormalizedDocument | null;
}

/**
 * Initializes `TemplateTargetState` for a Pass 2 template render and binds it onto `rootRecord`
 * under `TEMPLATE_TARGET_STATE_SYMBOL`.
 */
export function attachTemplateTargetState(
	rootRecord: Record<string, unknown>,
	referenceTimeMs: number,
	timeZone: string,
	runtimeContext?: TemplateRuntimeContext,
): TemplateTargetState {
	const trigger: TemplateTrigger = runtimeContext?.trigger ?? 'dynamicCodeblock';
	const blockIndex = runtimeContext?.blockIndex ?? 0;
	const configDir = runtimeContext?.configDir ?? null;
	const resolvedConfig = runtimeContext?.resolvedConfig ?? getFallbackEngineConfig(timeZone);
	const claimRegistry = runtimeContext?.claimRegistry;

	let initialPath: string;
	if (trigger === 'newNote') {
		if (
			typeof runtimeContext?.initialTargetPath === 'string' &&
			runtimeContext.initialTargetPath.trim().length > 0
		) {
			initialPath = runtimeContext.initialTargetPath;
		} else {
			const defaultFolder = runtimeContext?.template?.folders.default ?? '';
			initialPath = resolveInitialNewNoteTargetPath(
				defaultFolder,
				blockIndex,
				claimRegistry,
				configDir,
			);
		}
	} else {
		initialPath =
			typeof runtimeContext?.sourcePath === 'string' ? runtimeContext.sourcePath : '';
	}

	const frontmatterRaw: Record<string, unknown> = {};
	const frontmatterSnapshot = Object.freeze({});
	const virtualDoc =
		trigger === 'newNote'
			? buildVirtualNormalizedDocument(
					initialPath,
					frontmatterRaw,
					referenceTimeMs,
					resolvedConfig,
				)
			: null;

	const state: TemplateTargetState = {
		trigger,
		blockIndex,
		referenceTimeMs,
		timeZone,
		configDir,
		resolvedConfig,
		claimRegistry,
		rootRecord,
		targetPath: initialPath,
		tabMode: 'background',
		frontmatterRaw,
		frontmatterSnapshot,
		hasFrontmatterMutations: false,
		virtualDoc,
	};

	rootRecord['◊'] = Object.freeze({ trigger });
	rootRecord['template'] = runtimeContext?.template ?? null;
	rootRecord['targetPath'] = initialPath;
	rootRecord['frontmatter'] = frontmatterSnapshot;
	if (virtualDoc !== null) {
		rootRecord['this'] = projectHostObjectFromDocument(virtualDoc);
	}

	Object.defineProperty(rootRecord, TEMPLATE_TARGET_STATE_SYMBOL, {
		value: state,
		enumerable: false,
		configurable: false,
		writable: false,
	});

	return state;
}

function isTemplateTargetState(val: unknown): val is TemplateTargetState {
	return Boolean(
		val &&
		typeof val === 'object' &&
		'trigger' in val &&
		'rootRecord' in val &&
		'frontmatterRaw' in val,
	);
}

/**
 * Reads the unshadowable `TemplateTargetState` from a LiquidJS `Context` or root scope object.
 */
export function readTemplateTargetState(
	ctxOrRoot: Context | Record<PropertyKey, unknown> | undefined,
): TemplateTargetState | null {
	if (!ctxOrRoot || typeof ctxOrRoot !== 'object') {
		return null;
	}
	if (TEMPLATE_TARGET_STATE_SYMBOL in ctxOrRoot) {
		const direct: unknown = Reflect.get(ctxOrRoot, TEMPLATE_TARGET_STATE_SYMBOL);
		return isTemplateTargetState(direct) ? direct : null;
	}
	const ctxInternal = ctxOrRoot as unknown as {
		globals?: Record<PropertyKey, unknown>;
		environments?: Record<PropertyKey, unknown>;
	};
	const fromGlobals = ctxInternal.globals?.[TEMPLATE_TARGET_STATE_SYMBOL];
	if (isTemplateTargetState(fromGlobals)) {
		return fromGlobals;
	}
	const fromEnvs = ctxInternal.environments?.[TEMPLATE_TARGET_STATE_SYMBOL];
	if (isTemplateTargetState(fromEnvs)) {
		return fromEnvs;
	}
	return null;
}

/**
 * Applies a validated `{% targetPath %}` update to `state`: updates `targetPath` and `tabMode`,
 * and in `"newNote"` mode claims the collision-resolved path and rebuilds virtual `this`.
 */
export function applyTargetPathMutation(
	state: TemplateTargetState,
	validatedPath: string,
	tabMode: TemplateTargetTabMode,
): string {
	const resolvedPath =
		state.trigger === 'newNote' && state.claimRegistry
			? state.claimRegistry.claim(state.blockIndex, validatedPath)
			: validatedPath;

	state.targetPath = resolvedPath;
	state.tabMode = tabMode;
	state.rootRecord['targetPath'] = resolvedPath;

	if (state.trigger === 'newNote') {
		const nextDoc = buildVirtualNormalizedDocument(
			resolvedPath,
			state.frontmatterRaw,
			state.referenceTimeMs,
			state.resolvedConfig,
		);
		state.virtualDoc = nextDoc;
		state.rootRecord['this'] = projectHostObjectFromDocument(nextDoc);
	}

	return resolvedPath;
}

/**
 * Applies a `{% frontmatter %}` mutation to `state`: replaces `frontmatterRaw` and frozen
 * `frontmatterSnapshot`, and in `"newNote"` mode re-normalizes virtual `this`.
 */
export function applyFrontmatterMutation(
	state: TemplateTargetState,
	nextFrontmatterRaw: Record<string, unknown>,
): void {
	const snapshot = cloneFrozenFrontmatterSnapshot(nextFrontmatterRaw);
	state.frontmatterRaw = nextFrontmatterRaw;
	state.frontmatterSnapshot = snapshot;
	state.hasFrontmatterMutations = true;
	state.rootRecord['frontmatter'] = snapshot;

	if (state.trigger === 'newNote') {
		const nextDoc = buildVirtualNormalizedDocument(
			state.targetPath,
			snapshot,
			state.referenceTimeMs,
			state.resolvedConfig,
		);
		state.virtualDoc = nextDoc;
		state.rootRecord['this'] = projectHostObjectFromDocument(nextDoc);
	}
}
