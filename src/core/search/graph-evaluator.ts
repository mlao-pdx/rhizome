import {
	coerceHostScalarForProperty,
	resolveThisReference,
	type ResolvedHostScalar,
} from './host-reference';
import type {
	BacklinkRef,
	GraphDirection,
	GraphScopeName,
	HopBounds,
	NormalizedDocument,
	ObsidianPropertyType,
} from './types';

export interface DirectedAdjacency {
	readonly forward: ReadonlyArray<readonly number[]>;
	readonly reverse: ReadonlyArray<readonly number[]>;
}

export type BacklinkSourcePathsResolver =
	| ReadonlyMap<string, readonly string[]>
	| ((targetPath: string) => readonly string[] | undefined);

/**
 * Pass-scoped directed graph index built over normalized vault documents.
 * Lazily constructs and memoizes whole-note `links`, `embeds`, `backlinks`, and
 * per-property `NormalizedLink.property` adjacency lists on demand.
 */
export class VaultGraphSnapshot {
	public readonly docsByIndex: readonly NormalizedDocument[];
	public readonly docIndexByPath: ReadonlyMap<string, number>;
	private readonly backlinkResolver: BacklinkSourcePathsResolver | undefined;
	private linksAdj: DirectedAdjacency | undefined;
	private embedsAdj: DirectedAdjacency | undefined;
	private backlinksAdj: DirectedAdjacency | undefined;
	private readonly propertyAdjCache = new Map<string, DirectedAdjacency>();

	public constructor(
		docs: readonly NormalizedDocument[],
		backlinkResolver?: BacklinkSourcePathsResolver,
	) {
		this.docsByIndex = docs;
		this.backlinkResolver = backlinkResolver;
		const indexByPath = new Map<string, number>();
		for (let i = 0; i < docs.length; i++) {
			indexByPath.set(docs[i]!.file.path, i);
		}
		this.docIndexByPath = indexByPath;
	}

	private getOrBuildLinksAdj(): DirectedAdjacency {
		if (this.linksAdj !== undefined) {
			return this.linksAdj;
		}
		const docs = this.docsByIndex;
		const vCount = docs.length;
		const fwdSets = Array.from({ length: vCount }, () => new Set<number>());
		const revSets = Array.from({ length: vCount }, () => new Set<number>());

		for (let u = 0; u < vCount; u++) {
			const links = docs[u]!.links;
			for (let i = 0; i < links.length; i++) {
				const resolved = links[i]!.resolvedPath;
				if (resolved === null) continue;
				const v = this.docIndexByPath.get(resolved);
				if (v !== undefined) {
					fwdSets[u]!.add(v);
					revSets[v]!.add(u);
				}
			}
		}

		this.linksAdj = {
			forward: fwdSets.map((s) => Array.from(s)),
			reverse: revSets.map((s) => Array.from(s)),
		};
		return this.linksAdj;
	}

	private getOrBuildEmbedsAdj(): DirectedAdjacency {
		if (this.embedsAdj !== undefined) {
			return this.embedsAdj;
		}
		const docs = this.docsByIndex;
		const vCount = docs.length;
		const fwdSets = Array.from({ length: vCount }, () => new Set<number>());
		const revSets = Array.from({ length: vCount }, () => new Set<number>());

		for (let u = 0; u < vCount; u++) {
			const embeds = docs[u]!.embeds;
			for (let i = 0; i < embeds.length; i++) {
				const resolved = embeds[i]!.resolvedPath;
				if (resolved === null) continue;
				const v = this.docIndexByPath.get(resolved);
				if (v !== undefined) {
					fwdSets[u]!.add(v);
					revSets[v]!.add(u);
				}
			}
		}

		this.embedsAdj = {
			forward: fwdSets.map((s) => Array.from(s)),
			reverse: revSets.map((s) => Array.from(s)),
		};
		return this.embedsAdj;
	}

