import { describe, expect, it } from 'vitest';
import {
	VAULT_ROOT_HASH_LENGTH,
	derivePersistenceDbName,
	normaliseVaultRoot,
} from '../../src/adapters/persistence-db-name';

const INPUT = {
	pluginId: 'sample-plugin',
	databaseId: 'cache',
	vaultRootPath: '/Users/tester/Vaults/main',
};

describe('derivePersistenceDbName', () => {
	it('produces the {pluginId}/{databaseId}/{hash} address shape', () => {
		expect(derivePersistenceDbName(INPUT)).toMatch(/^sample-plugin\/cache\/[0-9a-f]{12}$/);
	});

	it('is deterministic for identical input', () => {
		expect(derivePersistenceDbName(INPUT)).toBe(derivePersistenceDbName(INPUT));
	});

	it('carries no vault-instance identity — the address stays derivable after uninstall', () => {
		// The name is a pure function of pluginId/databaseId/vaultRootPath;
		// no minted id can ever appear in it.
		const name = derivePersistenceDbName(INPUT);
		expect(name.split('/')).toHaveLength(3);
		expect(name).toBe(derivePersistenceDbName({ ...INPUT }));
	});

	it('includes the databaseId in the address', () => {
		const other = derivePersistenceDbName({ ...INPUT, databaseId: 'index' });
		expect(other).toMatch(/^sample-plugin\/index\/[0-9a-f]{12}$/);
		expect(other).not.toBe(derivePersistenceDbName(INPUT));
	});

	it('normalises trailing separators before hashing', () => {
		const plain = derivePersistenceDbName(INPUT);
		expect(
			derivePersistenceDbName({ ...INPUT, vaultRootPath: INPUT.vaultRootPath + '/' }),
		).toBe(plain);
		expect(
			derivePersistenceDbName({ ...INPUT, vaultRootPath: INPUT.vaultRootPath + '\\\\' }),
		).toBe(plain);
	});

	it('deliberately does not lowercase, so distinct vaults on case-sensitive filesystems stay distinct', () => {
		const lower = derivePersistenceDbName(INPUT);
		const upper = derivePersistenceDbName({
			...INPUT,
			vaultRootPath: INPUT.vaultRootPath.toUpperCase(),
		});
		expect(upper).not.toBe(lower);
	});

	it('derives different hashes for different vault roots', () => {
		const a = derivePersistenceDbName(INPUT);
		const b = derivePersistenceDbName({
			...INPUT,
			vaultRootPath: '/Users/tester/Vaults/other',
		});
		expect(a).not.toBe(b);
	});

	it('keeps the hash short but collision-resistant enough for scoping', () => {
		const hash = derivePersistenceDbName(INPUT).split('/')[2];
		expect(hash).toHaveLength(VAULT_ROOT_HASH_LENGTH);
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
