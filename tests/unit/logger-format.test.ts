import { describe, expect, it } from 'vitest';
import { formatLogLine, shouldLog } from '../../src/adapters/logger-format';

describe('shouldLog', () => {
	it('is true when the level is at or above the threshold', () => {
		expect(shouldLog('warn', 'warn')).toBe(true);
		expect(shouldLog('warn', 'error')).toBe(true);
		expect(shouldLog('trace', 'error')).toBe(true);
	});

	it('is false when the level is below the threshold', () => {
		expect(shouldLog('warn', 'info')).toBe(false);
		expect(shouldLog('warn', 'debug')).toBe(false);
		expect(shouldLog('error', 'warn')).toBe(false);
	});
});

describe('formatLogLine', () => {
	it('formats timestamp level and message with no meta suffix when meta is omitted', () => {
		const line = formatLogLine('2026-08-09T00:00:00.000Z', 'info', 'plugin loaded');
		expect(line).toBe('2026-08-09T00:00:00.000Z [INFO] plugin loaded\n');
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
		for (const level of ['trace', 'debug', 'info', 'warn', 'error'] as const) {
			expect(formatLogLine('2026-08-09T00:00:00.000Z', level, 'x')).toContain(
				`[${level.toUpperCase()}]`,
			);
		}
	});
});