	private getOrBuildBacklinksAdj(): DirectedAdjacency {
		if (this.backlinksAdj !== undefined) {
			return this.backlinksAdj;
		}
		const docs = this.docsByIndex;
		const vCount = docs.length;
		const fwdSets = Array.from({ length: vCount }, () => new Set<number>());
		const revSets = Array.from({ length: vCount }, () => new Set<number>());
		const resolver = this.backlinkResolver;

		for (let u = 0; u < vCount; u++) {
			const doc = docs[u]!;
			const explicitPaths =
				typeof resolver === 'function'
					? resolver(doc.file.path)
					: resolver?.get(doc.file.path);
			if (explicitPaths !== undefined) {
				for (let i = 0; i < explicitPaths.length; i++) {
					const v = this.docIndexByPath.get(explicitPaths[i]!);
					if (v !== undefined) {
						fwdSets[u]!.add(v);
						revSets[v]!.add(u);
					}
				}
			} else if (doc.backlinks !== undefined) {
				for (let i = 0; i < doc.backlinks.length; i++) {
					const v = this.docIndexByPath.get(doc.backlinks[i]!.path);
					if (v !== undefined) {
						fwdSets[u]!.add(v);
						revSets[v]!.add(u);
					}
				}
			} else {
				const linksRev = this.getOrBuildLinksAdj().reverse[u]!;
				for (let i = 0; i < linksRev.length; i++) {
					const v = linksRev[i]!;
					fwdSets[u]!.add(v);
					revSets[v]!.add(u);
				}
				const embedsRev = this.getOrBuildEmbedsAdj().reverse[u]!;
				for (let i = 0; i < embedsRev.length; i++) {
					const v = embedsRev[i]!;
					fwdSets[u]!.add(v);
					revSets[v]!.add(u);
				}
			}
		}

		this.backlinksAdj = {
			forward: fwdSets.map((s) => Array.from(s)),
			reverse: revSets.map((s) => Array.from(s)),
		};
		return this.backlinksAdj;
	}

	public getScopeAdjacency(scope: GraphScopeName, direction: GraphDirection): DirectedAdjacency {
		const base =
			scope === 'links'
				? this.getOrBuildLinksAdj()
				: scope === 'embeds'
					? this.getOrBuildEmbedsAdj()
					: this.getOrBuildBacklinksAdj();
		return direction === 'outgoing' ? base : { forward: base.reverse, reverse: base.forward };
	}

	public getPropertyAdjacency(lowerKey: string, direction: GraphDirection): DirectedAdjacency {
		let base = this.propertyAdjCache.get(lowerKey);
		if (base === undefined) {
			const vCount = this.docsByIndex.length;
			const fwdSets = Array.from({ length: vCount }, () => new Set<number>());
			const revSets = Array.from({ length: vCount }, () => new Set<number>());
			for (let u = 0; u < vCount; u++) {
				const links = this.docsByIndex[u]!.links;
				for (let i = 0; i < links.length; i++) {
					const link = links[i]!;
					if (
						link.property !== null &&
						link.resolvedPath !== null &&
						link.property.toLowerCase() === lowerKey
					) {
						const v = this.docIndexByPath.get(link.resolvedPath);
						if (v !== undefined) {
							fwdSets[u]!.add(v);
							revSets[v]!.add(u);
						}
					}
				}
			}
			base = {
				forward: fwdSets.map((s) => Array.from(s)),
				reverse: revSets.map((s) => Array.from(s)),
			};
			this.propertyAdjCache.set(lowerKey, base);
		}
		return direction === 'outgoing' ? base : { forward: base.reverse, reverse: base.forward };
	}
}

const MAX_RESIDUAL_DFS_STEPS = 65_536;

/**
 * Computes the set of vault paths `u` that have a cycle-free simple path of length
 * `k` (`hops.minHops <= k <= hops.maxHops`) to at least one target in `targetIndices`.
 *
 * Uses a 2-origin multi-source reverse BFS (`O(V + E)`) that is exact for `minHops <= 1`
 * and serves as a shortest-distance prefilter + branch bound for `minHops >= 2`.
 */
