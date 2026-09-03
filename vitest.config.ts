import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
		exclude: ['**/*.properties.test.ts', 'node_modules/**'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html'],
			include: ['src/core/**/*.ts'],
			exclude: ['**/*.test.ts', '**/*.properties.test.ts'],
		},
	},
	resolve: {
		alias: {
			'@core': path.resolve(import.meta.dirname, './src/core'),
			'@ports': path.resolve(import.meta.dirname, './src/ports'),
		},
	},
});
