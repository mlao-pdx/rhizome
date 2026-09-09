import obsidianmd from 'eslint-plugin-obsidianmd';
import tsdoc from 'eslint-plugin-tsdoc';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import { globalIgnores, defineConfig } from 'eslint/config';
import tsdocSingleRemarks from './eslint-rules/tsdoc-single-remarks.ts';

/**
 * Import bans that apply to every file under `src/` (test shim + Node
 * builtins). Restated in each `no-restricted-imports` block below because
 * flat config replaces a rule's settings wholesale per matching file —
 * there is no per-pattern merge across blocks.
 */
const srcWideBannedImports = [
	{
		// `fake-indexeddb` is a test-only shim. It must never reach a
		// production path: the adapter gets IndexedDB from the ambient
		// globals (or an injected `IDBFactory` via `DexieOptions`), and the
		// shim is wired in only from `tests/`.
		group: ['fake-indexeddb', 'fake-indexeddb/*'],
		message:
			'fake-indexeddb is a test-only shim — production code must use the ambient IndexedDB (injected via DexieOptions), never the fake.',
	},
	{
		// The platform decision (docs/spec/decisions.md, Rev 0.1): src runs
		// in desktop and mobile webviews.
		group: ['node:*', 'node:*/*'],
		message:
			'src/ runs in desktop and mobile webviews — Node/Electron builtins are unavailable on mobile; use Web APIs (e.g. crypto.subtle).',
	},
];

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'coverage',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'scripts/promote-fast-check.mjs',
		'scripts/check-licenses.mjs',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.mts',
						'manifest.json',
						'vitest.config.ts',
						'vitest.properties.config.ts',
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	{
		files: ['tests/**/*.ts'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ['**/*.ts'],
		plugins: {
			tsdoc,
			local: { rules: { 'tsdoc-single-remarks': tsdocSingleRemarks } },
		},
		rules: {
			'tsdoc/syntax': 'error',
			'local/tsdoc-single-remarks': 'error',
		},
	},
	{
		// Everything under src/ except core and ports: no test shim, no
		// Node builtins. `obsidian`/`dexie` runtime imports are allowed
		// here — this is the adapter layer.
		files: ['src/**/*.ts'],
		ignores: ['src/core/**', 'src/ports/**'],
		rules: {
			'no-restricted-imports': ['error', { patterns: srcWideBannedImports }],
		},
	},
	{
		// The hexagon boundary, plus the same src-wide bans. In flat config
		// the last matching config replaces a rule's settings wholesale —
		// overlapping blocks cannot each contribute patterns — so this
		// block must restate the src-wide bans or core/ports files would
		// silently lose them.
		files: ['src/core/**/*.ts', 'src/ports/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['obsidian', 'obsidian/*'],
							message:
								'src/core and src/ports must not import obsidian at runtime — depend on a @ports/* interface instead.',
						},
						{
							group: ['dexie', 'dexie/*'],
							message:
								'src/core and src/ports must not import dexie at runtime — depend on a @ports/* interface instead.',
						},
						...srcWideBannedImports,
					],
				},
			],
		},
	},
	prettier,
);
