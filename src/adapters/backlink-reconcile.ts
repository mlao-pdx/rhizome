import type { App, TFile } from 'obsidian';

export type BacklinkSnapshot = ReadonlyMap<TFile, ReadonlyMap<TFile, number>>;

export function isMarkdownPath(path: string): boolean {
	return path.toLowerCase().endsWith('.md');
}

/**
 * Centralizes the undocumented runtime `deleted` flag on `TFile`.
 */
export function isLiveTFile(file: TFile): boolean {
	return (file as { deleted?: boolean }).deleted !== true;
}

export interface BacklinkAppliedState {
	readonly liveByPath: Map<string, TFile>;
	readonly pathByFile: Map<TFile, string>;
	readonly markdownTargets: Set<TFile>;
	readonly ignoredFiles: Map<TFile, string>;
	readonly ignoredPathSet: Set<string>;
	readonly outEdgesByFile: Map<TFile, ReadonlyMap<TFile, number>>;
	readonly trackedSources: Set<TFile>;
}

export function createEmptyBacklinkState(): BacklinkAppliedState {
	return {
		liveByPath: new Map(),
		pathByFile: new Map(),
		markdownTargets: new Set(),
		ignoredFiles: new Map(),
		ignoredPathSet: new Set(),
		outEdgesByFile: new Map(),
		trackedSources: new Set(),
	};
}

export function clearBacklinkState(state: BacklinkAppliedState): void {
	state.liveByPath.clear();
	state.pathByFile.clear();
	state.markdownTargets.clear();
	state.ignoredFiles.clear();
	state.ignoredPathSet.clear();
	state.outEdgesByFile.clear();
	state.trackedSources.clear();
}

function rawHasAnyFiniteEntry(raw: unknown): boolean {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return false;
	}
	const rec = raw as Record<string, unknown>;
	for (const target in rec) {
		if (!Object.prototype.hasOwnProperty.call(rec, target)) continue;
		const count = rec[target];
		if (typeof count === 'number' && Number.isFinite(count)) {
			return true;
		}
	}
	return false;
}

/**
 * Zero-allocation check comparing a raw `resolvedLinks[sourcePath]` record against a
 * `TFile -> count` edge map using `liveByPath` and `markdownTargets`.
 */
function rawDestMatchesTargetEdges(
	raw: unknown,
	appliedEdges: ReadonlyMap<TFile, number> | undefined,
	liveByPath: ReadonlyMap<string, TFile>,
	markdownTargets: ReadonlySet<TFile>,
): { readonly matches: boolean; readonly hasAnyFinite: boolean } {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return {
			matches: appliedEdges === undefined || appliedEdges.size === 0,
			hasAnyFinite: false,
		};
	}
	const rec = raw as Record<string, unknown>;
	let matchedEdges = 0;
	let hasAnyFinite = false;
	let matches = true;

	for (const targetPath in rec) {
		if (!Object.prototype.hasOwnProperty.call(rec, targetPath)) {
			continue;
		}
		const count = rec[targetPath];
		if (typeof count !== 'number' || !Number.isFinite(count)) {
			continue;
		}
		hasAnyFinite = true;
		if (!matches) {
			continue;
		}
		const targetFile = liveByPath.get(targetPath);
		if (targetFile === undefined || !markdownTargets.has(targetFile)) {
			continue;
		}
		matchedEdges++;
		if (appliedEdges === undefined || appliedEdges.get(targetFile) !== count) {
			matches = false;
		}
	}

	if (matches && matchedEdges !== (appliedEdges?.size ?? 0)) {
		matches = false;
	}
	return { matches, hasAnyFinite };
}

function extractTargetEdges(
	raw: unknown,
	liveByPath: ReadonlyMap<string, TFile>,
	markdownTargets: ReadonlySet<TFile>,
): { readonly edges: Map<TFile, number> | undefined; readonly hasAnyFinite: boolean } {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { edges: undefined, hasAnyFinite: false };
	}
	const rec = raw as Record<string, unknown>;
	let edges: Map<TFile, number> | undefined;
	let hasAnyFinite = false;

	for (const targetPath in rec) {
		if (!Object.prototype.hasOwnProperty.call(rec, targetPath)) {
			continue;
		}
		const count = rec[targetPath];
		if (typeof count !== 'number' || !Number.isFinite(count)) {
			continue;
		}
		hasAnyFinite = true;
		const targetFile = liveByPath.get(targetPath);
		if (targetFile !== undefined && markdownTargets.has(targetFile)) {
			edges ??= new Map<TFile, number>();
			edges.set(targetFile, count);
		}
	}
	return { edges, hasAnyFinite };
}

