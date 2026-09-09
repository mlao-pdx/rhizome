import type { App, PluginManifest } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => import('../support/mock-obsidian-app'));

import RhizomePlugin from '../../src/main';
import {
	VAULT_SCOPE_HASH_LENGTH,
	normaliseVaultRoot,
} from '../../src/adapters/persistence-db-name';
import { createMockApp, createMockManifest } from '../support/mock-obsidian-app';

function createPlugin(appOptions?: {
	appId?: string;
	adapter?: 'fs' | 'capacitor';
}): RhizomePlugin {
	const app = createMockApp(appOptions) as App;
	const manifest = createMockManifest() as PluginManifest;
	return new RhizomePlugin(app, manifest);
}

/** Recomputes the fallback scope the way production does — ambient Web Crypto. */
async function expectedFallbackScope(vaultRootPath: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(normaliseVaultRoot(vaultRootPath)),
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, VAULT_SCOPE_HASH_LENGTH);
}

describe('RhizomePlugin lifecycle (smoke)', () => {
	it('onload() does not throw', async () => {
		const plugin = createPlugin();
		await plugin.onload();
	});

	it('onunload() does not throw', async () => {
		const plugin = createPlugin();
		await plugin.onload();
		expect(() => plugin.onunload()).not.toThrow();
	});

	it('settings load with defaults when loadData() resolves undefined', async () => {
		const plugin = createPlugin();
		await plugin.onload();
		expect(plugin.settings.loggingEnabled).toBe(false);
		expect(plugin.settings.logLevel).toBe('warn');
	});

	it('constructs a loggerAdapter during onload()', async () => {
		const plugin = createPlugin();
		await plugin.onload();
		expect(plugin.loggerAdapter).toBeDefined();
	});

	it('derives the log folder path from the manifest id, not a hardcoded literal', async () => {
		const plugin = createPlugin();
		await plugin.onload();
		expect(plugin.loggerAdapter.logsFolderPath).toBe('_rhizome/logs');
	});

	it('scopes the persistence database by the app appId', async () => {
		const plugin = createPlugin();
		await plugin.onload();
		expect(plugin.persistence.dbName).toBe('rhizome/cache/test-app-id');
	});

	it('falls back to a hash of the vault root when the app exposes no usable appId', async () => {
		const plugin = createPlugin({ appId: '' });
		await plugin.onload();
		const scope = await expectedFallbackScope('/mock/vault');
		expect(plugin.persistence.dbName).toBe(`rhizome/cache/${scope}`);
		expect(scope).toMatch(/^[0-9a-f]{12}$/);
	});

	it('loads on a capacitor (mobile) adapter without throwing, hashing its vault root as fallback', async () => {
		const plugin = createPlugin({ appId: '', adapter: 'capacitor' });
		await plugin.onload();
		// The mock capacitor adapter's getFullPath('') is the vault root,
		// same path the fs mock exposes — so the same fallback scope.
		const scope = await expectedFallbackScope('/mock/vault');
		expect(plugin.persistence.dbName).toBe(`rhizome/cache/${scope}`);
	});

	it('loads on a capacitor (mobile) adapter with an appId', async () => {
		const plugin = createPlugin({ adapter: 'capacitor' });
		await plugin.onload();
		expect(plugin.persistence.dbName).toBe('rhizome/cache/test-app-id');
	});
});
