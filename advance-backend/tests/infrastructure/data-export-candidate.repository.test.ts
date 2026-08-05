import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DataExportCandidateRepository } from '../../src/infrastructure/persistence/data-export-candidate.repository.ts';

const COMPANY_ID = '9f9360aa-28d1-49df-919f-3b121b7403df';
const USER_ID = 'f6312e2b-d0d3-49fa-acba-786be69949e4';
const CHAT_ID = 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50';
const VALID_ID = '6c1bb94d-5b4e-40b9-b5cb-cb4d2bcfc505';
const STALE_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-08-05T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-08-06T00:00:00.000Z');

describe('DataExportCandidateRepository.listActiveForActor', () => {
  it('skips stale candidates whose payload no longer matches the current schema', async () => {
    const stalePayload = {
      companyId: COMPANY_ID,
      userId: USER_ID,
      chatId: CHAT_ID,
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'organic_positions', domain: 'example.com', database: 'us' },
      },
      destination: { format: 'auto', title: 'Semrush organic positions' },
      requestId: 'req-stale',
    };
    const validPayload = {
      companyId: COMPANY_ID,
      userId: USER_ID,
      chatId: CHAT_ID,
      source: {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'backlinks_comparison', targets: ['emiactech.com', 'decentro.tech'] },
      },
      destination: { format: 'auto', title: 'Semrush backlinks' },
      requestId: 'req-valid',
    };
    const row = (id: string, payload: unknown) => ({
      id,
      companyId: COMPANY_ID,
      userId: USER_ID,
      departmentId: null,
      chatId: CHAT_ID,
      conversationKey: null,
      sourceKind: 'semrush_snapshot',
      sourceConnectionId: 'backend_managed',
      payloadJson: payload,
      payloadHash: `hash-${id}`,
      schemaJson: [{ name: 'Target' }],
      previewRowCount: 1,
      estimatedRows: 1,
      coverageJson: null,
      status: 'active',
      expiresAt: EXPIRES_AT,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const db = {
      dataExportCandidate: {
        findMany: async () => [row(STALE_ID, stalePayload), row(VALID_ID, validPayload)],
      },
      dataExportPlan: {},
    };
    const repo = new DataExportCandidateRepository(db as never);

    const listed = await repo.listActiveForActor({
      companyId: COMPANY_ID,
      userId: USER_ID,
      chatId: CHAT_ID,
      now: NOW,
    });

    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.equal(listed.value.length, 1);
    assert.equal(listed.value[0]!.id, VALID_ID);
    assert.equal(listed.value[0]!.payload.source.kind, 'semrush_snapshot');
  });
});
