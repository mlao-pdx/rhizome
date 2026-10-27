import { describe, expect, it } from 'vitest';
import { formatLogLine, LEVEL_ORDER, shouldLog } from '../../src/adapters/logger-format';

describe('LEVEL_ORDER', () => {
	it('defines the three severity levels in ascending order', () => {
		expect(LEVEL_ORDER).toEqual(['debug', 'warn', 'error']);
	});
});

describe('shouldLog', () => {
	it('is true when the level is at or above the threshold', () => {
		expect(shouldLog('warn', 'warn')).toBe(true);
		expect(shouldLog('warn', 'error')).toBe(true);
		expect(shouldLog('debug', 'error')).toBe(true);
		expect(shouldLog('debug', 'warn')).toBe(true);
		expect(shouldLog('debug', 'debug')).toBe(true);
	});

	it('is false when the level is below the threshold or unrecognized', () => {
		expect(shouldLog('warn', 'debug')).toBe(false);
		expect(shouldLog('error', 'warn')).toBe(false);
		expect(shouldLog('error', 'debug')).toBe(false);
		expect(shouldLog('info' as never, 'debug')).toBe(false);
	});
});

describe('formatLogLine', () => {
	it('formats timestamp level and message with no meta suffix when meta is omitted', () => {
		const line = formatLogLine('2026-08-09T00:00:00.000Z', 'debug', 'plugin loaded');
		expect(line).toBe('2026-08-09T00:00:00.000Z [DEBUG] plugin loaded\n');
	});

	it('appends meta as JSON when present', () => {
		const line = formatLogLine('2026-08-09T00:00:00.000Z', 'warn', 'slow parse', { ms: 42 });
		expect(line).toBe('2026-08-09T00:00:00.000Z [WARN] slow parse {"ms":42}\n');
	});

	it('omits the meta suffix for an empty meta object', () => {
		const line = formatLogLine('2026-08-09T00:00:00.000Z', 'debug', 'no-op', {});
		expect(line).toBe('2026-08-09T00:00:00.000Z [DEBUG] no-op\n');
	});

	it('uppercases every level', () => {
		for (const level of ['debug', 'warn', 'error'] as const) {
			expect(formatLogLine('2026-08-09T00:00:00.000Z', level, 'x')).toContain(
				`[${level.toUpperCase()}]`,
			);
		}
	});
});