export function computeReachablePaths(
	graph: VaultGraphSnapshot,
	adjacency: DirectedAdjacency,
	hops: HopBounds,
	targetIndices: readonly number[],
): ReadonlySet<string> {
	const vCount = graph.docsByIndex.length;
	if (vCount === 0 || targetIndices.length === 0) {
		return new Set<string>();
	}

	const isTarget = new Uint8Array(vCount);
	const targets: number[] = [];
	for (let i = 0; i < targetIndices.length; i++) {
		const idx = targetIndices[i]!;
		if (idx >= 0 && idx < vCount && isTarget[idx] === 0) {
			isTarget[idx] = 1;
			targets.push(idx);
		}
	}
	if (targets.length === 0) {
		return new Set<string>();
	}

	const origin1 = new Int32Array(vCount).fill(-1);
	const dist1 = new Int32Array(vCount).fill(-1);
	const origin2 = new Int32Array(vCount).fill(-1);
	const dist2 = new Int32Array(vCount).fill(-1);

	const cap = Math.max(2, vCount * 2);
	const qNode = new Int32Array(cap);
	const qOrig = new Int32Array(cap);
	const qDist = new Int32Array(cap);
	let head = 0;
	let tail = 0;

	for (let i = 0; i < targets.length; i++) {
		const t = targets[i]!;
		origin1[t] = t;
		dist1[t] = 0;
		qNode[tail] = t;
		qOrig[tail] = t;
		qDist[tail] = 0;
		tail++;
	}

	const reverseAdj = adjacency.reverse;
	while (head < tail) {
		const curr = qNode[head]!;
		const orig = qOrig[head]!;
		const dist = qDist[head]!;
		head++;

		if (dist >= hops.maxHops) {
			continue;
		}
		const nextDist = dist + 1;
		const preds = reverseAdj[curr]!;
		for (let i = 0; i < preds.length; i++) {
			const prev = preds[i]!;
			if (prev === orig) {
				continue;
			}
			if (origin1[prev] === -1) {
				origin1[prev] = orig;
				dist1[prev] = nextDist;
				qNode[tail] = prev;
				qOrig[tail] = orig;
				qDist[tail] = nextDist;
				tail++;
			} else if (origin1[prev] !== orig && origin2[prev] === -1) {
				origin2[prev] = orig;
				dist2[prev] = nextDist;
				qNode[tail] = prev;
				qOrig[tail] = orig;
				qDist[tail] = nextDist;
				tail++;
			}
		}
	}

	const matchedPaths = new Set<string>();

	if (hops.minHops <= 1) {
		for (let u = 0; u < vCount; u++) {
			const hit =
				isTarget[u] === 1 ? hops.minHops === 0 || origin2[u] !== -1 : origin1[u] !== -1;
			if (hit) {
				matchedPaths.add(graph.docsByIndex[u]!.file.path);
			}
		}
		return matchedPaths;
	}

	const forwardAdj = adjacency.forward;
	const onPath = new Uint8Array(vCount);

	const hasResidualSimplePath = (start: number): boolean => {
		let steps = 0;
		const dfs = (curr: number, depth: number): boolean => {
			if (++steps > MAX_RESIDUAL_DFS_STEPS) {
				return false;
			}
			const rem = hops.maxHops - depth;
			const o1 = origin1[curr]!;
			if (o1 === -1) {
				return false;
			}
			if (o1 !== start) {
				if (dist1[curr]! > rem) return false;
			} else {
				const o2 = origin2[curr]!;
				if (o2 === -1 || dist2[curr]! > rem) return false;
			}

			const nexts = forwardAdj[curr]!;
			const nextDepth = depth + 1;
			for (let i = 0; i < nexts.length; i++) {
				const next = nexts[i]!;
				if (onPath[next] === 1) continue;
				if (nextDepth >= hops.minHops && isTarget[next] === 1) {
					return true;
				}
				if (nextDepth < hops.maxHops) {
					onPath[next] = 1;
					const found = dfs(next, nextDepth);
					onPath[next] = 0;
					if (found) return true;
				}
			}
			return false;
		};

		onPath[start] = 1;
		const ok = dfs(start, 0);
		onPath[start] = 0;
		return ok;
	};

	for (let u = 0; u < vCount; u++) {
		const shortestNonSelf = isTarget[u] === 1 ? dist2[u]! : dist1[u]!;
		if (shortestNonSelf === -1) {
			continue;
		}
		if (shortestNonSelf >= hops.minHops || hasResidualSimplePath(u)) {
			matchedPaths.add(graph.docsByIndex[u]!.file.path);
		}
	}

	return matchedPaths;
}

