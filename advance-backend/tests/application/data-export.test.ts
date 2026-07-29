import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transformExportPage } from '../../src/application/data-export/data-export.sandbox.ts';
import {
  AirtableDataExportSource,
  ZohoBooksDataExportSource,
} from '../../src/application/data-export/data-export.sources.ts';
import {
  DataExportSourceRegistry,
  type DataExportJobPayload,
} from '../../src/application/data-export/data-export.types.ts';
import { DataExportWorker } from '../../src/application/data-export/data-export.worker.ts';
import {
  dataExportJobId,
  dataExportSpecHash,
} from '../../src/application/data-export/data-export.queue.ts';
import {
  configureDataExportProfile,
  readerDomainForAccount,
} from '../../src/application/data-export/data-export.profile.ts';
import { GOOGLE_SCOPE } from '../../src/domain/google/google-workspace-scope.ts';
import { asToolId } from '../../src/shared/ids.ts';
import { noopLogger } from '../tools/tool-test.helpers.ts';
import { createDataExportTool } from '../../src/application/orchestration/tools/families/data-export.tool.ts';
import { recoverCompletedExport } from '../../src/application/data-export/google-workspace-export.sink.ts';
import { ZohoBooksPaginatedClient } from '../../src/infrastructure/zoho/zoho-books-paginated.client.ts';

describe('data export sandbox', () => {
  it('maps and filters rows without network, process, or host filesystem globals', async () => {
    const rows = await transformExportPage(
      [{ amount: 10 }, { amount: 25 }],
      {
        script: `
          if (typeof fetch !== "undefined" || typeof process !== "undefined" || typeof require !== "undefined") {
            throw new Error("host capability leaked");
          }
          if (row.amount < args.minimum) return null;
          return { sequence: index, doubled: row.amount * 2 };
        `,
        args: { minimum: 20 },
      },
      4,
    );
    assert.deepEqual(rows, [{ sequence: 5, doubled: 50 }]);
  });

  it('rejects non-object output and unbounded row expansion', async () => {
    await assert.rejects(
      () => transformExportPage([{ id: 1 }], { script: 'return "raw"' }, 0),
      /must return objects/i,
    );
    await assert.rejects(
      () => transformExportPage(
        [{ id: 1 }],
        { script: 'return Array.from({ length: 11 }, () => ({ id: row.id }))' },
        0,
      ),
      /more than 10x/i,
    );
  });

  it('contains constructor escapes inside a credentialless, networkless child', async () => {
    await assert.rejects(
      () => transformExportPage(
        [{ value: 1 }],
        {
          script: 'return { host: row.constructor.constructor("return process")() };',
        },
        0,
      ),
      /code generation from strings disallowed/i,
    );
  });
});

