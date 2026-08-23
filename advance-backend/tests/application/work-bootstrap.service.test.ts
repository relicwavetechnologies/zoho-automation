import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WorkBootstrapService } from '../../src/application/gateway/work-bootstrap.service.ts';
import { asToolId } from '../../src/shared/ids.ts';

describe('WorkBootstrapService contract modes', () => {
  it('loads complete-cached contracts even when short prompt context was omitted', async () => {
    const loads: unknown[] = [];
    const service = new WorkBootstrapService({
      toolRegistry: {
        forRuntime: () => [{ id: 'googleSheets', family: 'google' }],
      } as any,
      connectionRegistry: {
        listAccessibleGoogleConnections: async () => ({
          ok: true,
          value: [{
            connectionId: 'connection-1',
            provider: 'google_workspace',
            label: 'Google',
            ownerType: 'user',
            ownerUserId: 'user-1',
            access: 'read_only',
            scopes: [],
            connectedAt: new Date('2026-08-23T00:00:00.000Z'),
          }],
        }),
      } as any,
      workContractBootstrap: {
        load: async input => {
          loads.push(input);
          return { contracts: [], unavailableNativeTools: ['create_spreadsheet'] };
        },
      },
    });
    const permission = {
      allowedToolIds: new Set([asToolId('googleSheets')]),
      allowedActionsByTool: new Map([[asToolId('googleSheets'), new Set(['read'])]]),
      decisions: [],
    } as any;

    const result = await service.build({
      companyId: 'company-1',
      userId: 'user-1',
      permission,
      registryRevision: 1,
      contractMode: 'complete_cached',
      toolIds: ['googleSheets'],
    });

    assert.equal(loads.length, 1);
    assert.equal((loads[0] as any).query, '');
    assert.equal((loads[0] as any).contractMode, 'complete_cached');
    assert.ok(result.advisories.some(advisory => advisory.code === 'native_contracts_unavailable'));
  });
});