export function hasBacklinkSource(state: BacklinkAppliedState, sourcePath: string): boolean {
	const file = state.liveByPath.get(sourcePath);
	return file !== undefined && state.trackedSources.has(file);
}

export function hasBacklinkSourceChanged(
	app: App,
	state: BacklinkAppliedState,
	resolvedLinks: Readonly<Record<string, Record<string, number>>>,
	sourcePath: string,
): boolean {
	const raw = resolvedLinks[sourcePath];
	const sourceFile = state.liveByPath.get(sourcePath);
	if (sourceFile === undefined || sourceFile.path !== sourcePath || !isLiveTFile(sourceFile)) {
		return rawHasAnyFiniteEntry(raw);
	}

	const appliedEdges = state.outEdgesByFile.get(sourceFile);
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return appliedEdges !== undefined && appliedEdges.size > 0;
	}

	const rec = raw as Record<string, unknown>;
	const vaultWithLookup = app.vault as { getFileByPath?: (p: string) => TFile | null };
	let matchedEdges = 0;

	for (const targetPath in rec) {
		if (!Object.prototype.hasOwnProperty.call(rec, targetPath)) {
			continue;
		}
		const count = rec[targetPath];
		if (typeof count !== 'number' || !Number.isFinite(count)) {
			continue;
		}
		const targetFile = state.liveByPath.get(targetPath);
		if (targetFile === undefined) {
			if (isMarkdownPath(targetPath) && !state.ignoredPathSet.has(targetPath)) {
				const liveCandidate = vaultWithLookup.getFileByPath?.(targetPath);
				if (liveCandidate && isLiveTFile(liveCandidate)) {
					return true;
				}
			}
			continue;
		}
		if (targetFile.path !== targetPath || !isLiveTFile(targetFile)) {
			return true;
		}
		if (!state.markdownTargets.has(targetFile)) {
			continue;
		}
		matchedEdges++;
		if (appliedEdges === undefined || appliedEdges.get(targetFile) !== count) {
			return true;
		}
	}

	return matchedEdges !== (appliedEdges?.size ?? 0);
}

export function isBacklinkGraphUnchanged(
	files: readonly TFile[],
	resolvedLinks: Readonly<Record<string, Record<string, number>>>,
	isIgnored: (file: TFile) => boolean,
	state: BacklinkAppliedState,
): boolean {
	let liveCount = 0;
	let markdownTargetCount = 0;
	let ignoredCount = 0;

	for (let i = 0; i < files.length; i++) {
		const file = files[i]!;
		if (!isLiveTFile(file)) {
			continue;
		}
		const path = file.path;
		if (isMarkdownPath(path)) {
			if (isIgnored(file)) {
				if (state.ignoredFiles.get(file) !== path) {
					return false;
				}
				ignoredCount++;
				continue;
			}
			if (!state.markdownTargets.has(file)) {
				return false;
			}
			markdownTargetCount++;
		}
		if (state.liveByPath.get(path) !== file) {
			return false;
		}
		liveCount++;
	}

	if (
		liveCount !== state.liveByPath.size ||
		markdownTargetCount !== state.markdownTargets.size ||
		ignoredCount !== state.ignoredFiles.size
	) {
		return false;
	}

	let matchedSourcesWithEdges = 0;
	let matchedTrackedSources = 0;
	for (const sourcePath in resolvedLinks) {
		if (!Object.prototype.hasOwnProperty.call(resolvedLinks, sourcePath)) {
			continue;
		}
		const sourceFile = state.liveByPath.get(sourcePath);
		if (sourceFile === undefined) {
			continue;
		}
		const appliedEdges = state.outEdgesByFile.get(sourceFile);
		const check = rawDestMatchesTargetEdges(
			resolvedLinks[sourcePath],
			appliedEdges,
			state.liveByPath,
			state.markdownTargets,
		);
		if (!check.matches) {
			return false;
		}
		if (check.hasAnyFinite !== state.trackedSources.has(sourceFile)) {
			return false;
		}
		if (check.hasAnyFinite) {
			matchedTrackedSources++;
		}
		if (appliedEdges !== undefined) {
			matchedSourcesWithEdges++;
		}
	}

	return (
		matchedSourcesWithEdges === state.outEdgesByFile.size &&
		matchedTrackedSources === state.trackedSources.size
	);
}

