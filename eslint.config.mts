import obsidianmd from 'eslint-plugin-obsidianmd';
import tsdoc from 'eslint-plugin-tsdoc';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import { globalIgnores, defineConfig } from 'eslint/config';
import tsdocSingleRemarks from './eslint-rules/tsdoc-single-remarks.ts';

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
					],
				},
			],
		},
	},
	{
		// `fake-indexeddb` is a test-only shim. It must never reach a
		// production path: the adapter gets IndexedDB from the ambient
		// globals (or an injected `IDBFactory` via `DexieOptions`), and the
		// shim is wired in only from `tests/`. Separate block from the
		// hexagon rule above because its scope is all of `src/**`, not just
		// core/ports.
		files: ['src/**/*.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['fake-indexeddb', 'fake-indexeddb/*'],
							message:
								'fake-indexeddb is a test-only shim — production code must use the ambient IndexedDB (injected via DexieOptions), never the fake.',
						},
					],
				},
			],
		},
	},
	{
		// This project is a template, not a fork of the sample plugin
		// preparing to publish under new names — it deliberately keeps
		// `obsidian-sample-plugin`'s own class names as its identity (see
		// `manifest.json`). `obsidianmd/sample-names` exists to nag real
		// plugin authors into renaming these before release; that nag does
		// not apply here, so it is disabled for the two files that use
		// them.
		files: ['src/main.ts', 'src/settings.ts'],
		rules: {
			'obsidianmd/sample-names': 'off',
		},
	},
	prettier,
);
