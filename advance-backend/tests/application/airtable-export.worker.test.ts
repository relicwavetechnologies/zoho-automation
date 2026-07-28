import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AirtableExportWorker } from '../../src/application/airtable/airtable-export.worker.ts';
import {
  airtableExportJobId,
  type AirtableExportJobPayload,
} from '../../src/application/airtable/airtable-export.queue.ts';
import { makeAllowedPerm, makeDeniedPerm, noopLogger } from '../tools/tool-test.helpers.ts';

const payload: AirtableExportJobPayload = {
  companyId: 'company-1',
  userId: 'user-1',
  connectionId: '11111111-1111-4111-8111-111111111111',
  toolId: 'airtableRecords',
  nativeTool: 'list_records_for_table',
  input: { baseId: 'app1', tableId: 'tbl1' },
  chatId: 'oc_test',
  requestId: 'om_test',
};

function fakeJob(
  data: AirtableExportJobPayload,
  updates: AirtableExportJobPayload[],
  attemptsMade = 0,
) {
  return {
    id: airtableExportJobId(data),
    data,
    attemptsMade,
    opts: { attempts: 3 },
    updateData: async (updated: AirtableExportJobPayload) => {
      updates.push(updated);
    },
  } as any;
}

describe('AirtableExportWorker', () => {
  it('re-checks identity and RBAC, exports once, persists completion, then delivers with idempotency', async () => {
    const updates: AirtableExportJobPayload[] = [];
    const sends: Array<{ chatId: string; content: string; key?: string }> = [];
    let connectionChecks = 0;
    const worker = new AirtableExportWorker({
      redisUrl: 'redis://unused',
      identityRepo: {
        resolveByUserId: async () => ({
          ok: true as const,
          value: { userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER', channel: 'lark' },
        }),
      },
      permissions: {
        resolve: async () => ({ ok: true as const, value: makeAllowedPerm('airtableRecords', ['read']) }),
      } as any,
      getConnection: async () => {
        connectionChecks += 1;
        return {
          status: 'resolved' as const,
          connection: {
            client: {
              describeTool: async () => null,
              callTool: async () => ({ records: [] }),
              listRecordsPage: async () => ({
                records: [{ id: 'rec1', fields: { Name: 'Order 1' } }],
              }),
            },
          },
        };
      },
      cloudinary: {
        isAvailable: true,
        uploadCsvBuffer: async () => ({
          publicId: 'temp_exports/company-1/export.csv',
          signedUrl: 'https://example.test/export.csv',
          expiresAt: '2026-07-29T00:00:00.000Z',
        }),
      } as any,
      larkAdapter: {
        sendToChatId: async (chatId, content, _reply, key) => {
          sends.push({ chatId, content, ...(key ? { key } : {}) });
          return { ok: true as const, value: 'om_delivered' };
        },
      },
      logger: noopLogger,
      csvLinkTtl: 86_400,
    });

    await worker.processJob(fakeJob(payload, updates));

    assert.equal(connectionChecks, 1);
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.completedExport?.totalFetched, 1);
    assert.equal(updates[0]?.completedExport?.csvLink, 'https://example.test/export.csv');
    assert.equal(sends.length, 1);
    assert.equal(sends[0]?.chatId, 'oc_test');
    assert.match(sends[0]?.content ?? '', /Download CSV/);
    assert.match(sends[0]?.key ?? '', /^atxd_/);
    assert.ok((sends[0]?.key?.length ?? 0) <= 50);
  });

  it('redelivers a persisted completion without re-reading Airtable', async () => {
    let identityChecks = 0;
    let connectionChecks = 0;
    const updates: AirtableExportJobPayload[] = [];
    const keys: string[] = [];
    const completedPayload: AirtableExportJobPayload = {
      ...payload,
      completedExport: {
        success: true,
        message: 'done',
        csvLink: 'https://example.test/export.csv',
        totalFetched: 10,
        sourceTruncated: false,
      },
    };
    const worker = new AirtableExportWorker({
      redisUrl: 'redis://unused',
      identityRepo: {
        resolveByUserId: async () => {
          identityChecks += 1;
          return { ok: true as const, value: null };
        },
      },
      permissions: {} as any,
      getConnection: async () => {
        connectionChecks += 1;
        return { status: 'unavailable' as const };
      },
      cloudinary: { isAvailable: true } as any,
      larkAdapter: {
        sendToChatId: async (_chat, _content, _reply, key) => {
          if (key) keys.push(key);
          return { ok: true as const, value: 'om_delivered' };
        },
      },
      logger: noopLogger,
      csvLinkTtl: 86_400,
    });

    await worker.processJob(fakeJob(completedPayload, updates, 1));

    assert.equal(identityChecks, 0);
    assert.equal(connectionChecks, 0);
    assert.equal(updates.length, 0);
    assert.equal(keys.length, 1);
    assert.match(keys[0] ?? '', /^atxd_/);
  });

  it('states that no CSV was created when no records matched', async () => {
    const cards: string[] = [];
    const completedPayload: AirtableExportJobPayload = {
      ...payload,
      completedExport: {
        success: true,
        message: 'No Airtable records matched the request, so no CSV was created.',
        totalFetched: 0,
        sourceTruncated: false,
      },
    };
    const worker = new AirtableExportWorker({
      redisUrl: 'redis://unused',
      identityRepo: { resolveByUserId: async () => ({ ok: true as const, value: null }) },
      permissions: {} as any,
      getConnection: async () => ({ status: 'unavailable' as const }),
      cloudinary: { isAvailable: true } as any,
      larkAdapter: {
        sendToChatId: async (_chat, content) => {
          cards.push(content);
          return { ok: true as const, value: 'om_delivered' };
        },
      },
      logger: noopLogger,
      csvLinkTtl: 86_400,
    });

    await worker.processJob(fakeJob(completedPayload, []));

    assert.equal(cards.length, 1);
    assert.match(cards[0] ?? '', /no CSV was created/i);
  });

  it('fails closed before connection resolution when read permission was revoked', async () => {
    let connectionChecks = 0;
    const sentCards: string[] = [];
    const worker = new AirtableExportWorker({
      redisUrl: 'redis://unused',
      identityRepo: {
        resolveByUserId: async () => ({
          ok: true as const,
          value: { userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER', channel: 'lark' },
        }),
      },
      permissions: {
        resolve: async () => ({ ok: true as const, value: makeDeniedPerm() }),
      } as any,
      getConnection: async () => {
        connectionChecks += 1;
        return { status: 'unavailable' as const };
      },
      cloudinary: { isAvailable: true } as any,
      larkAdapter: {
        sendToChatId: async (_chat, content) => {
          sentCards.push(content);
          return { ok: true as const, value: 'om_failed' };
        },
      },
      logger: noopLogger,
      csvLinkTtl: 86_400,
    });
    const job = fakeJob(payload, [], 2);

    await assert.rejects(() => worker.processJob(job), /permission was revoked/);
    assert.equal(connectionChecks, 0);
    assert.equal(sentCards.length, 1);
    assert.match(sentCards[0] ?? '', /export failed/i);
  });

  it('builds the same queue id for equivalent input objects', () => {
    const reordered: AirtableExportJobPayload = {
      ...payload,
      input: { tableId: 'tbl1', baseId: 'app1' },
    };
    assert.equal(airtableExportJobId(payload), airtableExportJobId(reordered));
  });
});