function collectLiveVaultState(
	files: readonly TFile[],
	isIgnored: (file: TFile) => boolean,
	prevPathByFile?: ReadonlyMap<TFile, string>,
): {
	readonly state: BacklinkAppliedState;
	readonly anyPathRenamed: boolean;
} {
	const state = createEmptyBacklinkState();
	let anyPathRenamed = false;

	for (let i = 0; i < files.length; i++) {
		const file = files[i]!;
		if (!isLiveTFile(file)) {
			continue;
		}
		const path = file.path;
		if (isMarkdownPath(path)) {
			if (isIgnored(file)) {
				state.ignoredFiles.set(file, path);
				state.ignoredPathSet.add(path);
				continue;
			}
			state.markdownTargets.add(file);
		}
		state.liveByPath.set(path, file);
		state.pathByFile.set(file, path);
		if (!anyPathRenamed && prevPathByFile !== undefined) {
			const prevPath = prevPathByFile.get(file);
			if (prevPath !== undefined && prevPath !== path) {
				anyPathRenamed = true;
			}
		}
	}

	return { state, anyPathRenamed };
}

export function buildInitialBacklinkSnapshot(
	files: readonly TFile[],
	resolvedLinks: Readonly<Record<string, Record<string, number>>>,
	isIgnored: (file: TFile) => boolean,
): {
	readonly snapshot: Map<TFile, Map<TFile, number>>;
	readonly state: BacklinkAppliedState;
} {
	const { state } = collectLiveVaultState(files, isIgnored);
	const snapshot = new Map<TFile, Map<TFile, number>>();

	for (const sourcePath in resolvedLinks) {
		if (!Object.prototype.hasOwnProperty.call(resolvedLinks, sourcePath)) {
			continue;
		}
		const sourceFile = state.liveByPath.get(sourcePath);
		if (sourceFile === undefined) {
			continue;
		}
		const { edges, hasAnyFinite } = extractTargetEdges(
			resolvedLinks[sourcePath],
			state.liveByPath,
			state.markdownTargets,
		);
		if (hasAnyFinite) {
			state.trackedSources.add(sourceFile);
		}
		if (edges !== undefined && edges.size > 0) {
			state.outEdgesByFile.set(sourceFile, edges);
			for (const [targetFile, count] of edges) {
				let targetSources = snapshot.get(targetFile);
				if (targetSources === undefined) {
					targetSources = new Map<TFile, number>();
					snapshot.set(targetFile, targetSources);
				}
				targetSources.set(sourceFile, count);
			}
		}
	}

	return { snapshot, state };
}

export interface ReconcileBacklinkOutcome {
	readonly snapshot: BacklinkSnapshot;
	readonly state: BacklinkAppliedState;
	readonly structuralChanged: boolean;
	readonly projectionChanged: boolean;
	readonly changedSourceCount: number;
	readonly affectedTargetCount: number;
}

