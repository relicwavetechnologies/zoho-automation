import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DataExportDestinationPreferenceRepository } from '../../src/infrastructure/persistence/data-export-destination-preference.repository.ts';

describe('DataExportDestinationPreferenceRepository', () => {
  it('reads and updates one company-scoped user preference', async () => {
    const calls: unknown[] = [];
    const repository = new DataExportDestinationPreferenceRepository({
      dataExportDestinationPreference: {
        findUnique: async (input: unknown) => {
          calls.push(input);
          return { connectionId: 'google-1' };
        },
        upsert: async (input: unknown) => {
          calls.push(input);
          return {};
        },
      },
    } as any);

    const found = await repository.findConnectionId({
      companyId: 'company-1',
      userId: 'user-1',
    });
    const saved = await repository.save({
      companyId: 'company-1',
      userId: 'user-1',
      connectionId: 'google-2',
    });

    assert.deepEqual(found, { ok: true, value: 'google-1' });
    assert.deepEqual(saved, { ok: true, value: undefined });
    assert.deepEqual(calls, [
      {
        where: {
          companyId_userId: { companyId: 'company-1', userId: 'user-1' },
        },
        select: { connectionId: true },
      },
      {
        where: {
          companyId_userId: { companyId: 'company-1', userId: 'user-1' },
        },
        create: {
          companyId: 'company-1',
          userId: 'user-1',
          connectionId: 'google-2',
        },
        update: { connectionId: 'google-2' },
      },
    ]);
  });
});
