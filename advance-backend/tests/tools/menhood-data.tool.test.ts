import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MenhoodQueryServiceError } from '../../src/application/menhood/menhood-query.service.ts';
import { createMenhoodDataTool } from '../../src/application/tools/families/menhood-data.tool.ts';
import { makeAllowedPerm, makeCtx, makeDeniedPerm } from './tool-test.helpers.ts';

const result = {
  columns: [{ name: 'orders', dataTypeId: 20 }],
  rows: [{ orders: '134418' }],
  coverage: { returnedRows: 1, truncated: false },
  elapsedMs: 12,
  queryFingerprint: 'a'.repeat(64),
};

const createTool = (overrides: Record<string, unknown> = {}) => createMenhoodDataTool({
  service: {
    preflight: () => undefined,
    execute: async () => result,
  },
  ...overrides,
} as Parameters<typeof createMenhoodDataTool>[0]);

describe('Menhood Data tool', () => {
  it('requires inherited Menhood read permission', () => {
    const tool = createTool();
    const args = { sql: 'SELECT count(*) FROM menhood_orders' };
    assert.equal(tool.permissionCheck(args, makeDeniedPerm()).ok, false);
    assert.deepEqual(tool.permissionCheck(args, makeAllowedPerm('menhoodData', ['read'])), { ok: true, value: 'read' });
  });

  it('preflights configuration, company binding, and AST validation without querying', async () => {
    let executions = 0;
    const tool = createTool({
      service: {
        preflight: () => undefined,
        execute: async () => { executions += 1; return result; },
      },
    });
    const ready = await tool.preflight?.(
      { sql: 'SELECT count(*) FROM menhood_orders' },
      makeCtx('menhoodData', ['read']),
    );
    assert.equal(ready?.ok, true);
    assert.equal(executions, 0);

    const invalid = await tool.preflight?.(
      { sql: 'DELETE FROM menhood_orders' },
      makeCtx('menhoodData', ['read']),
    );
    assert.equal(invalid?.ok, false);
  });

  it('returns the structured bounded result and audits metadata without SQL, values, or rows', async () => {
    const records: unknown[] = [];
    const tool = createTool({ audit: { record: (record: unknown) => { records.push(record); } } });
    const output = await tool.execute(
      { sql: 'SELECT count(*) AS orders FROM menhood_orders WHERE status = $1', parameters: ['Delivered'] },
      makeCtx('menhoodData', ['read']),
    );
    assert.equal(output.ok, true);
    if (output.ok) {
      assert.equal(output.value.status, 'complete');
      assert.deepEqual(output.value.preview.columns, ['orders']);
      assert.deepEqual(output.value.preview.rows, result.rows);
      assert.deepEqual(output.value.preview.coverage, { kind: 'complete', totalRows: 1 });
    }
    assert.equal(records.length, 1);
    const serialized = JSON.stringify(records[0]);
    assert.match(serialized, /queryFingerprint/);
    assert.match(serialized, /menhood_orders/);
    assert.doesNotMatch(serialized, /SELECT|Delivered|134418/);
  });

  it('maps disabled, wrong-company, timeout, and provider failures to stable tool errors', async () => {
    for (const [code, expected] of [
      ['unavailable_connection', 'upstream_failure'],
      ['timeout', 'timeout'],
      ['provider_failure', 'upstream_failure'],
    ] as const) {
      const tool = createTool({
        service: {
          preflight: () => undefined,
          execute: async () => { throw new MenhoodQueryServiceError(code, 'stable message'); },
        },
      });
      const output = await tool.execute(
        { sql: 'SELECT count(*) FROM menhood_orders' },
        makeCtx('menhoodData', ['read']),
      );
      assert.equal(output.ok, false);
      if (!output.ok) {
        assert.equal(output.error.payload.reason, expected);
        assert.equal(output.error.message, 'stable message');
      }
    }
  });

  it('audits safe query identity when a validated execution times out', async () => {
    const records: unknown[] = [];
    const tool = createTool({
      audit: { record: (record: unknown) => { records.push(record); } },
      service: {
        preflight: () => undefined,
        execute: async () => { throw new MenhoodQueryServiceError('timeout', 'stable message'); },
      },
    });
    const output = await tool.execute(
      { sql: 'SELECT count(*) FROM menhood_orders WHERE status = $1', parameters: ['Delivered'] },
      makeCtx('menhoodData', ['read']),
    );

    assert.equal(output.ok, false);
    assert.equal(records.length, 1);
    const audit = records[0] as { outcome: string; metadata: Record<string, unknown> };
    assert.equal(audit.outcome, 'failure');
    assert.equal(audit.metadata.returnedRows, 0);
    assert.deepEqual(audit.metadata.tables, ['menhood_orders']);
    assert.match(String(audit.metadata.queryFingerprint), /^[a-f0-9]{64}$/);
    assert.equal(typeof audit.metadata.latencyMs, 'number');
    const serialized = JSON.stringify(audit);
    assert.doesNotMatch(serialized, /SELECT|Delivered/);
  });

  it('creates one opaque governed offer from the validated query without storing preview rows', async () => {
    const payloads: unknown[] = [];
    const tool = createTool({
      offers: {
        createAuthorizedOffer: async (payload: unknown) => {
          payloads.push(payload);
          return { offerId: '11111111-1111-4111-8111-111111111111', expiresAt: new Date() };
        },
      },
    });
    const ctx = makeCtx('menhoodData', ['read'], {
      chatId: 'chat-1',
      requestId: 'request-1',
      runtimeRunId: 'run-1',
      runtimeThreadId: 'thread-1',
    });
    ctx.perm.allowedToolIds.add('dataExport' as never);
    ctx.perm.allowedActionsByTool.set('dataExport' as never, new Set(['create']));
    const output = await tool.execute(
      { sql: 'SELECT * FROM menhood_products WHERE category = $1', parameters: ['Hair'], exportTitle: 'Products' },
      ctx,
    );
    assert.equal(output.ok, true);
    if (output.ok) assert.equal(output.value.preview.exportOfferId, '11111111-1111-4111-8111-111111111111');
    assert.equal(payloads.length, 1);
    const payload = payloads[0] as {
      source: { kind: string; connectionId: string; query: { sql: string; parameters: unknown[] }; queryFingerprint: string };
      destination: { title: string };
      requestId: string;
    };
    assert.equal(payload.source.kind, 'menhood_query');
    assert.equal(payload.source.connectionId, 'backend_managed');
    assert.deepEqual(payload.source.query.parameters, ['Hair']);
    assert.match(payload.source.queryFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(payload.destination.title, 'Products');
    assert.equal(payload.requestId, 'run-1');
    assert.doesNotMatch(JSON.stringify(payload), /134418/);
  });
});