/**
 * Projects and flattens scalar values across all documents matched by `@query.<name>`
 * for `@query.<name>.<segments>`, applying existential `OR` semantics.
 */
export function resolveQueryScalarValues(
	matchedDocs: readonly NormalizedDocument[] | undefined,
	segments: readonly string[],
	getBacklinksForDoc?: (doc: NormalizedDocument) => readonly BacklinkRef[],
): ResolvedHostScalar[] {
	if (!matchedDocs || matchedDocs.length === 0 || segments.length === 0) {
		return [];
	}
	const needsBacklinks =
		segments[0]?.toLowerCase() === 'backlinks' && getBacklinksForDoc !== undefined;
	const out: ResolvedHostScalar[] = [];
	for (let i = 0; i < matchedDocs.length; i++) {
		const doc = matchedDocs[i]!;
		const effectiveDoc =
			needsBacklinks && doc.backlinks === undefined
				? { ...doc, backlinks: getBacklinksForDoc(doc) }
				: doc;
		const res = resolveThisReference(effectiveDoc, segments);
		if (res.resolved) {
			for (let j = 0; j < res.values.length; j++) {
				out.push(res.values[j]!);
			}
		}
	}
	return out;
}

/**
 * Coerces flattened scalar values from `@query.<name>.<segments>` for a typed property filter.
 */
export function coerceQueryScalarsForProperty(
	scalars: readonly ResolvedHostScalar[],
	propType: ObsidianPropertyType,
	timeZone: string,
	referenceTimeMs: number,
) {
	return scalars
		.map((val) => coerceHostScalarForProperty(val, propType, timeZone, referenceTimeMs))
		.filter((c): c is Exclude<typeof c, { readonly ok: false }> => c.ok);
}

/**
 * Pass- and wave-scoped evaluation state shared across candidate documents during
 * graph traversal and `@query.<name>` resolution.
 */
export interface GraphEvaluationContext {
	readonly graph: VaultGraphSnapshot;
	readonly priorQueryDocs?: ReadonlyMap<string, readonly NormalizedDocument[]> | undefined;
	readonly getBacklinksForDoc?: ((doc: NormalizedDocument) => readonly BacklinkRef[]) | undefined;
	readonly graphNodeCache: WeakMap<object, ReadonlySet<string>>;
	readonly queryScalarCache: WeakMap<object, unknown>;
}

/**
 * Creates a fresh `GraphEvaluationContext` with memoization caches for a single evaluation wave.
 */
export function createGraphEvaluationContext(
	graph: VaultGraphSnapshot,
	priorQueryDocs?: ReadonlyMap<string, readonly NormalizedDocument[]>,
	getBacklinksForDoc?: (doc: NormalizedDocument) => readonly BacklinkRef[],
): GraphEvaluationContext {
	return {
		graph,
		priorQueryDocs,
		getBacklinksForDoc,
		graphNodeCache: new WeakMap(),
		queryScalarCache: new WeakMap(),
	};
}
