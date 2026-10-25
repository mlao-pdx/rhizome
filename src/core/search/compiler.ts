import { deepFreezeAST } from './ast-utils';
import { lintQueryAST } from './linter';
import { parseQuery } from './parser';
import { isValidReferenceTimeMs } from './temporal';
import type { CompileResult, PreparedQuery, ResolvedEngineConfig } from './types';
import { validateQueryAST } from './validator';

/**
 * Compiles a search query string into a deeply frozen `PreparedQuery` and collects all errors, warnings, and hints.
 */
export function compileQuery(
	input: string,
	resolvedConfig: ResolvedEngineConfig,
	referenceTimeMs: number,
): CompileResult {
	// Step 0: Validate referenceTimeMs
	if (!isValidReferenceTimeMs(referenceTimeMs)) {
		return {
			ast: null,
			prepared: null,
			diagnostics: [
				{
					code: 'ERROR_INVALID_CONFIG',
					severity: 'error',
					issue: `Invalid referenceTimeMs "${String(referenceTimeMs)}". Must be a safe integer within [-8640000000000000, 8640000000000000].`,
					hint: 'Provide a valid UTC epoch millisecond timestamp (e.g. Date.now()).',
					span: null,
				},
			],
			executable: false,
		};
	}

	// Step 1: Check length & lex/parse
	const parsed = parseQuery(input, resolvedConfig);
	const hasParseError = parsed.diagnostics.some((d) => d.severity === 'error');
	if (!parsed.ast || hasParseError) {
		return {
			ast: null,
			prepared: null,
			diagnostics: parsed.diagnostics,
			executable: false,
		};
	}

	// Steps 2-4: Semantic validation
	const { diagnostics: valDiagnostics, invalidPropertyNodes } = validateQueryAST(
		parsed.ast,
		resolvedConfig,
		referenceTimeMs,
	);

	// Step 5: Non-blocking linter pass
	const lintDiagnostics = lintQueryAST(parsed.ast, invalidPropertyNodes);

	// Step 6: Global compile gate & deep freeze
	const diagnostics = [...parsed.diagnostics, ...valDiagnostics, ...lintDiagnostics];
	const hasErrors = diagnostics.some((d) => d.severity === 'error');
	if (hasErrors) {
		return {
			ast: null,
			prepared: null,
			diagnostics,
			executable: false,
		};
	}

	const frozenAst = deepFreezeAST(parsed.ast);
	const prepared: PreparedQuery = Object.freeze({
		__brand: 'PreparedQuery' as const,
		ast: frozenAst,
		resolvedConfig,
		referenceTimeMs,
	});
	return {
		ast: frozenAst,
		prepared,
		diagnostics,
		executable: true,
	};
}
