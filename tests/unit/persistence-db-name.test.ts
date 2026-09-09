import { describe, expect, it } from 'vitest';
import {
	VAULT_SCOPE_HASH_LENGTH,
	derivePersistenceDbName,
	deriveVaultScope,
	normaliseVaultRoot,
} from '../../src/adapters/persistence-db-name';

const VAULT_ROOT = '/Users/tester/Vaults/main';

/** Recomputes the fallback hash the way production does — ambient Web Crypto. */
async function expectedFallbackHash(vaultRootPath: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(normaliseVaultRoot(vaultRootPath)),
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	);
}

describe('deriveVaultScope', () => {
	it('passes a valid appId through untouched, whatever its format', async () => {
		await expect(deriveVaultScope('9eb159e691f382d7', VAULT_ROOT)).resolves.toBe(
			'9eb159e691f382d7',
		);
		// No format over-constraint on an undocumented value: uniqueness,
		// not shape, is the requirement.
		await expect(deriveVaultScope('not-16-hex-at-all!', VAULT_ROOT)).resolves.toBe(
			'not-16-hex-at-all!',
		);
	});

	it.each([
		['undefined', undefined],
		['null', null],
		['empty string', ''],
		['a number', 42],
		['an object', {}],
	])('falls back to the vault-root hash when the appId is %s', async (_label, appId) => {
		const full = await expectedFallbackHash(VAULT_ROOT);
		await expect(deriveVaultScope(appId, VAULT_ROOT)).resolves.toBe(
			full.slice(0, VAULT_SCOPE_HASH_LENGTH),
		);
	});

	it('derives a 12-character lowercase hex fallback hash', async () => {
		const scope = await deriveVaultScope(undefined, VAULT_ROOT);
		expect(scope).toMatch(/^[0-9a-f]{12}$/);
		expect(scope).toHaveLength(VAULT_SCOPE_HASH_LENGTH);
	});

	it('is deterministic for identical input', async () => {
		const a = await deriveVaultScope(undefined, VAULT_ROOT);
		const b = await deriveVaultScope(undefined, VAULT_ROOT);
		expect(a).toBe(b);
	});

	it('normalises trailing separators before hashing', async () => {
		const plain = await deriveVaultScope(undefined, VAULT_ROOT);
		await expect(deriveVaultScope(undefined, VAULT_ROOT + '/')).resolves.toBe(plain);
		await expect(deriveVaultScope(undefined, VAULT_ROOT + '\\\\')).resolves.toBe(plain);
	});

	it('deliberately does not lowercase, so distinct vaults on case-sensitive filesystems stay distinct', async () => {
		const lower = await deriveVaultScope(undefined, VAULT_ROOT);
		const upper = await deriveVaultScope(undefined, VAULT_ROOT.toUpperCase());
		expect(upper).not.toBe(lower);
	});

	it('derives different hashes for different vault roots', async () => {
		const a = await deriveVaultScope(undefined, VAULT_ROOT);
		const b = await deriveVaultScope(undefined, '/Users/tester/Vaults/other');
		expect(a).not.toBe(b);
	});

	it('throws when neither a usable appId nor a vault root is available', async () => {
		await expect(deriveVaultScope(undefined, undefined)).rejects.toThrow(
			/no appId and no readable vault root/,
		);
		await expect(deriveVaultScope('', undefined)).rejects.toThrow(
			/no appId and no readable vault root/,
		);
	});
});

describe('derivePersistenceDbName', () => {
	const INPUT = {
		pluginId: 'rhizome',
		databaseId: 'cache',
		vaultScope: '9eb159e691f382d7',
	};

	it('produces the {pluginId}/{databaseId}/{vaultScope} address shape', () => {
		expect(derivePersistenceDbName(INPUT)).toBe('rhizome/cache/9eb159e691f382d7');
		expect(derivePersistenceDbName(INPUT).split('/')).toHaveLength(3);
	});

	it('is a pure join — the vaultScope is embedded verbatim, never hashed', () => {
		expect(derivePersistenceDbName({ ...INPUT, vaultScope: 'any-string' })).toBe(
			'rhizome/cache/any-string',
		);
	});

	it('includes the databaseId in the address', () => {
		const other = derivePersistenceDbName({ ...INPUT, databaseId: 'index' });
		expect(other).toBe('rhizome/index/9eb159e691f382d7');
		expect(other).not.toBe(derivePersistenceDbName(INPUT));
	});
});

describe('normaliseVaultRoot', () => {
	it('strips trailing separators only', () => {
		expect(normaliseVaultRoot('/vault/root')).toBe('/vault/root');
		expect(normaliseVaultRoot('/vault/root/')).toBe('/vault/root');
		expect(normaliseVaultRoot('/vault/root//')).toBe('/vault/root');
		expect(normaliseVaultRoot('C:\\Vault\\')).toBe('C:\\Vault');
	});

	it('never touches interior separators or case', () => {
		expect(normaliseVaultRoot('/Vault/Root/')).toBe('/Vault/Root');
		expect(normaliseVaultRoot('/vault//inner/')).toBe('/vault//inner');
	});
});
