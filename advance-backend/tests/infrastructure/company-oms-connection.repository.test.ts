import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CompanyOmsConnectionRepository } from '../../src/infrastructure/persistence/company-oms-connection.repository.ts';

const ENCRYPTION_KEY = '0'.repeat(64);

const row = (over: Record<string, unknown> = {}) => ({
  id: 'conn-1',
  label: 'OMS',
  status: 'connected',
  lastTestedAt: null,
  lastSucceededAt: null,
  lastFailureAt: null,
  lastFailureCode: null,
  lastUsedAt: null,
  unavailableUntil: null,
  createdAt: new Date('2026-07-26T00:00:00.000Z'),
  updatedAt: new Date('2026-07-26T00:00:00.000Z'),
  ...over,
});

/** OMS is a single company-wide credential, so at most one row may be connected. */
describe('CompanyOmsConnectionRepository single-connection invariant', () => {
  it('retires every other connected credential when one is re-enabled', async () => {
    const retired: unknown[] = [];
    const table = {
      findFirst: async () => row({ status: 'disabled' }),
      update: async () => row({ status: 'connected' }),
      updateMany: async (input: unknown) => { retired.push(input); return { count: 1 }; },
    };
    const repo = new CompanyOmsConnectionRepository({
      companyOmsConnection: table,
      $transaction: async (fn: (tx: unknown) => unknown) => fn({ companyOmsConnection: table }),
    } as never, ENCRYPTION_KEY);

    const result = await repo.setStatus('co-1', 'conn-1', 'connected');

    assert.equal(result?.status, 'connected');
    assert.equal(retired.length, 1, 'sibling connections must be retired');
    assert.deepEqual((retired[0] as any).where, {
      companyId: 'co-1',
      id: { not: 'conn-1' },
      revokedAt: null,
      status: 'connected',
    });
    assert.equal((retired[0] as any).data.status, 'disabled');
  });

  it('does not touch other credentials when one is merely disabled', async () => {
    // Disabling is the kill switch; it must never promote another key.
    const retired: unknown[] = [];
    const table = {
      findFirst: async () => row(),
      update: async () => row({ status: 'disabled' }),
      updateMany: async (input: unknown) => { retired.push(input); return { count: 0 }; },
    };
    const repo = new CompanyOmsConnectionRepository({
      companyOmsConnection: table,
      $transaction: async (fn: (tx: unknown) => unknown) => fn({ companyOmsConnection: table }),
    } as never, ENCRYPTION_KEY);

    await repo.setStatus('co-1', 'conn-1', 'disabled');

    assert.equal(retired.length, 0);
  });

  it('prefers the most recently saved credential if two are ever connected', async () => {
    let query: any;
    const repo = new CompanyOmsConnectionRepository({
      companyOmsConnection: {
        findFirst: async (input: unknown) => { query = input; return null; },
      },
    } as never, ENCRYPTION_KEY);

    await repo.findActive('co-1');

    // Ascending order would silently resurrect a superseded key.
    assert.deepEqual(query.orderBy, { createdAt: 'desc' });
  });

  it('returns null without touching other rows when the connection is absent', async () => {
    const repo = new CompanyOmsConnectionRepository({
      companyOmsConnection: { findFirst: async () => null },
      $transaction: async () => { throw new Error('must not open a transaction'); },
    } as never, ENCRYPTION_KEY);

    assert.equal(await repo.setStatus('co-1', 'missing', 'connected'), null);
  });
});
