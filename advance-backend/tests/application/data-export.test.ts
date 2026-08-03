import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { transformExportPage } from '../../src/application/data-export/data-export.sandbox.ts';
import {
  AirtableDataExportSource,
  MenhoodQueryDataExportSource,
  SemrushSnapshotDataExportSource,
  ZohoBooksDataExportSource,
  ZohoCrmDataExportSource,
} from '../../src/application/data-export/data-export.sources.ts';
import type { DataExportJobPayload } from '../../src/application/data-export/data-export.types.ts';
import { DatasetSourceRegistry } from '../../src/application/data-export/data-export.source-registry.ts';
import { DataExportWorker } from '../../src/application/data-export/data-export.worker.ts';
import { PermanentDataExportError } from '../../src/application/data-export/data-export.errors.ts';
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
import { makeCtx, noopLogger } from '../tools/tool-test.helpers.ts';
import { createDataExportTool } from '../../src/application/tools/families/data-export.tool.ts';
import { recoverCompletedExport } from '../../src/application/data-export/google-workspace-export.sink.ts';
import type { DataExportDestinationSink } from '../../src/application/data-export/data-export.destination.ts';
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
  it('delegates backend-managed Menhood query replay as streaming pages', async () => {
    const controller = new AbortController();
    const calls: unknown[][] = [];
    const adapter = new MenhoodQueryDataExportSource({
      streamExportPages: async function* (companyId, query, fingerprint, signal) {
        calls.push([companyId, query, fingerprint, signal]);
        yield { rows: [{ id: 1 }], hasMore: true };
        yield { rows: [{ id: 2 }] };
      },
    });
    const source = {
      kind: 'menhood_query' as const,
      connectionId: 'backend_managed' as const,
      query: { sql: 'SELECT id FROM menhood_orders ORDER BY id' },
      queryFingerprint: 'a'.repeat(64),
    };
    const pages = [];

    for await (const page of adapter.read(source, {
      companyId: 'company-1',
      userId: 'user-1',
      signal: controller.signal,
    })) pages.push(page);

    assert.deepEqual(calls, [[
      'company-1',
      source.query,
      source.queryFingerprint,
      controller.signal,
    ]]);
    assert.deepEqual(pages, [
      { rows: [{ id: 1 }], hasMore: true },
      { rows: [{ id: 2 }] },
    ]);
  });

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

  it('reports a provider limit once, on the CRM page that ends the stream', async () => {
    /*
     * The worker turns the last page's provider-limit coverage into the final
     * receipt. Setting it on every chunk would wrongly describe a complete
     * export; setting it on none would present a capped export as the whole
     * module.
     */
    const adapter = new ZohoCrmDataExportSource({
      listAllRecords: async () => ({
        items: Array.from({ length: 1_200 }, (_, i) => ({ id: `deal-${i}` })),
        truncated: true,
      }),
    } as any);

    const coverage = [];
    let rows = 0;
    for await (const page of adapter.read({
      kind: 'zoho_crm',
      connectionId: '11111111-1111-4111-8111-111111111111',
      module: 'Deals',
    }, { companyId: 'co-1', userId: 'user-1' })) {
      coverage.push(page.coverage);
      rows += page.rows.length;
    }

    assert.equal(rows, 1_200);
    assert.deepEqual(coverage, [
      undefined,
      undefined,
      { outcome: 'partial', cause: 'provider_limit' },
    ]);
  });

  it('treats a satisfied non-paged Semrush row request as an intentional window', async () => {
    const adapter = new SemrushSnapshotDataExportSource({
      execute: async () => ({
        operation: 'keyword_gap',
        status: 'partial',
        coverage: {},
        rows: Array.from({ length: 250 }, (_, index) => ({ keyword: `term-${index}` })),
      }),
    } as any);
    const pages = [];
    for await (const page of adapter.read({
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args: { operation: 'keyword_gap', targets: ['a.com', 'b.com'], limit: 250 },
    }, {})) {
      pages.push(page);
    }

    assert.equal(pages[0]?.requestedRows, 250);
    assert.deepEqual(pages[0]?.coverage, {
      outcome: 'requested_window_satisfied',
      requestedRows: 250,
    });
  });

  it('does not claim truncation when the CRM returned the whole module', async () => {
    const adapter = new ZohoCrmDataExportSource({
      listAllRecords: async () => ({ items: [{ id: 'deal-1' }], truncated: false }),
    } as any);

    const pages = [];
    for await (const page of adapter.read({
      kind: 'zoho_crm',
      connectionId: '11111111-1111-4111-8111-111111111111',
      module: 'Deals',
    }, { companyId: 'co-1', userId: 'user-1' })) {
      pages.push(page);
    }

    assert.equal(pages.length, 1);
    assert.equal(pages[0]?.sourceTruncated, undefined);
    assert.equal(pages[0]?.hasMore, undefined);
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

describe('data export source registry', () => {
  it('dispatches by source kind and rejects an unregistered source', () => {
    const registry = new DatasetSourceRegistry();
    const airtable = {
      kind: 'airtable_records' as const,
      async *read() { yield { rows: [] }; },
    };
    const zohoBooks = {
      kind: 'zoho_books' as const,
      async *read() { yield { rows: [] }; },
    };
    registry.register(airtable);
    registry.register(zohoBooks);

    assert.equal(registry.resolve({
      kind: 'airtable_records',
      connectionId: '11111111-1111-4111-8111-111111111111',
      toolId: 'airtableRecords',
      nativeTool: 'list_records_for_table',
      input: {},
    }), airtable);
    assert.equal(registry.resolve({
      kind: 'zoho_books',
      connectionId: '11111111-1111-4111-8111-111111111111',
      module: 'invoices',
    }), zohoBooks);
    assert.throws(
      () => new DatasetSourceRegistry().resolve({
        kind: 'zoho_books',
        connectionId: '11111111-1111-4111-8111-111111111111',
        module: 'invoices',
      }),
      /unsupported data export source/i,
    );
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
    assert.notEqual(
      dataExportSpecHash(base),
      dataExportSpecHash({
        ...base,
        replyToMessageId: 'om_thread_root',
        replyInThread: true,
      }),
    );
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
      { kind: 'reader', email: 'abhishek@emiactech.com' },
    );
    assert.equal(recovered?.artifactId, 'file-1');
    assert.equal(recovered?.rowCount, 87_044);
    assert.equal(permissionCreates, 0);
    assert.equal(fileDeletes, 0);
  });

  it('falls back to the legacy truncation flag when stored partial coverage lacks a cause', async () => {
    const drive = {
      files: {
        list: async () => ({
          data: {
            files: [{
              id: 'file-legacy-coverage',
              webViewLink: 'https://drive.google.com/file/d/file-legacy-coverage/view',
              appProperties: {
                divoExportKey: 'job-legacy-coverage',
                divoExportState: 'complete',
                divoExportRowCount: '10',
                divoExportTruncated: 'true',
                divoExportCoverage: JSON.stringify({
                  inputRowsRead: 10,
                  rowsWritten: 10,
                  outcome: 'partial',
                }),
                divoExportType: 'csv',
              },
            }],
          },
        }),
        delete: async () => assert.fail('completed artifact must not be deleted'),
      },
      permissions: {
        list: async () => ({
          data: {
            permissions: [{ type: 'user', role: 'owner', emailAddress: 'member@gmail.com' }],
          },
        }),
        create: async () => assert.fail('owner exports must not create reader permissions'),
      },
    };

    const recovered = await recoverCompletedExport(
      drive as any,
      'job-legacy-coverage',
      { kind: 'owner', email: 'member@gmail.com' },
    );

    assert.equal(recovered?.coverage, undefined);
    assert.equal(recovered?.sourceTruncated, true);
  });

  it('recovers a completed Excel artifact with the same access checks', async () => {
    const drive = {
      files: {
        list: async () => ({
          data: {
            files: [{
              id: 'xlsx-1',
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              webViewLink: 'https://drive.google.com/file/d/xlsx-1/view',
              appProperties: {
                divoExportKey: 'job-xlsx',
                divoExportState: 'complete',
                divoExportRowCount: '25',
                divoExportTruncated: 'false',
                divoExportType: 'xlsx',
              },
            }],
          },
        }),
        delete: async () => assert.fail('completed artifact must not be deleted'),
      },
      permissions: {
        list: async () => ({
          data: {
            permissions: [
              { type: 'user', role: 'owner', emailAddress: 'member@gmail.com' },
            ],
          },
        }),
        create: async () => assert.fail('owner exports must not create reader permissions'),
      },
    };

    const recovered = await recoverCompletedExport(
      drive as any,
      'job-xlsx',
      { kind: 'owner', email: 'member@gmail.com' },
    );

    assert.equal(recovered?.artifactType, 'xlsx');
    assert.equal(recovered?.rowCount, 25);
  });

  it('does not recover an Excel-labelled artifact with a different Drive MIME type', async () => {
    let deleted = false;
    const drive = {
      files: {
        list: async () => ({
          data: {
            files: [{
              id: 'not-xlsx',
              mimeType: 'text/plain',
              appProperties: {
                divoExportKey: 'job-xlsx',
                divoExportState: 'complete',
                divoExportRowCount: '25',
                divoExportTruncated: 'false',
                divoExportType: 'xlsx',
              },
            }],
          },
        }),
        delete: async () => {
          deleted = true;
        },
      },
      permissions: {
        list: async () => assert.fail('invalid artifact must not be access-verified'),
        create: async () => assert.fail('invalid artifact must not be shared'),
      },
    };

    const recovered = await recoverCompletedExport(
      drive as any,
      'job-xlsx',
      { kind: 'owner', email: 'member@gmail.com' },
    );

    assert.equal(recovered, null);
    assert.equal(deleted, true);
  });

  it('rejects a recovered artifact with access beyond the verified invoker', async () => {
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
                divoExportRowCount: '10',
                divoExportTruncated: 'false',
                divoExportType: 'csv',
              },
            }],
          },
        }),
        delete: async () => assert.fail('completed artifact must not be deleted'),
      },
      permissions: {
        list: async () => ({
          data: {
            permissions: [
              { type: 'user', role: 'owner', emailAddress: 'divo@emiactech.com' },
              { type: 'user', role: 'reader', emailAddress: 'abhishek@emiactech.com' },
              { type: 'domain', role: 'reader', domain: 'emiactech.com' },
            ],
          },
        }),
        create: async () => assert.fail('verified invoker access already exists'),
      },
    };
    await assert.rejects(
      () => recoverCompletedExport(
        drive as any,
        'job-1',
        { kind: 'reader', email: 'abhishek@emiactech.com' },
      ),
      /access beyond the invoker/i,
    );
  });

  it('recovers a personal-account artifact only when that account is the sole owner', async () => {
    let permissionCreates = 0;
    const drive = {
      files: {
        list: async () => ({
          data: {
            files: [{
              id: 'file-personal',
              appProperties: {
                divoExportKey: 'job-personal',
                divoExportState: 'complete',
                divoExportRowCount: '4',
                divoExportTruncated: 'false',
                divoExportType: 'google_sheet',
              },
            }],
          },
        }),
        delete: async () => assert.fail('completed artifact must not be deleted'),
      },
      permissions: {
        list: async () => ({
          data: {
            permissions: [
              { type: 'user', role: 'owner', emailAddress: 'member@gmail.com' },
            ],
          },
        }),
        create: async () => { permissionCreates += 1; },
      },
    };

    const recovered = await recoverCompletedExport(
      drive as any,
      'job-personal',
      { kind: 'owner', email: 'member@gmail.com' },
    );

    assert.equal(recovered?.artifactId, 'file-personal');
    assert.equal(recovered?.sharedWith, 'member@gmail.com (owner)');
    assert.equal(permissionCreates, 0);
  });

  it('rejects a personal-account artifact that was shared beyond its owner', async () => {
    const drive = {
      files: {
        list: async () => ({
          data: {
            files: [{
              id: 'file-personal',
              appProperties: {
                divoExportKey: 'job-personal',
                divoExportState: 'complete',
                divoExportRowCount: '4',
                divoExportTruncated: 'false',
                divoExportType: 'google_sheet',
              },
            }],
          },
        }),
        delete: async () => assert.fail('completed artifact must not be deleted'),
      },
      permissions: {
        list: async () => ({
          data: {
            permissions: [
              { type: 'user', role: 'owner', emailAddress: 'member@gmail.com' },
              { type: 'user', role: 'reader', emailAddress: 'other@gmail.com' },
            ],
          },
        }),
        create: async () => assert.fail('owner exports must not create reader permissions'),
      },
    };

    await assert.rejects(
      () => recoverCompletedExport(
        drive as any,
        'job-personal',
        { kind: 'owner', email: 'member@gmail.com' },
      ),
      /access beyond its owner/i,
    );
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
    replyToMessageId: 'om_thread_root',
    replyInThread: true,
    requestId: 'om_test',
  };
  const createWorker = (input: {
    registry: DatasetSourceRegistry;
    sink: DataExportDestinationSink;
    larkAdapter: {
      sendToChatId: (...args: any[]) => Promise<any>;
      updateMessageById: (...args: any[]) => Promise<any>;
    };
    conversationHistory?: {
      appendTurn: (...args: any[]) => Promise<any>;
    };
    inactivityMs?: number;
    maxRows?: number;
  }) => new DataExportWorker({
    redisUrl: 'redis://unused',
    sources: input.registry,
    sink: input.sink,
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
    ...(input.conversationHistory ? { conversationHistory: input.conversationHistory as any } : {}),
    logger: noopLogger,
    ...(input.inactivityMs === undefined ? {} : { inactivityMs: input.inactivityMs }),
    ...(input.maxRows === undefined ? {} : { maxRows: input.maxRows }),
  });

  it('revalidates the selected personal Google destination before writing', async () => {
    const registry = new DatasetSourceRegistry();
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
    let trackerTarget: unknown;
    let authInput: unknown;
    let recordedResource: unknown;
    const personalPayload: DataExportJobPayload = {
      ...payload,
      conversationKey: 'oc_test:thread:om_thread_root',
      destination: {
        ...payload.destination,
        target: {
          kind: 'user_google',
          connectionId: '33333333-3333-4333-8333-333333333333',
        },
      },
    };
    const worker = new DataExportWorker({
      redisUrl: 'redis://unused',
      sources: registry,
      sink: {
        write: async (input: any) => {
          assert.equal(input.readerEmail, 'abhishek@emiactech.com');
          assert.deepEqual(input.auth, {
            accessToken: 'personal-token',
            ownerEmail: 'member@gmail.com',
          });
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
            sharedWith: 'member@gmail.com (owner)',
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
      resolveGoogleAuth: async (companyId, userId, target) => {
        authInput = { companyId, userId, target };
        return { accessToken: 'personal-token', ownerEmail: 'member@gmail.com' };
      },
      larkAdapter: {
        sendToChatId: async (chatId, content, replyToMessageId, idempotencyKey, replyInThread) => {
          trackerTarget = { chatId, replyToMessageId, idempotencyKey, replyInThread };
          delivered.push(content);
          return { ok: true as const, value: 'om-delivered' };
        },
        updateMessageById: async (_messageId, content) => {
          edited.push(content);
          return { ok: true as const, value: undefined };
        },
      },
      conversationHistory: {
        appendTurn: async (conversationKey, turn, scope, metadata) => {
          recordedResource = { conversationKey, turn, scope, metadata };
          return { ok: true as const, value: { id: 'turn-1', ...turn } };
        },
      },
      logger: noopLogger,
    });
    await worker.processJob({
      id: dataExportJobId(personalPayload),
      data: personalPayload,
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
    assert.deepEqual(authInput, {
      companyId: 'company-1',
      userId: 'user-1',
      target: {
        kind: 'user_google',
        connectionId: '33333333-3333-4333-8333-333333333333',
      },
    });
    assert.deepEqual(trackerTarget, {
      chatId: 'oc_test',
      replyToMessageId: 'om_thread_root',
      idempotencyKey: `dtxp_${dataExportJobId(personalPayload)}`,
      replyInThread: true,
    });
    assert.deepEqual(recordedResource, {
      conversationKey: 'oc_test:thread:om_thread_root',
      turn: {
        role: 'tool',
        content: 'Verified google_sheet export: https://docs.google.com/spreadsheets/d/sheet-1/edit',
        timestamp: (recordedResource as any).turn.timestamp,
        toolName: 'dataExportResource',
        toolOutcome: {
          version: 1,
          kind: 'data_export_resource',
          resourceRef: (recordedResource as any).turn.toolOutcome.resourceRef,
          ownerUserId: 'user-1',
          artifactId: 'sheet-1',
          artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
          artifactType: 'google_sheet',
          rowCount: 2,
          connectionId: '33333333-3333-4333-8333-333333333333',
          spreadsheetId: 'sheet-1',
          createdAt: (recordedResource as any).turn.toolOutcome.createdAt,
          expiresAt: (recordedResource as any).turn.toolOutcome.expiresAt,
        },
      },
      scope: { companyId: 'company-1', channel: 'lark' },
      metadata: { dedupeKey: `data-export:${dataExportJobId(personalPayload)}:resource` },
    });
    assert.match((recordedResource as any).turn.toolOutcome.resourceRef, /^[0-9a-f-]{36}$/i);
  });

  it('delivers a persisted completion on retry without re-running the export', async () => {
    const completion = {
      success: true as const,
      artifactId: 'sheet-persisted',
      artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-persisted/edit',
      artifactType: 'google_sheet' as const,
      rowCount: 2,
      sourceTruncated: false,
      sharedWith: 'abhishek@emiactech.com (reader)',
      verified: true as const,
    };
    let edited = '';
    const worker = new DataExportWorker({
      redisUrl: 'redis://unused',
      sources: {
        register: () => assert.fail('registry must not be mutated'),
        resolve: () => assert.fail('source must not be resolved'),
      } as any,
      sink: { write: async () => assert.fail('sink must not run') } as any,
      identityRepo: {
        resolveByUserId: async () => assert.fail('identity must not be resolved'),
      } as any,
      permissions: {
        resolve: async () => assert.fail('permissions must not be resolved'),
      } as any,
      resolveGoogleAuth: async () => assert.fail('Google auth must not be resolved'),
      larkAdapter: {
        sendToChatId: async () => assert.fail('existing tracker must be reused'),
        updateMessageById: async (_messageId, content) => {
          edited = content;
          return { ok: true as const, value: undefined };
        },
      },
      conversationHistory: {
        appendTurn: async () => ({
          ok: false as const,
          error: new Error('conversation storage unavailable'),
        }),
      },
      logger: noopLogger,
    });
    await worker.processJob({
      id: 'persisted-job',
      data: {
        ...payload,
        conversationKey: 'lark:chat-1:user-1',
        progressMessageId: 'om-existing-tracker',
        completedExport: completion,
      },
      attemptsMade: 2,
      opts: { attempts: 3 },
      updateData: async () => assert.fail('persisted completion must not be rewritten'),
      updateProgress: async () => assert.fail('completed retry must not report export progress'),
    });
    assert.match(edited, /Data export ready/i);
    assert.match(edited, /sheet-persisted/i);
    assert.match(edited, /paste the export link/i);
  });

  it('checkpoints a verified artifact before retrying continuity persistence', async () => {
    const registry = new DatasetSourceRegistry();
    let sourceReads = 0;
    registry.register({
      kind: 'airtable_records',
      async *read() {
        sourceReads += 1;
        yield { rows: [{ Name: 'One' }] };
      },
    });
    let sinkWrites = 0;
    let continuityWrites = 0;
    let delivered = '';
    const worker = createWorker({
      registry,
      sink: {
        write: async (input: any) => {
          sinkWrites += 1;
          for await (const _page of input.rows) {
            // Consume the governed source stream like a real destination sink.
          }
          return {
            success: true as const,
            artifactId: 'sheet-once',
            artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-once/edit',
            artifactType: 'google_sheet' as const,
            rowCount: 1,
            sourceTruncated: false,
            sharedWith: 'member@gmail.com (owner)',
            verified: true as const,
          };
        },
      } as any,
      conversationHistory: {
        appendTurn: async (_key, turn) => {
          continuityWrites += 1;
          if (continuityWrites === 1) {
            return { ok: false as const, error: new Error('temporary conversation DB failure') };
          }
          return { ok: true as const, value: { id: 'turn-1', ...turn } };
        },
      },
      larkAdapter: {
        sendToChatId: async () => ({ ok: true as const, value: 'om-progress' }),
        updateMessageById: async (_messageId, content) => {
          delivered = content;
          return { ok: true as const, value: undefined };
        },
      },
    });
    let jobData: DataExportJobPayload = {
      ...payload,
      conversationKey: 'lark:chat-1:user-1',
    };
    const updateData = async (updated: DataExportJobPayload) => { jobData = updated; };

    await assert.rejects(() => worker.processJob({
      id: 'continuity-retry-job',
      data: jobData,
      attemptsMade: 0,
      opts: { attempts: 2 },
      updateData,
      updateProgress: async () => undefined,
    }), /temporary conversation DB failure/);
    assert.equal(jobData.completedExport?.artifactId, 'sheet-once');

    await worker.processJob({
      id: 'continuity-retry-job',
      data: jobData,
      attemptsMade: 1,
      opts: { attempts: 2 },
      updateData,
      updateProgress: async () => assert.fail('completed retry must not rerun progress'),
    });

    assert.equal(sourceReads, 1);
    assert.equal(sinkWrites, 1);
    assert.equal(continuityWrites, 2);
    assert.match(delivered, /Data export ready/);
  });

  it('turns the original export-offer card into the progress and completion tracker', async () => {
    const registry = new DatasetSourceRegistry();
    registry.register({
      kind: 'airtable_records',
      async *read() {
        yield { rows: [{ Name: 'One' }] };
      },
    });
    const edits: string[] = [];
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
        sendToChatId: async () => assert.fail('the offer card must be reused'),
        updateMessageById: async (messageId, card) => {
          assert.equal(messageId, 'om_export_card');
          edits.push(card);
          return { ok: true as const, value: undefined };
        },
      },
    });

    await worker.processJob({
      id: dataExportJobId(payload),
      data: { ...payload, progressMessageId: 'om_export_card' },
      attemptsMade: 0,
      opts: { attempts: 1 },
      updateData: async () => undefined,
      updateProgress: async () => undefined,
    });

    assert.match(edits[0] ?? '', /Data export in progress/i);
    assert.match(edits.at(-1) ?? '', /Data export ready/i);
  });

  it('fails before reading the source when the invoker email is outside the configured domain', async () => {
    let sourceRead = false;
    let failureDelivered = false;
    const registry = new DatasetSourceRegistry();
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
          failureDelivered = /Data export could not finish/i.test(content);
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

  // A revoked destination fails identically on every attempt. Telling the
  // member to try again shortly sends them back to wait for a file that can
  // never arrive; only an administrator can unblock it.
  it('names the reason for a permanent failure instead of promising a retry', async () => {
    const cards: string[] = [];
    let attempts = 0;
    const registry = new DatasetSourceRegistry();
    registry.register({
      kind: 'airtable_records',
      async *read() { yield { rows: [] }; },
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
      resolveGoogleAuth: async () => {
        attempts += 1;
        throw new PermanentDataExportError(
          'The company Google export account (divo@emiactech.com) is disconnected.',
          'Configured Google export connection is unavailable',
        );
      },
      larkAdapter: {
        sendToChatId: async () => ({ ok: true as const, value: 'om-progress' }),
        updateMessageById: async (_messageId, content) => {
          cards.push(content);
          return { ok: true as const, value: undefined };
        },
      },
      logger: noopLogger,
    });

    await assert.rejects(() => worker.processJob({
      id: dataExportJobId(payload),
      data: payload,
      attemptsMade: 0,
      opts: { attempts: 3 },
      updateData: async () => undefined,
      updateProgress: async () => undefined,
    }));

    const failure = cards.find(card => /could not finish/i.test(card));
    assert.ok(failure, 'the member must be told on the first attempt, not left on the progress card');
    assert.match(failure, /is disconnected/i);
    assert.doesNotMatch(failure, /try again shortly/i);
    assert.equal(attempts, 1, 'a permanent failure must not be retried');
  });

  it('keeps a progressing export alive beyond the inactivity window and aborts a stalled source', async () => {
    const { transform: _transform, ...untransformedPayload } = payload;
    const progressing = new DatasetSourceRegistry();
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
    const stalled = new DatasetSourceRegistry();
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
    assert.match(failureCard, /Data export could not finish/i);
    assert.doesNotMatch(failureCard, /no progress/i, 'internal worker errors must not reach Lark');
  });

  it('never sends a second terminal card when the tracker edit fails', async () => {
    const registry = new DatasetSourceRegistry();
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
    const registry = new DatasetSourceRegistry();
    registry.register({
      kind: 'airtable_records',
      async *read() {
        yield { rows: [{ id: 1 }, { id: 2 }], hasMore: true };
        yield { rows: [{ id: 3 }, { id: 4 }], hasMore: true };
        assert.fail('worker must stop pulling source pages at the central cap');
      },
    });
    let writtenRows: Array<Record<string, unknown>> = [];
    let coverage: unknown;
    let completionCard = '';
    const worker = createWorker({
      registry,
      maxRows: 3,
      sink: {
        write: async (input) => {
          for await (const page of input.rows) writtenRows.push(...page);
          coverage = input.coverage?.(writtenRows.length);
          return {
            success: true,
            artifactId: 'sheet-capped',
            artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-capped/edit',
            artifactType: 'google_sheet',
            rowCount: writtenRows.length,
            coverage: coverage as any,
            sourceTruncated: input.sourceTruncated(),
            sharedWith: 'abhishek@emiactech.com (reader)',
            verified: true,
          };
        },
      },
      larkAdapter: {
        sendToChatId: async () => ({ ok: true as const, value: 'om-progress' }),
        updateMessageById: async (_messageId, card) => {
          completionCard = card;
          return { ok: true as const, value: undefined };
        },
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
    assert.deepEqual(coverage, {
      inputRowsRead: 4,
      rowsWritten: 3,
      outcome: 'partial',
      cause: 'export_row_cap',
    });
    assert.match(completionCard, /Divo's export row cap stopped this export/i);
  });

  it('does not call an empty next provider partition partial at an exact row cap', async () => {
    const registry = new DatasetSourceRegistry();
    registry.register({
      kind: 'airtable_records',
      async *read() {
        yield { rows: [{ id: 1 }], hasMore: true };
        yield { rows: [] };
      },
    });
    let coverage: unknown;
    let completionCard = '';
    const worker = createWorker({
      registry,
      maxRows: 1,
      sink: {
        write: async (input) => {
          const rows: Record<string, unknown>[] = [];
          for await (const page of input.rows) rows.push(...page);
          coverage = input.coverage?.(rows.length);
          return {
            success: true,
            artifactId: 'sheet-exact-cap',
            artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-exact-cap/edit',
            artifactType: 'google_sheet',
            rowCount: rows.length,
            coverage: coverage as any,
            sourceTruncated: input.sourceTruncated(),
            sharedWith: 'abhishek@emiactech.com (reader)',
            verified: true,
          };
        },
      },
      larkAdapter: {
        sendToChatId: async () => ({ ok: true as const, value: 'om-progress' }),
        updateMessageById: async (_messageId, card) => {
          completionCard = card;
          return { ok: true as const, value: undefined };
        },
      },
    });
    const { transform: _transform, ...untransformedPayload } = payload;
    await worker.processJob({
      id: 'exact-cap-empty-next-partition',
      data: untransformedPayload,
      attemptsMade: 0,
      opts: { attempts: 1 },
      updateData: async () => undefined,
      updateProgress: async () => undefined,
    });

    assert.deepEqual(coverage, {
      inputRowsRead: 1,
      rowsWritten: 1,
      outcome: 'complete',
    });
    assert.doesNotMatch(completionCard, /⚠️|row cap stopped/i);
  });

  it('delivers a satisfied requested row window without a partial warning', async () => {
    const registry = new DatasetSourceRegistry();
    registry.register({
      kind: 'airtable_records',
      async *read() {
        yield {
          rows: Array.from({ length: 1_234 }, (_, index) => ({ id: index + 1 })),
          requestedRows: 1_234,
          coverage: { outcome: 'requested_window_satisfied', requestedRows: 1_234 },
        };
      },
    });
    let coverage: unknown;
    let completionCard = '';
    const worker = createWorker({
      registry,
      sink: {
        write: async (input) => {
          let rowCount = 0;
          for await (const page of input.rows) rowCount += page.length;
          coverage = input.coverage?.(rowCount);
          return {
            success: true,
            artifactId: 'sheet-requested-window',
            artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-requested-window/edit',
            artifactType: 'google_sheet',
            rowCount,
            coverage: coverage as any,
            sourceTruncated: input.sourceTruncated(),
            sharedWith: 'abhishek@emiactech.com (reader)',
            verified: true,
          };
        },
      },
      larkAdapter: {
        sendToChatId: async () => ({ ok: true as const, value: 'om-progress' }),
        updateMessageById: async (_messageId, card) => {
          completionCard = card;
          return { ok: true as const, value: undefined };
        },
      },
    });
    const { transform: _transform, ...untransformedPayload } = payload;
    await worker.processJob({
      id: 'requested-window-satisfied',
      data: untransformedPayload,
      attemptsMade: 0,
      opts: { attempts: 1 },
      updateData: async () => undefined,
      updateProgress: async () => undefined,
    });

    assert.deepEqual(coverage, {
      requestedRows: 1_234,
      inputRowsRead: 1_234,
      rowsWritten: 1_234,
      outcome: 'requested_window_satisfied',
    });
    assert.doesNotMatch(completionCard, /⚠️|partial/i);
  });

  it('uses the requested format row ceiling without cutting larger Sheet or auto exports at 5,000', async () => {
    assert.deepEqual(await runGeneratedExport(5_000, 'xlsx'), {
      rows: 5_000,
      truncated: false,
    });
    assert.deepEqual(await runGeneratedExport(5_001, 'xlsx'), {
      rows: 5_000,
      truncated: true,
    });
    assert.deepEqual(await runGeneratedExport(5_001, 'google_sheet'), {
      rows: 5_001,
      truncated: false,
    });
    assert.deepEqual(await runGeneratedExport(5_001, 'auto'), {
      rows: 5_001,
      truncated: false,
    });
    assert.deepEqual(await runGeneratedExport(160_713, 'csv'), {
      rows: 160_713,
      truncated: false,
    });
  });

  it('caps an explicit Sheet at 50,000 while auto continues to CSV capacity', async () => {
    assert.deepEqual(await runGeneratedExport(50_001, 'google_sheet'), {
      rows: 50_000,
      truncated: true,
    });
    assert.deepEqual(await runGeneratedExport(50_001, 'auto'), {
      rows: 50_001,
      truncated: false,
    });
  });

  it('does not invent a cause for a legacy partial completion', async () => {
    const registry = new DatasetSourceRegistry();
    let completionCard = '';
    const worker = createWorker({
      registry,
      sink: { write: async () => assert.fail('persisted export must not run the sink') },
      larkAdapter: {
        sendToChatId: async () => assert.fail('persisted export must reuse its tracker'),
        updateMessageById: async (_messageId, card) => {
          completionCard = card;
          return { ok: true as const, value: undefined };
        },
      },
    });
    await worker.processJob({
      id: 'menhood-truncated-job',
      data: {
        ...payload,
        source: {
          kind: 'menhood_query',
          connectionId: 'backend_managed',
          query: { sql: 'SELECT id FROM menhood_orders' },
          queryFingerprint: 'a'.repeat(64),
        },
        destination: { format: 'xlsx', title: 'Menhood orders' },
        progressMessageId: 'om-progress',
        completedExport: {
          success: true,
          artifactId: 'xlsx-1',
          artifactUrl: 'https://drive.google.com/file/d/xlsx-1/view',
          artifactType: 'xlsx',
          rowCount: 5_000,
          sourceTruncated: true,
          sharedWith: 'abhishek@emiactech.com (reader)',
          verified: true,
        },
      },
      attemptsMade: 0,
      opts: { attempts: 1 },
      updateData: async () => assert.fail('persisted completion must not be rewritten'),
      updateProgress: async () => assert.fail('persisted completion must not report progress'),
    });

    assert.match(completionCard, /earlier Divo version recorded omitted rows without their cause/i);
  });

  async function runGeneratedExport(
    totalRows: number,
    format: DataExportJobPayload['destination']['format'],
  ): Promise<{ rows: number; truncated: boolean }> {
    const registry = new DatasetSourceRegistry();
    registry.register({
      kind: 'airtable_records',
      async *read() {
        const pageSize = 1_000;
        for (let offset = 0; offset < totalRows; offset += pageSize) {
          const count = Math.min(pageSize, totalRows - offset);
          yield {
            rows: Array.from({ length: count }, (_, index) => ({ id: offset + index })),
            ...(offset + count < totalRows ? { hasMore: true } : {}),
          };
        }
      },
    });
    let result = { rows: 0, truncated: false };
    const worker = createWorker({
      registry,
      sink: {
        write: async (input) => {
          for await (const page of input.rows) result.rows += page.length;
          result.truncated = input.sourceTruncated();
          return {
            success: true,
            artifactId: 'generated-export',
            artifactUrl: 'https://drive.google.com/file/d/generated-export/view',
            artifactType: format === 'xlsx' ? 'xlsx' : format === 'google_sheet' ? 'google_sheet' : 'csv',
            rowCount: result.rows,
            sourceTruncated: result.truncated,
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
    const { transform: _transform, ...untransformedPayload } = payload;
    await worker.processJob({
      id: `generated-${format}-${totalRows}`,
      data: {
        ...untransformedPayload,
        destination: { ...untransformedPayload.destination, format },
      },
      attemptsMade: 0,
      opts: { attempts: 1 },
      updateData: async () => undefined,
      updateProgress: async () => undefined,
    });
    return result;
  }
});

describe('data export access contract', () => {
  const tool = createDataExportTool({
    offers: {
      submitAuthorized: async () => 'unused',
    },
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

  it('rejects provider offer confirmation from the agent-callable tool', () => {
    const offerId = '11111111-1111-4111-8111-111111111111';
    assert.equal(tool.argsSchema.safeParse({ offerId }).success, false);
    assert.equal(tool.argsSchema.safeParse({ offerId, ...base }).success, false);
    assert.equal(tool.argsSchema.safeParse({ offerId, companyId: 'company-other' }).success, false);
    assert.equal(tool.argsSchema.safeParse({
      offerId,
      destinationReferenceId: '22222222-2222-4222-8222-222222222222',
    }).success, false);
  });

  it('pins a direct recipe to the backend-derived Lark reply address', async () => {
    let submitted: unknown;
    const recipeTool = createDataExportTool({
      offers: {
        submitAuthorized: async (input) => {
          submitted = input;
          return 'dtx_recipe';
        },
      },
    });

    const result = await recipeTool.execute(
      base,
      makeCtx('dataExport', ['create'], {
        chatId: 'oc_group',
        replyToMessageId: 'om_thread_root',
        replyInThread: true,
      }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(submitted, {
      companyId: 'co-test',
      userId: 'user-test',
      source: base.source,
      destination: base.destination,
      chatId: 'oc_group',
      replyToMessageId: 'om_thread_root',
      replyInThread: true,
      requestId: 'test-corr',
    });
  });

});

describe('Exports built from several tool calls', () => {
  const multiPartPayload: DataExportJobPayload = {
    companyId: 'company-1',
    userId: 'user-1',
    source: {
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args: { operation: 'domain_overview', domain: 'a.com' },
    },
    additionalParts: [
      {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'domain_overview', domain: 'b.com' },
      },
      {
        kind: 'semrush_snapshot',
        connectionId: 'backend_managed',
        args: { operation: 'domain_overview', domain: 'c.com' },
      },
    ],
    observedRowCount: 3,
    destination: { format: 'auto', title: 'Domain overviews' },
    chatId: 'oc_test',
    requestId: 'om_multi',
  };

  const buildWorker = (input: {
    registry: DatasetSourceRegistry;
    sink: any;
    maxRows?: number;
  }) => new DataExportWorker({
    redisUrl: 'redis://unused',
    sources: input.registry,
    sink: input.sink,
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
    } as any,
    permissions: {
      resolve: async () => ({
        ok: true as const,
        value: {
          allowedToolIds: new Set([asToolId('dataExport'), asToolId('semrush')]),
          allowedActionsByTool: new Map([
            [asToolId('dataExport'), new Set(['create'])],
            [asToolId('semrush'), new Set(['read'])],
          ]),
          decisions: [],
        },
      }),
    } as any,
    resolveGoogleAuth: async () => ({ accessToken: 'short-lived', readerDomain: 'emiactech.com' }),
    larkAdapter: {
      sendToChatId: async () => ({ ok: true as const, value: 'om_progress' }),
      updateMessageById: async () => ({ ok: true as const, value: undefined }),
    } as any,
    logger: noopLogger,
    ...(input.maxRows === undefined ? {} : { maxRows: input.maxRows }),
  });

  const registryYielding = (
    read: (source: any) => AsyncIterable<{ rows: readonly Record<string, unknown>[] }>,
  ) => {
    const registry = new DatasetSourceRegistry();
    registry.register({ kind: 'semrush_snapshot' as const, read });
    return registry;
  };

  it('writes every part, in order, as one dataset', async () => {
    let written: Record<string, unknown>[] = [];
    const worker = buildWorker({
      registry: registryYielding(async function* (source: any) {
        yield { rows: [{ domain: source.args.domain, rank: 10 }] };
      }),
      sink: {
        write: async (input: any) => {
          for await (const page of input.rows) written.push(...page);
          return {
            success: true as const,
            artifactId: 'sheet-1',
            artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
            artifactType: 'google_sheet' as const,
            rowCount: written.length,
            sourceTruncated: input.sourceTruncated(),
            sharedWith: 'abhishek@emiactech.com (reader)',
            verified: true as const,
          };
        },
      } as any,
    });

    await worker.processJob({
      id: 'dtx_multi',
      data: multiPartPayload,
      attemptsMade: 0,
      opts: { attempts: 1 },
      updateData: async () => undefined,
      updateProgress: async () => undefined,
    } as any);

    assert.deepEqual(written, [
      { domain: 'a.com', rank: 10 },
      { domain: 'b.com', rank: 10 },
      { domain: 'c.com', rank: 10 },
    ], 'a 3-call answer exports 3 rows, not the first call\'s 1');
  });

  it('names the failing part instead of reporting a bare provider error', async () => {
    const worker = buildWorker({
      registry: registryYielding(async function* (source: any) {
        if (source.args.domain === 'b.com') throw new Error('provider timeout');
        yield { rows: [{ domain: source.args.domain }] };
      }),
      sink: {
        write: async (input: any) => {
          for await (const _page of input.rows) { /* drain until the part throws */ }
          assert.fail('the sink must not complete when a part cannot be read');
        },
      } as any,
    });

    await assert.rejects(
      () => worker.processJob({
        id: 'dtx_multi_fail',
        data: multiPartPayload,
        attemptsMade: 0,
        opts: { attempts: 1 },
        updateData: async () => undefined,
        updateProgress: async () => undefined,
      } as any),
      /part 2 of 3 .*could not be read.*provider timeout/i,
    );
  });

  it('applies the row limit across all parts rather than restarting it per part', async () => {
    let written: Record<string, unknown>[] = [];
    const worker = buildWorker({
      maxRows: 2,
      registry: registryYielding(async function* (source: any) {
        yield { rows: [{ domain: source.args.domain }] };
      }),
      sink: {
        write: async (input: any) => {
          for await (const page of input.rows) written.push(...page);
          return {
            success: true as const,
            artifactId: 'sheet-1',
            artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
            artifactType: 'google_sheet' as const,
            rowCount: written.length,
            sourceTruncated: input.sourceTruncated(),
            sharedWith: 'abhishek@emiactech.com (reader)',
            verified: true as const,
          };
        },
      } as any,
    });

    await worker.processJob({
      id: 'dtx_multi_limit',
      data: multiPartPayload,
      attemptsMade: 0,
      opts: { attempts: 1 },
      updateData: async () => undefined,
      updateProgress: async () => undefined,
    } as any);

    assert.equal(written.length, 2, 'the limit counts rows, not parts');
  });
});

describe('Truncation across part boundaries', () => {
  const partsPayload = (count: number): DataExportJobPayload => ({
    companyId: 'company-1',
    userId: 'user-1',
    source: {
      kind: 'semrush_snapshot',
      connectionId: 'backend_managed',
      args: { operation: 'domain_overview', domain: 'p0.com' },
    },
    additionalParts: Array.from({ length: count - 1 }, (_, i) => ({
      kind: 'semrush_snapshot' as const,
      connectionId: 'backend_managed' as const,
      args: { operation: 'domain_overview' as const, domain: `p${i + 1}.com` },
    })),
    destination: { format: 'auto', title: 'Truncation' },
    chatId: 'oc_test',
    requestId: 'om_trunc',
  });

  const runWith = async (
    read: (source: any) => AsyncIterable<any>,
    maxRows: number,
    partCount: number,
  ) => {
    const registry = new DatasetSourceRegistry();
    registry.register({ kind: 'semrush_snapshot' as const, read });
    let truncated: boolean | undefined;
    const worker = new DataExportWorker({
      redisUrl: 'redis://unused',
      sources: registry,
      sink: {
        write: async (input: any) => {
          const rows: unknown[] = [];
          for await (const page of input.rows) rows.push(...page);
          truncated = input.sourceTruncated();
          return {
            success: true as const,
            artifactId: 'sheet-1',
            artifactUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
            artifactType: 'google_sheet' as const,
            rowCount: rows.length,
            sourceTruncated: truncated,
            sharedWith: 'abhishek@emiactech.com (reader)',
            verified: true as const,
          };
        },
      } as any,
      identityRepo: {
        resolveByUserId: async () => ({
          ok: true as const,
          value: {
            userId: 'user-1', companyId: 'company-1', aiRole: 'MEMBER',
            channel: 'lark', email: 'abhishek@emiactech.com',
          },
        }),
      } as any,
      permissions: {
        resolve: async () => ({
          ok: true as const,
          value: {
            allowedToolIds: new Set([asToolId('dataExport'), asToolId('semrush')]),
            allowedActionsByTool: new Map([
              [asToolId('dataExport'), new Set(['create'])],
              [asToolId('semrush'), new Set(['read'])],
            ]),
            decisions: [],
          },
        }),
      } as any,
      resolveGoogleAuth: async () => ({ accessToken: 't', readerDomain: 'emiactech.com' }),
      larkAdapter: {
        sendToChatId: async () => ({ ok: true as const, value: 'om_progress' }),
        updateMessageById: async () => ({ ok: true as const, value: undefined }),
      } as any,
      logger: noopLogger,
      maxRows,
    });
    await worker.processJob({
      id: 'dtx_trunc',
      data: partsPayload(partCount),
      attemptsMade: 0,
      opts: { attempts: 1 },
      updateData: async () => undefined,
      updateProgress: async () => undefined,
    } as any);
    return truncated;
  };

  it('flags truncation when an empty probe page hides later rows in the same part', async () => {
    // The limit lands exactly at the end of part 2. Part 3 opens with an empty
    // page, which proves nothing — its second page still holds a row.
    const truncated = await runWith(async function* (source: any) {
      if (source.args.domain === 'p2.com') {
        yield { rows: [] };
        yield { rows: [{ domain: source.args.domain }] };
        return;
      }
      yield { rows: [{ domain: source.args.domain }] };
    }, 2, 3);

    assert.equal(truncated, true, 'dropped rows must never be reported as a complete export');
  });

  it('flags truncation when whole parts are dropped past the limit', async () => {
    const truncated = await runWith(async function* (source: any) {
      yield { rows: [{ domain: source.args.domain }] };
    }, 2, 5);

    assert.equal(truncated, true);
  });

  it('does not claim truncation when every part fits', async () => {
    const truncated = await runWith(async function* (source: any) {
      yield { rows: [{ domain: source.args.domain }] };
    }, 100, 3);

    assert.equal(truncated, false);
  });
});