export function reconcileBacklinkSnapshot(
	current: BacklinkSnapshot,
	prevState: BacklinkAppliedState,
	files: readonly TFile[],
	resolvedLinks: Readonly<Record<string, Record<string, number>>>,
	isIgnored: (file: TFile) => boolean,
): ReconcileBacklinkOutcome {
	const { state: nextState, anyPathRenamed } = collectLiveVaultState(
		files,
		isIgnored,
		prevState.pathByFile,
	);

	const changedSources: Array<{
		readonly source: TFile;
		readonly prevEdges: ReadonlyMap<TFile, number> | undefined;
		readonly nextEdges: ReadonlyMap<TFile, number> | undefined;
	}> = [];
	const recordedSources = new Set<TFile>();
	const affectedTargets = new Set<TFile>();

	for (const sourcePath in resolvedLinks) {
		if (!Object.prototype.hasOwnProperty.call(resolvedLinks, sourcePath)) {
			continue;
		}
		const sourceFile = nextState.liveByPath.get(sourcePath);
		if (sourceFile === undefined) {
			continue;
		}
		const prevEdges = prevState.outEdgesByFile.get(sourceFile);
		const raw = resolvedLinks[sourcePath];
		const check = rawDestMatchesTargetEdges(
			raw,
			prevEdges,
			nextState.liveByPath,
			nextState.markdownTargets,
		);
		if (check.hasAnyFinite) {
			nextState.trackedSources.add(sourceFile);
		}
		if (check.matches) {
			if (prevEdges !== undefined) {
				nextState.outEdgesByFile.set(sourceFile, prevEdges);
			}
			continue;
		}

		const { edges: nextEdges } = extractTargetEdges(
			raw,
			nextState.liveByPath,
			nextState.markdownTargets,
		);
		if (nextEdges !== undefined && nextEdges.size > 0) {
			nextState.outEdgesByFile.set(sourceFile, nextEdges);
		}
		changedSources.push({ source: sourceFile, prevEdges, nextEdges });
		recordedSources.add(sourceFile);
		if (prevEdges !== undefined) {
			for (const oldTarget of prevEdges.keys()) {
				affectedTargets.add(oldTarget);
			}
		}
		if (nextEdges !== undefined) {
			for (const newTarget of nextEdges.keys()) {
				affectedTargets.add(newTarget);
			}
		}
	}

	for (const [oldSource, prevEdges] of prevState.outEdgesByFile) {
		if (!nextState.outEdgesByFile.has(oldSource) && !recordedSources.has(oldSource)) {
			changedSources.push({ source: oldSource, prevEdges, nextEdges: undefined });
			recordedSources.add(oldSource);
			for (const oldTarget of prevEdges.keys()) {
				affectedTargets.add(oldTarget);
			}
		}
	}

	const evictedTargets: TFile[] = [];
	for (const existingTarget of current.keys()) {
		if (!nextState.markdownTargets.has(existingTarget)) {
			evictedTargets.push(existingTarget);
			affectedTargets.add(existingTarget);
		}
	}

	if (changedSources.length === 0 && evictedTargets.length === 0) {
		return {
			snapshot: current,
			state: nextState,
			structuralChanged: false,
			projectionChanged: anyPathRenamed,
			changedSourceCount: 0,
			affectedTargetCount: 0,
		};
	}

	const nextSnapshot = new Map<TFile, ReadonlyMap<TFile, number>>(current);
	for (let i = 0; i < evictedTargets.length; i++) {
		nextSnapshot.delete(evictedTargets[i]!);
	}

	const mutableTargets = new Map<TFile, Map<TFile, number>>();
	const getMutableTarget = (target: TFile): Map<TFile, number> => {
		let mutable = mutableTargets.get(target);
		if (mutable === undefined) {
			mutable = new Map<TFile, number>(nextSnapshot.get(target));
			mutableTargets.set(target, mutable);
		}
		return mutable;
	};

	for (let i = 0; i < changedSources.length; i++) {
		const { source, prevEdges, nextEdges } = changedSources[i]!;
		if (prevEdges !== undefined) {
			for (const oldTarget of prevEdges.keys()) {
				if (
					nextEdges?.get(oldTarget) === undefined &&
					nextState.markdownTargets.has(oldTarget)
				) {
					getMutableTarget(oldTarget).delete(source);
				}
			}
		}
		if (nextEdges !== undefined) {
			for (const [newTarget, newCount] of nextEdges) {
				if (prevEdges?.get(newTarget) !== newCount) {
					getMutableTarget(newTarget).set(source, newCount);
				}
			}
		}
	}

	for (const [target, mutableMap] of mutableTargets) {
		if (mutableMap.size === 0) {
			nextSnapshot.delete(target);
		} else {
			nextSnapshot.set(target, mutableMap);
		}
	}

	return {
		snapshot: nextSnapshot,
		state: nextState,
		structuralChanged: true,
		projectionChanged: true,
		changedSourceCount: changedSources.length,
		affectedTargetCount: affectedTargets.size,
	};
}
