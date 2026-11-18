function isFreezableContainer(value: object): boolean {
	const proto: object | null = Reflect.getPrototypeOf(value);
	return proto === Object.prototype || proto === null || Array.isArray(value);
}

function freezeValue(value: unknown, seen: WeakSet<object>): void {
	if (value === null || typeof value !== 'object') {
		return;
	}
	const container = value;
	if (seen.has(container)) {
		return;
	}
	seen.add(container);
	if (!isFreezableContainer(container)) {
		return;
	}
	Object.freeze(container);
	if (Array.isArray(value)) {
		for (const item of value) {
			freezeValue(item, seen);
		}
		return;
	}
	for (const key of Object.keys(value)) {
		freezeValue((value as Record<string, unknown>)[key], seen);
	}
}

/**
 * Recursively freezes plain objects and arrays in place and returns the same reference.
 *
 * @remarks
 * (design, 2026-11-18) Cached `NormalizedDocument` payloads are handed to query evaluators and
 * template renderers as snapshots. Freezing them makes accidental mutation fail loudly in
 * strict-mode code instead of silently corrupting every later read of the cache entry; only
 * plain objects and arrays are traversed so boxed primitives and other exotic values are left
 * untouched. Already frozen parents are still traversed (with a per-call seen set) so a shallow
 * freeze cannot hide mutable children.
 */
export function deepFreeze<T>(value: T): T {
	freezeValue(value, new WeakSet());
	return value;
}
