import { describe, expect, it } from 'vitest';
import {
	IDENTITY_KEY,
	IDENTITY_RECORD_FORMAT,
	type DatabaseIdentityRecord,
	decideBootstrapAction,
	isValidIdentityRecord,
	isValidVaultInstanceId,
	mintVaultInstanceId,
} from '../../src/adapters/database-identity';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';

function record(vaultInstanceId: string): DatabaseIdentityRecord {
	return { key: IDENTITY_KEY, format: IDENTITY_RECORD_FORMAT, vaultInstanceId };
}

describe('decideBootstrapAction — full decision table', () => {
	it('missing/malformed persisted + absent database → mint first, create', () => {
		expect(
			decideBootstrapAction({
				persistedId: undefined,
				databasePresent: false,
				storedIdentity: undefined,
			}),
		).toEqual({ mintFirst: true, database: 'create' });
	});

	it('present persisted + absent database → create', () => {
		expect(
			decideBootstrapAction({
				persistedId: ID_A,
				databasePresent: false,
				storedIdentity: undefined,
			}),
		).toEqual({ mintFirst: false, database: 'create' });
	});

	it('present persisted + present database + equal identity → reuse', () => {
		expect(
			decideBootstrapAction({
				persistedId: ID_A,
				databasePresent: true,
				storedIdentity: record(ID_A),
			}),
		).toEqual({ mintFirst: false, database: 'reuse' });
	});

	it('present persisted + present database + different identity → recreate', () => {
		expect(
			decideBootstrapAction({
				persistedId: ID_A,
				databasePresent: true,
				storedIdentity: record(ID_B),
			}),
		).toEqual({ mintFirst: false, database: 'recreate' });
	});

	it('present persisted + present database + missing/malformed identity → recreate', () => {
		for (const storedIdentity of [
			undefined,
			null,
			'string-not-a-record',
			{ key: IDENTITY_KEY, format: 99, vaultInstanceId: ID_A },
			{ key: 'other', format: IDENTITY_RECORD_FORMAT, vaultInstanceId: ID_A },
			{ key: IDENTITY_KEY, format: IDENTITY_RECORD_FORMAT, vaultInstanceId: '' },
		]) {
			expect(
				decideBootstrapAction({ persistedId: ID_A, databasePresent: true, storedIdentity }),
			).toEqual({ mintFirst: false, database: 'recreate' });
		}
	});

	it('missing/malformed persisted + present database → mint first, recreate, regardless of stored identity', () => {
		for (const storedIdentity of [undefined, record(ID_A), record(ID_B)]) {
			expect(
				decideBootstrapAction({
					persistedId: undefined,
					databasePresent: true,
					storedIdentity,
				}),
			).toEqual({ mintFirst: true, database: 'recreate' });
		}
	});

	it('treats a present-but-unopenable database as present (storedIdentity unreadable)', () => {
		expect(
			decideBootstrapAction({
				persistedId: ID_A,
				databasePresent: true,
				storedIdentity: undefined,
			}),
		).toEqual({ mintFirst: false, database: 'recreate' });
	});
});

describe('isValidVaultInstanceId', () => {
	it('accepts non-empty strings', () => {
		expect(isValidVaultInstanceId(ID_A)).toBe(true);
		expect(isValidVaultInstanceId('not-a-uuid-but-nonempty')).toBe(true);
	});

	it('rejects non-strings and empty strings', () => {
		expect(isValidVaultInstanceId(undefined)).toBe(false);
		expect(isValidVaultInstanceId(null)).toBe(false);
		expect(isValidVaultInstanceId('')).toBe(false);
		expect(isValidVaultInstanceId(42)).toBe(false);
		expect(isValidVaultInstanceId({})).toBe(false);
	});
});

describe('isValidIdentityRecord', () => {
	it('accepts the current record shape', () => {
		expect(isValidIdentityRecord(record(ID_A))).toBe(true);
	});

	it('rejects a wrong or absent format', () => {
		expect(isValidIdentityRecord({ ...record(ID_A), format: 2 })).toBe(false);
		expect(isValidIdentityRecord({ key: IDENTITY_KEY, vaultInstanceId: ID_A })).toBe(false);
		expect(isValidIdentityRecord({ ...record(ID_A), format: '1' })).toBe(false);
	});

	it('rejects a wrong or absent key', () => {
		expect(isValidIdentityRecord({ ...record(ID_A), key: 'id' })).toBe(false);
		expect(
			isValidIdentityRecord({ format: IDENTITY_RECORD_FORMAT, vaultInstanceId: ID_A }),
		).toBe(false);
	});

	it('rejects non-string or empty vaultInstanceIds', () => {
		expect(isValidIdentityRecord({ ...record(ID_A), vaultInstanceId: '' })).toBe(false);
		expect(isValidIdentityRecord({ ...record(ID_A), vaultInstanceId: 7 })).toBe(false);
		expect(isValidIdentityRecord({ ...record(ID_A), vaultInstanceId: null })).toBe(false);
	});

	it('rejects non-object values', () => {
		expect(isValidIdentityRecord(undefined)).toBe(false);
		expect(isValidIdentityRecord(null)).toBe(false);
		expect(isValidIdentityRecord('identity')).toBe(false);
		expect(isValidIdentityRecord(1)).toBe(false);
	});
});

describe('mintVaultInstanceId', () => {
	it('produces distinct, valid ids', () => {
		const first = mintVaultInstanceId();
		const second = mintVaultInstanceId();
		expect(first).not.toBe(second);
		expect(isValidVaultInstanceId(first)).toBe(true);
		expect(isValidVaultInstanceId(second)).toBe(true);
	});
});
