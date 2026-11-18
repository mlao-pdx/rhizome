import { describe, expect, it } from 'vitest';

import {
	planReconcile,
	type ReconcileCacheKey,
	type ReconcileFileState,
} from '../../src/core/cache/reconcile-plan';

const FP = 'fp-1';

function state(overrides: Partial<ReconcileFileState> = {}): ReconcileFileState {
	return {
		path: 'notes/a.md',
		mtime: 100,
		size: 10,
		revision: 'rev-1',
		ignored: false,
		...overrides,
	};
}

function key(overrides: Partial<ReconcileCacheKey> = {}): ReconcileCacheKey {
	return {
		path: 'notes/a.md',
		mtime: 100,
		size: 10,
		revision: 'rev-1',
		fingerprint: FP,
		...overrides,
	};
}

describe('planReconcile', () => {
	it('does nothing when the key matches the live state', () => {
		expect(planReconcile([state()], [key()], FP)).toEqual({
			add: [],
			update: [],
			remove: [],
		});
	});

	it.each([
		['mtime', state({ mtime: 101 })],
		['size', state({ size: 11 })],
		['revision', state({ revision: 'rev-2' })],
	])('updates when %s changes', (_label, next) => {
		expect(planReconcile([next], [key()], FP)).toEqual({
			add: [],
			update: ['notes/a.md'],
			remove: [],
		});
	});

	it('updates everything when the config fingerprint changes', () => {
		const plan = planReconcile(
			[state(), state({ path: 'notes/b.md' })],
			[key(), key({ path: 'notes/b.md' })],
			'fp-2',
		);
		expect(plan.update).toEqual(['notes/a.md', 'notes/b.md']);
	});

	it('adds live uncached notes and removes vanished ones', () => {
		const plan = planReconcile(
			[state({ path: 'notes/new.md' })],
			[key({ path: 'notes/gone.md' })],
			FP,
		);
		expect(plan).toEqual({
			add: ['notes/new.md'],
			update: [],
			remove: ['notes/gone.md'],
		});
	});

	it('never stores ignored notes and removes a cached note that became ignored', () => {
		const plan = planReconcile(
			[state({ ignored: true }), state({ path: 'notes/never.md', ignored: true })],
			[key()],
			FP,
		);
		expect(plan).toEqual({
			add: [],
			update: [],
			remove: ['notes/a.md'],
		});
	});

	it('treats events as hints and never forces an update for a matching key', () => {
		expect(planReconcile([state()], [key()], FP)).toEqual({
			add: [],
			update: [],
			remove: [],
		});
		expect(planReconcile([state({ ignored: true })], [], FP)).toEqual({
			add: [],
			update: [],
			remove: [],
		});
	});
});
