import * as fc from 'fast-check';
import fs from 'node:fs';
import path from 'node:path';

const FINDINGS_DIR = path.resolve(process.cwd(), '.fast-check-findings');

function slugify(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function stringifyError(errorInstance: unknown): string | undefined {
	if (errorInstance === undefined || errorInstance === null) return undefined;
	if (errorInstance instanceof Error) return errorInstance.message;
	if (typeof errorInstance === 'string') return errorInstance;
	return fc.stringify(errorInstance);
}

function persistFinding(id: string, result: fc.RunDetails<unknown> & { failed: true }): void {
	fs.mkdirSync(FINDINGS_DIR, { recursive: true });
	const finding = {
		id,
		timestamp: new Date().toISOString(),
		seed: result.seed,
		numRuns: result.numRuns,
		counterexamplePath: result.counterexamplePath,
		counterexample: result.counterexample,
		errorMessage: stringifyError(result.errorInstance),
		report: fc.defaultReportMessage(result),
	};
	fs.writeFileSync(
		path.join(FINDINGS_DIR, `${slugify(id)}.json`),
		JSON.stringify(finding, null, 2),
	);
}

function handle(id: string, result: fc.RunDetails<unknown>): void {
	if (!result.failed) return;
	persistFinding(id, result);
	throw new Error(fc.defaultReportMessage(result));
}

/**
 * Runs a fast-check property via `fc.check` (never `fc.assert`) so that
 * failures can be captured to `.fast-check-findings/<id>.json` before
 * the test fails. `id` must be a stable, unique slug identifying this
 * property, e.g. `'smoke/clamp__result-within-bounds'` — used as the
 * finding filename. Convention: `<module-path>__<short-description>`.
 */
export function assertProperty<Ts>(
	id: string,
	property: fc.IPropertyWithHooks<Ts> | fc.IAsyncPropertyWithHooks<Ts>,
	params?: fc.Parameters<Ts>,
): void | Promise<void> {
	const result = fc.check(property, params);
	if (result instanceof Promise) {
		return result.then((r) => handle(id, r as fc.RunDetails<unknown>));
	}
	return handle(id, result as fc.RunDetails<unknown>);
}