describe('data export source adapters', () => {
  it('pages Airtable through the backend connection and preserves sparse fields', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const adapter = new AirtableDataExportSource(async () => ({
      status: 'resolved' as const,
      connection: {
        client: {
          describeTool: async () => null,
          callTool: async () => { throw new Error('MCP should not handle this REST-compatible export'); },
          listFieldNamesForTable: async () => new Map([['fldName', 'Name'], ['fldLate', 'Late field']]),
          listRecordsPage: async (input) => {
            calls.push(input);
            return input.offset
              ? { records: [{ id: 'rec2', fields: { fldLate: 'second page' } }] }
              : { records: [{ id: 'rec1', fields: { fldName: 'first' } }], nextCursor: 'next' };
          },
        },
      },
    }));
    const pages = [];
    for await (const page of adapter.read({
      kind: 'airtable_records',
      connectionId: '11111111-1111-4111-8111-111111111111',
      toolId: 'airtableRecords',
      nativeTool: 'list_records_for_table',
      input: { baseId: 'app1', tableId: 'tbl1', maxRecords: 1 },
    }, { companyId: 'co-1', userId: 'user-1' })) {
      pages.push(page);
    }
    assert.deepEqual(calls, [
      { baseId: 'app1', tableId: 'tbl1' },
      { baseId: 'app1', tableId: 'tbl1', offset: 'next' },
    ]);
    assert.deepEqual(pages.flatMap((page) => page.rows), [
      { 'Record ID': 'rec1', Name: 'first' },
      { 'Record ID': 'rec2', 'Late field': 'second page' },
    ]);
    assert.equal(pages[0]?.hasMore, true);
    assert.equal(pages[1]?.hasMore, undefined);
  });

  it('keeps Airtable view filters on the governed MCP path', async () => {
    const calls: Array<{ nativeTool: string; input: Record<string, unknown> }> = [];
    const adapter = new AirtableDataExportSource(async () => ({
      status: 'resolved' as const,
      connection: {
        client: {
          describeTool: async () => null,
          listRecordsPage: async () => {
            throw new Error('REST must not drop viewId');
          },
          callTool: async (nativeTool, input) => {
            calls.push({ nativeTool, input });
            return { records: [{ id: 'rec1', fields: { Name: 'Filtered' } }] };
          },
        },
      },
    }));
    const rows = [];
    for await (const page of adapter.read({
      kind: 'airtable_records',
      connectionId: '11111111-1111-4111-8111-111111111111',
      toolId: 'airtableRecords',
      nativeTool: 'list_records_for_table',
      input: { baseId: 'app1', tableId: 'tbl1', viewId: 'viw1' },
    }, { companyId: 'co-1', userId: 'user-1' })) {
      rows.push(...page.rows);
    }
    assert.deepEqual(calls, [{
      nativeTool: 'list_records_for_table',
      input: { baseId: 'app1', tableId: 'tbl1', viewId: 'viw1', pageSize: 1_000 },
    }]);
    assert.deepEqual(rows, [{ 'Record ID': 'rec1', Name: 'Filtered' }]);
  });

  it('pages Zoho Books without using listAllRecords', async () => {
    const pages: number[] = [];
    const adapter = new ZohoBooksDataExportSource({
      listRecords: async (input: any) => {
        pages.push(input.page);
        return {
          organizationId: 'org-1',
          items: [{ invoice_id: `inv-${input.page}`, total: input.page }],
          hasMore: input.page === 1,
          page: input.page,
        };
      },
    } as any);
    const rows = [];
    for await (const page of adapter.read({
      kind: 'zoho_books',
      connectionId: '11111111-1111-4111-8111-111111111111',
      module: 'invoices',
    }, { companyId: 'co-1', userId: 'user-1' })) {
      rows.push(...page.rows);
    }
    assert.deepEqual(pages, [1, 2]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.['_id'], 'inv-1');
  });

  it('maps canonical date filters to Zoho provider parameters', async () => {
    let capturedFilters: Record<string, unknown> | undefined;
    const adapter = new ZohoBooksDataExportSource({
      listRecords: async (input: any) => {
        capturedFilters = input.filters;
        return {
          organizationId: 'org-1',
          items: [],
          hasMore: false,
          page: input.page,
        };
      },
    } as any);
    for await (const _page of adapter.read({
      kind: 'zoho_books',
      connectionId: '11111111-1111-4111-8111-111111111111',
      module: 'expenses',
      filters: {
        dateFrom: '2026-07-01',
        dateTo: '2026-07-29',
        status: 'unbilled',
      },
    }, { companyId: 'co-1', userId: 'user-1' })) {
      // Exhaust the source so the request is captured.
    }

    assert.deepEqual(capturedFilters, {
      date_start: '2026-07-01',
      date_end: '2026-07-29',
      status: 'unbilled',
    });
  });

  it('rejects ambiguous canonical and provider date filters', async () => {
    const adapter = new ZohoBooksDataExportSource({
      listRecords: async () => assert.fail('ambiguous filters must fail before the request'),
    } as any);
    const consume = async () => {
      for await (const _page of adapter.read({
        kind: 'zoho_books',
        connectionId: '11111111-1111-4111-8111-111111111111',
        module: 'expenses',
        filters: {
          dateFrom: '2026-07-01',
          date_start: '2026-07-02',
        },
      }, { companyId: 'co-1', userId: 'user-1' })) {
        // No pages expected.
      }
    };

    await assert.rejects(consume, /both dateFrom and date_start/i);
  });

  it('marks an exact-cap Zoho status page as incomplete when another status remains', async () => {
    const adapter = new ZohoBooksDataExportSource({
      listRecords: async (input: any) => ({
        organizationId: 'org-1',
        items: Array.from({ length: 5_000 }, (_, index) => ({
          invoice_id: `${input.filters.status}-${index}`,
        })),
        hasMore: false,
        page: input.page,
      }),
    } as any);
    const pages = adapter.read({
      kind: 'zoho_books',
      connectionId: '11111111-1111-4111-8111-111111111111',
      module: 'invoices',
      filters: { status: 'paid,overdue' },
    }, { companyId: 'co-1', userId: 'user-1' })[Symbol.asyncIterator]();
    const firstPage = (await pages.next()).value;
    await pages.return?.();

    assert.equal(firstPage?.rows.length, 5_000);
    assert.equal(firstPage?.hasMore, true);
  });

  it('cancels an in-flight Zoho Books page request', async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = async (_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    };

    try {
      const client = new ZohoBooksPaginatedClient({
        getValidConnectionAuth: async () => ({
          accessToken: 'token',
          accountsBaseUrl: 'https://accounts.zoho.in',
          apiBaseUrl: 'https://www.zohoapis.in',
        }),
      } as any);
      const pending = client.listRecords({
        companyId: 'co-1',
        userId: 'user-1',
        connectionId: '11111111-1111-4111-8111-111111111111',
        moduleName: 'invoices',
        organizationId: 'org-1',
        page: 1,
        signal: controller.signal,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort(new Error('test export inactivity'));

      await assert.rejects(pending, /test export inactivity/i);
      assert.equal(requestSignal, controller.signal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('data export queue identity', () => {
  const base: DataExportJobPayload = {
    companyId: 'company-1',
    userId: 'user-1',
    source: {
      kind: 'zoho_books',
      connectionId: '11111111-1111-4111-8111-111111111111',
      module: 'invoices',
    },
    destination: { format: 'auto', title: 'Invoices' },
    chatId: 'oc_test',
    requestId: 'om_test',
  };

  it('allows only one distinct export specification per user request', () => {
    const second = {
      ...base,
      source: { ...base.source, module: 'bills' as const },
      destination: { ...base.destination, title: 'Bills' },
    };
    assert.equal(dataExportJobId(base), dataExportJobId(second));
    assert.notEqual(dataExportSpecHash(base), dataExportSpecHash(second));
    assert.notEqual(dataExportJobId(base), dataExportJobId({ ...base, requestId: 'om_next' }));
  });
});

describe('data export profile', () => {
  it('derives the allowed invoker domain from the selected Google account', async () => {
    let savedPolicy: unknown;
    const db = {
      integrationConnection: {
        findFirst: async () => ({
          id: '11111111-1111-4111-8111-111111111111',
          accountEmail: ' Divo@EmiacTech.com ',
          scopes: [GOOGLE_SCOPE.driveFull, GOOGLE_SCOPE.sheetsFull],
        }),
      },
      companyCapabilityGovernance: {
        upsert: async (input: any) => {
          savedPolicy = input.create.policyJson;
          return { configuredAt: new Date('2026-07-28T00:00:00.000Z'), configuredBy: 'admin-1', version: 1 };
        },
      },
    };
    const result = await configureDataExportProfile(db as any, {
      companyId: 'company-1',
      googleConnectionId: '11111111-1111-4111-8111-111111111111',
      configuredBy: 'admin-1',
    });
    assert.equal(result.profile.accountEmail, 'divo@emiactech.com');
    assert.equal(result.profile.readerDomain, 'emiactech.com');
    assert.deepEqual(savedPolicy, result.profile);
    assert.equal(readerDomainForAccount('ops@Example.COM'), 'example.com');
  });

  it('rejects a Google account without both Drive and Sheets write scopes', async () => {
    const db = {
      integrationConnection: {
        findFirst: async () => ({
          id: '11111111-1111-4111-8111-111111111111',
          accountEmail: 'divo@emiactech.com',
          scopes: [GOOGLE_SCOPE.driveFull],
        }),
      },
      companyCapabilityGovernance: { upsert: async () => assert.fail('must not persist') },
    };
    await assert.rejects(
      () => configureDataExportProfile(db as any, {
        companyId: 'company-1',
        googleConnectionId: '11111111-1111-4111-8111-111111111111',
        configuredBy: 'admin-1',
      }),
      /Drive write and Sheets write/i,
    );
  });
});

describe('Google export retry recovery', () => {
  it('recovers one completed job-keyed artifact without creating or deleting a file', async () => {
    let permissionCreates = 0;
    let fileDeletes = 0;
    const drive = {
      files: {
        list: async () => ({
          data: {
            files: [{
              id: 'file-1',
              webViewLink: 'https://drive.google.com/file/d/file-1/view',
              appProperties: {
                divoExportKey: 'job-1',
                divoExportState: 'complete',
                divoExportRowCount: '87044',
                divoExportTruncated: 'false',
                divoExportType: 'csv',
              },
            }],
          },
        }),
        delete: async () => { fileDeletes += 1; },
      },
      permissions: {
        list: async () => ({
          data: {
            permissions: [
              { type: 'user', role: 'owner', emailAddress: 'divo@emiactech.com' },
              { type: 'user', role: 'reader', emailAddress: 'abhishek@emiactech.com' },
            ],
          },
        }),
        create: async () => { permissionCreates += 1; },
      },
    };
    const recovered = await recoverCompletedExport(
      drive as any,
      'job-1',
      'abhishek@emiactech.com',
    );
    assert.equal(recovered?.artifactId, 'file-1');
    assert.equal(recovered?.rowCount, 87_044);
    assert.equal(permissionCreates, 0);
    assert.equal(fileDeletes, 0);
  });
});

describe('data export worker', () => {
  const payload: DataExportJobPayload = {
    companyId: 'company-1',
    userId: 'user-1',
    source: {
      kind: 'airtable_records',
      connectionId: '11111111-1111-4111-8111-111111111111',
      toolId: 'airtableRecords',
      nativeTool: 'list_records_for_table',
      input: { baseId: 'app1', tableId: 'tbl1' },
    },
    transform: { script: 'return { name: row.Name, rowNumber: index + 1 }' },
    destination: { format: 'auto', title: 'Orders' },
    chatId: 'oc_test',
    requestId: 'om_test',
  };
  const createWorker = (input: {
    registry: DataExportSourceRegistry;
    sink: { write: (input: any) => Promise<any> };
    larkAdapter: {
      sendToChatId: (...args: any[]) => Promise<any>;
      updateMessageById: (...args: any[]) => Promise<any>;
    };
    inactivityMs?: number;
    maxRows?: number;
  }) => new DataExportWorker({
    redisUrl: 'redis://unused',
    sources: input.registry,
    sink: input.sink as any,
    identityRepo: {
      resolveByUserId: async () => ({
        ok: true as const,
        value: {
          userId: 'user-1',
          companyId: 'company-1',
          aiRole: 'MEMBER',
          channel: 'lark',
          email: 'abhishek@emiactech.com',
        },
      }),
    },
    permissions: {
      resolve: async () => ({
        ok: true as const,
        value: {
          allowedToolIds: new Set([asToolId('dataExport'), asToolId('airtableRecords')]),
          allowedActionsByTool: new Map([
            [asToolId('dataExport'), new Set(['create'])],
            [asToolId('airtableRecords'), new Set(['read'])],
          ]),
          decisions: [],
        },
      }),
    } as any,
    resolveGoogleAuth: async () => ({ accessToken: 'short-lived', readerDomain: 'emiactech.com' }),
    larkAdapter: input.larkAdapter as any,
    logger: noopLogger,
    ...(input.inactivityMs === undefined ? {} : { inactivityMs: input.inactivityMs }),
    ...(input.maxRows === undefined ? {} : { maxRows: input.maxRows }),
  });

  it('shares only with the verified invoker, then persists before delivery', async () => {
    const registry = new DataExportSourceRegistry();
    registry.register({
      kind: 'airtable_records',
      async *read() {
        yield { rows: [{ Name: 'One' }, { Name: 'Two' }] };
      },
    });
    const updates: DataExportJobPayload[] = [];
    const progress: unknown[] = [];
    const delivered: string[] = [];
    const edited: string[] = [];
    const worker = new DataExportWorker({
      redisUrl: 'redis://unused',
      sources: registry,
      sink: {
        write: async (input: any) => {
          assert.equal(input.readerEmail, 'abhishek@emiactech.com');
          const rows = [];
          for await (const page of input.rows) rows.push(...page);
          assert.deepEqual(rows, [
            { name: 'One', rowNumber: 1 },
            { name: 'Two', rowNumber: 2 },
          ]);
          return {
            success: true as const,
            artifactId: 'sheet-1',
            artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
            artifactType: 'google_sheet' as const,
            rowCount: 2,
            sourceTruncated: false,
            sharedWith: 'abhishek@emiactech.com (reader)',
            verified: true as const,
          };
        },
      } as any,
      identityRepo: {
        resolveByUserId: async () => ({
          ok: true as const,
          value: {
            userId: 'user-1',
            companyId: 'company-1',
            aiRole: 'MEMBER',
            channel: 'lark',
            email: 'Abhishek@EmiacTech.com',
          },
        }),
      },
      permissions: {
        resolve: async () => ({
          ok: true as const,
          value: {
            allowedToolIds: new Set([asToolId('dataExport'), asToolId('airtableRecords')]),
            allowedActionsByTool: new Map([
              [asToolId('dataExport'), new Set(['create'])],
              [asToolId('airtableRecords'), new Set(['read'])],
            ]),
            decisions: [],
          },
        }),
      } as any,
      resolveGoogleAuth: async () => ({ accessToken: 'short-lived', readerDomain: 'emiactech.com' }),
      larkAdapter: {
        sendToChatId: async (_chatId, content) => {
          delivered.push(content);
          return { ok: true as const, value: 'om-delivered' };
        },
        updateMessageById: async (_messageId, content) => {
          edited.push(content);
          return { ok: true as const, value: undefined };
        },
      },
      logger: noopLogger,
    });
    await worker.processJob({
      id: dataExportJobId(payload),
      data: payload,
      attemptsMade: 0,
      opts: { attempts: 3 },
      updateData: async (updated) => { updates.push(updated); },
      updateProgress: async (value) => { progress.push(value); },
    });
    assert.equal(updates[0]?.progressMessageId, 'om-delivered');
    assert.equal(updates.at(-1)?.completedExport?.artifactId, 'sheet-1');
    assert.deepEqual(progress, [
      { stage: 'reading', pagesRead: 1, rowsRead: 2 },
      { stage: 'writing', pagesRead: 1, rowsRead: 2 },
      { stage: 'completed', pagesRead: 1, rowsRead: 2, rowsExported: 2 },
    ]);
    assert.match(delivered[0] ?? '', /Data export in progress/i);
    assert.match(edited.at(-1) ?? '', /Open export|Data export ready/i);
  });

  it('fails before reading the source when the invoker email is outside the configured domain', async () => {
    let sourceRead = false;
    let failureDelivered = false;
    const registry = new DataExportSourceRegistry();
    registry.register({
      kind: 'airtable_records',
      async *read() {
        sourceRead = true;
        yield { rows: [] };
      },
    });
    const worker = new DataExportWorker({
      redisUrl: 'redis://unused',
      sources: registry,
      sink: { write: async () => { throw new Error('sink must not run'); } } as any,
      identityRepo: {
        resolveByUserId: async () => ({
          ok: true as const,
          value: {
            userId: 'user-1',
            companyId: 'company-1',
            aiRole: 'MEMBER',
            channel: 'lark',
            email: 'outsider@example.com',
          },
        }),
      },
      permissions: {
        resolve: async () => ({
          ok: true as const,
          value: {
            allowedToolIds: new Set([asToolId('dataExport'), asToolId('airtableRecords')]),
            allowedActionsByTool: new Map([
              [asToolId('dataExport'), new Set(['create'])],
              [asToolId('airtableRecords'), new Set(['read'])],
            ]),
            decisions: [],
          },
        }),
      } as any,
      resolveGoogleAuth: async () => ({ accessToken: 'unused', readerDomain: 'emiactech.com' }),
      larkAdapter: {
        sendToChatId: async () => ({ ok: true as const, value: 'om-progress' }),
        updateMessageById: async (_messageId, content) => {
          failureDelivered = /Data export failed/i.test(content);
          return { ok: true as const, value: undefined };
        },
      },
      logger: noopLogger,
    });
    await assert.rejects(
      () => worker.processJob({
        id: dataExportJobId(payload),
        data: payload,
        attemptsMade: 0,
        opts: { attempts: 3 },
        updateData: async () => undefined,
        updateProgress: async () => undefined,
      }),
      /verified emiactech\.com invoker/i,
    );
    assert.equal(sourceRead, false);
    assert.equal(failureDelivered, true, 'deterministic policy failures must not wait for retries');
  });

  it('keeps a progressing export alive beyond the inactivity window and aborts a stalled source', async () => {
    const { transform: _transform, ...untransformedPayload } = payload;
    const progressing = new DataExportSourceRegistry();
    progressing.register({
      kind: 'airtable_records',
      async *read() {
        for (let index = 0; index < 4; index += 1) {
          await new Promise(resolve => setTimeout(resolve, 15));
          yield { rows: [{ index }] };
        }
      },
    });
    const completion = {
      success: true as const,
      artifactId: 'csv-1',
      artifactUrl: 'https://drive.google.com/file/d/csv-1/view',
      artifactType: 'csv' as const,
      rowCount: 4,
      sourceTruncated: false,
      sharedWith: 'abhishek@emiactech.com (reader)',
      verified: true as const,
    };
    const sink = {
      write: async (input: any) => {
        for await (const _page of input.rows) {
          await input.onProgress?.({ stage: 'writing', rowsProcessed: 1 });
        }
        return completion;
      },
    };
    const larkAdapter = {
      sendToChatId: async () => ({ ok: true as const, value: 'om-progress' }),
      updateMessageById: async () => ({ ok: true as const, value: undefined }),
    };
    const worker = createWorker({ registry: progressing, sink, larkAdapter, inactivityMs: 25 });
    await worker.processJob({
      id: dataExportJobId(untransformedPayload),
      data: untransformedPayload,
      attemptsMade: 0,
      opts: { attempts: 1 },
      updateData: async () => undefined,
      updateProgress: async () => undefined,
    });

    let failureCard = '';
    const stalled = new DataExportSourceRegistry();
    stalled.register({
      kind: 'airtable_records',
      async *read(_source, context) {
        await new Promise((_, reject) => {
          context.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true });
        });
      },
    });
    const stalledWorker = createWorker({
      registry: stalled,
      sink,
      larkAdapter: {
        sendToChatId: larkAdapter.sendToChatId,
        updateMessageById: async (_messageId, card) => {
          failureCard = card;
          return { ok: true as const, value: undefined };
        },
      },
      inactivityMs: 20,
    });
    await assert.rejects(
      () => stalledWorker.processJob({
        id: 'stalled-job',
        data: untransformedPayload,
        attemptsMade: 0,
        opts: { attempts: 1 },
        updateData: async () => undefined,
        updateProgress: async () => undefined,
      }),
      /no progress/i,
    );
    assert.match(failureCard, /Data export failed/i);
  });

  it('never sends a second terminal card when the tracker edit fails', async () => {
    const registry = new DataExportSourceRegistry();
    registry.register({
      kind: 'airtable_records',
      async *read() {
        yield { rows: [{ Name: 'One' }] };
      },
    });
    let sends = 0;
    const worker = createWorker({
      registry,
      sink: {
        write: async (input) => {
          for await (const _page of input.rows) { /* consume source */ }
          return {
            success: true,
            artifactId: 'sheet-1',
            artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
            artifactType: 'google_sheet',
            rowCount: 1,
            sourceTruncated: false,
            sharedWith: 'abhishek@emiactech.com (reader)',
            verified: true,
          };
        },
      },
      larkAdapter: {
        sendToChatId: async () => {
          sends += 1;
          return { ok: true as const, value: 'om-progress' };
        },
        updateMessageById: async () => ({ ok: false as const, error: new Error('tracker edit failed') }),
      },
    });
    await assert.rejects(
      () => worker.processJob({
        id: dataExportJobId(payload),
        data: payload,
        attemptsMade: 0,
        opts: { attempts: 1 },
        updateData: async () => undefined,
        updateProgress: async () => undefined,
      }),
      /tracker edit failed/i,
    );
    assert.equal(sends, 1);
  });

  it('applies one central source/output row cap and marks the artifact truncated', async () => {
    const { transform: _transform, ...untransformedPayload } = payload;
    const registry = new DataExportSourceRegistry();
    registry.register({
      kind: 'airtable_records',
      async *read() {
        yield { rows: [{ id: 1 }, { id: 2 }], hasMore: true };
        yield { rows: [{ id: 3 }, { id: 4 }], hasMore: true };
        assert.fail('worker must stop pulling source pages at the central cap');
      },
    });
    let writtenRows: Array<Record<string, unknown>> = [];
    let truncated = false;
    const worker = createWorker({
      registry,
      maxRows: 3,
      sink: {
        write: async (input) => {
          for await (const page of input.rows) writtenRows.push(...page);
          truncated = input.sourceTruncated();
          return {
            success: true,
            artifactId: 'sheet-capped',
            artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-capped/edit',
            artifactType: 'google_sheet',
            rowCount: writtenRows.length,
            sourceTruncated: truncated,
            sharedWith: 'abhishek@emiactech.com (reader)',
            verified: true,
          };
        },
      },
      larkAdapter: {
        sendToChatId: async () => ({ ok: true as const, value: 'om-progress' }),
        updateMessageById: async () => ({ ok: true as const, value: undefined }),
      },
    });
    await worker.processJob({
      id: 'capped-job',
      data: untransformedPayload,
      attemptsMade: 0,
      opts: { attempts: 1 },
      updateData: async () => undefined,
      updateProgress: async () => undefined,
    });
    assert.deepEqual(writtenRows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    assert.equal(truncated, true);
  });
});

describe('data export access contract', () => {
  const tool = createDataExportTool({
    queue: { enqueue: async () => 'unused' },
  });
  const base = {
    source: {
      kind: 'zoho_books',
      connectionId: '11111111-1111-4111-8111-111111111111',
      module: 'invoices',
    },
    destination: { format: 'auto', title: 'Invoices' },
  };

  it('has no model-controlled sharing or access option', () => {
    assert.equal(tool.argsSchema.safeParse(base).success, true);
    assert.equal(tool.argsSchema.safeParse({
      ...base,
      destination: { ...base.destination, access: 'company' },
    }).success, false);
    assert.equal(tool.argsSchema.safeParse({ ...base, recipients: ['other@emiactech.com'] }).success, false);
  });
});
