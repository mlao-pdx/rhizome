import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
	test: {
		include: ['src/**/*.properties.test.ts', 'tests/**/*.properties.test.ts'],
		environment: 'node',
		testTimeout: 30_000,
	},
	resolve: {
		alias: {
			'@core': path.resolve(import.meta.dirname, './src/core'),
			'@ports': path.resolve(import.meta.dirname, './src/ports'),
		},
	},
});
