/**
 * Airtable MCP tool tests.
 *
 * The manifest is the RBAC surface for this family — an operation that is not
 * in it is uncallable, and the action it maps to is what approval gating and
 * audit see. These tests cover that boundary and the one place where an input
 * flag can widen what a call actually does (performUpsert inserting rows).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeAllowedPerm, makeCtx, makeDeniedPerm } from './tool-test.helpers.ts';
import { createAirtableMcpTools } from '../../src/application/orchestration/tools/families/airtable-mcp.tool.ts';
import {
  AIRTABLE_PRODUCTS,
  airtableOperationFor,
  hasAirtableScopeGroups,
} from '../../src/application/airtable/airtable-mcp-manifest.ts';
import type { ToolActionGroup } from '../../src/domain/permissions/tool-action-group.ts';
import { TOOL_SUPPORTED_ACTIONS } from '../../src/domain/tools/tool-id.ts';
import { asToolId } from '../../src/shared/ids.ts';
import {
  compactAirtableMcpResult,
  unwrapAirtableMcpResult,
} from '../../src/infrastructure/airtable/airtable-mcp.client.ts';

const unavailableTools = () => createAirtableMcpTools({
  getConnection: async () => ({ status: 'unavailable' as const }),
});

const toolFor = (toolId: string) => {
  const tool = unavailableTools().find(t => String(t.id) === toolId);
  assert.ok(tool, `${toolId} tool should be created`);
  return tool;
};

describe('airtable manifest', () => {
  it('declares only action groups the canonical tool policy supports', () => {
    for (const product of AIRTABLE_PRODUCTS) {
      const supported = new Set(TOOL_SUPPORTED_ACTIONS[product.toolId] as readonly string[]);
      for (const operation of product.operations) {
        assert.ok(
          supported.has(operation.action),
          `${product.toolId}.${operation.nativeTool} maps to unsupported action ${operation.action}`,
        );
        for (const escalation of operation.escalations ?? []) {
          assert.ok(
            supported.has(escalation.requires),
            `${product.toolId}.${operation.nativeTool} escalates to unsupported action ${escalation.requires}`,
          );
        }
      }
    }
  });

  it('lists each native tool at most once per product', () => {
    for (const product of AIRTABLE_PRODUCTS) {
      const names = product.operations.map(o => o.nativeTool);
      assert.equal(new Set(names).size, names.length, `${product.toolId} repeats a native tool`);
    }
  });

  it('gates every destructive operation behind the delete action', () => {
    for (const product of AIRTABLE_PRODUCTS) {
      for (const operation of product.operations) {
        if (!operation.nativeTool.startsWith('delete_')) continue;
        assert.equal(
          operation.action,
          'delete',
          `${operation.nativeTool} must require delete, not ${operation.action}`,
        );
      }
    }
  });

  it('treats revert_action as a delete because reverting a create removes rows', () => {
    assert.equal(airtableOperationFor('airtableRecords', 'revert_action')?.action, 'delete');
  });

  it('keeps read-only discovery available to the records tool', () => {
    // Records work is impossible without resolving a baseId and tableId first.
    for (const nativeTool of ['list_bases', 'list_tables_for_base', 'get_table_schema']) {
      assert.equal(airtableOperationFor('airtableRecords', nativeTool)?.action, 'read');
    }
  });

  it('does not expose schema or automation writes through the records tool', () => {
    for (const nativeTool of ['create_table', 'delete_table', 'create_automation', 'publish_interface']) {
      assert.equal(airtableOperationFor('airtableRecords', nativeTool), undefined);
    }
  });
});

describe('hasAirtableScopeGroups', () => {
  it('requires at least one scope from every group', () => {
    assert.equal(hasAirtableScopeGroups(['data.records:read'], [['data.records:read']]), true);
    assert.equal(
      hasAirtableScopeGroups(['data.records:read'], [['data.records:read'], ['schema.bases:read']]),
      false,
      'a connection missing one required group must not qualify',
    );
    assert.equal(
      hasAirtableScopeGroups(['data.records:read', 'schema.bases:read'], [['data.records:read'], ['schema.bases:read']]),
      true,
    );
  });

  it('treats an empty requirement as satisfied', () => {
    assert.equal(hasAirtableScopeGroups([], []), true);
  });
});

describe('airtableRecords permissionCheck', () => {
  const tool = toolFor('airtableRecords');

  it('reports the operation action group for an ordinary write', () => {
    const result = tool.permissionCheck(
      { op: 'call', nativeTool: 'update_records_for_table', input: {} } as any,
      makeAllowedPerm('airtableRecords', ['update']),
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value, 'update');
  });

  it('refuses performUpsert for a caller who may update but not create', () => {
    // performUpsert inserts rows whose merge values do not exist yet, so an
    // update-only grant must not reach it through an input flag.
    const result = tool.permissionCheck(
      {
        op: 'call',
        nativeTool: 'update_records_for_table',
        input: { performUpsert: { fieldIdsToMergeOn: ['fldAAAAAAAAAAAAAA'] } },
      } as any,
      makeAllowedPerm('airtableRecords', ['update']),
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.payload.action, 'create');
  });

  it('allows performUpsert once create is also granted', () => {
    const result = tool.permissionCheck(
      {
        op: 'call',
        nativeTool: 'update_records_for_table',
        input: { performUpsert: { fieldIdsToMergeOn: ['fldAAAAAAAAAAAAAA'] } },
      } as any,
      makeAllowedPerm('airtableRecords', ['update', 'create']),
    );
    assert.equal(result.ok, true);
    // Still reported as an update so the approval card describes the write the
    // member asked for rather than the escalation implied by one flag.
    assert.equal(result.ok && result.value, 'update');
  });

  it('rejects a native tool that is not in the manifest', () => {
    const result = tool.permissionCheck(
      { op: 'call', nativeTool: 'delete_table', input: {} } as any,
      makeAllowedPerm('airtableRecords', ['read', 'create', 'update', 'delete']),
    );
    assert.equal(result.ok, false);
  });

  it('requires only read to describe an operation schema', () => {
    const result = tool.permissionCheck(
      { op: 'describe', nativeTool: 'delete_records_for_table' } as any,
      makeAllowedPerm('airtableRecords', ['read']),
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value, 'read');
  });

  it('denies everything when the tool is not granted at all', () => {
    const result = tool.permissionCheck(
      { op: 'call', nativeTool: 'list_records_for_table', input: {} } as any,
      makeDeniedPerm(),
    );
    assert.equal(result.ok, false);
  });

  it('requires dataExport:create before a complete export can be queued', () => {
    const denied = tool.permissionCheck(
      { op: 'call', nativeTool: 'list_records_for_table', input: {}, exportAll: true } as any,
      makeAllowedPerm('airtableRecords', ['read']),
    );
    const allowedPerm = makeAllowedPerm('airtableRecords', ['read']);
    allowedPerm.allowedToolIds.add(asToolId('dataExport'));
    allowedPerm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));
    const allowed = tool.permissionCheck(
      { op: 'call', nativeTool: 'list_records_for_table', input: {}, exportAll: true } as any,
      allowedPerm,
    );

    assert.equal(denied.ok, false);
    assert.equal(!denied.ok && denied.error.payload.toolId, 'dataExport');
    assert.equal(allowed.ok, true);
  });
});

describe('airtable args schema', () => {
  const tool = toolFor('airtableRecords');

  it('requires connectionId for a call but not for describe', () => {
    assert.equal(
      tool.argsSchema.safeParse({ op: 'call', nativeTool: 'list_records_for_table' }).success,
      false,
      'a real call must name exactly one account',
    );
    assert.equal(
      tool.argsSchema.safeParse({ op: 'describe', nativeTool: 'list_records_for_table' }).success,
      true,
    );
  });

  it('still validates an explicitly supplied connectionId', () => {
    assert.equal(
      tool.argsSchema.safeParse({ op: 'call', nativeTool: 'list_records_for_table', connectionId: 'not-a-uuid' }).success,
      false,
    );
  });
});

describe('airtable execute', () => {
  it('surfaces account choices as a recoverable turn rather than an error', async () => {
    const [records] = createAirtableMcpTools({
      getConnection: async () => ({
        status: 'choose_connection' as const,
        connections: [
          { connectionId: 'c-1', label: 'Marketing base', access: 'read_write' as const },
          { connectionId: 'c-2', label: 'Ops base', access: 'read_only' as const },
        ],
      }),
    });
    const result = await records!.execute(
      { op: 'call', nativeTool: 'list_records_for_table', connectionId: undefined, input: {} } as any,
      makeCtx('airtableRecords', ['read']),
    );
    assert.equal(result.ok, true);
    const value = result.ok ? (result.value as any) : null;
    assert.equal(value.success, false);
    assert.equal(value.data.code, 'airtable_connection_selection_required');
    assert.equal(value.data.connections.length, 2);
  });

  it('fails closed, without throwing, when no connection is available', async () => {
    const result = await toolFor('airtableRecords').execute(
      { op: 'call', nativeTool: 'list_records_for_table', connectionId: undefined, input: {} } as any,
      makeCtx('airtableRecords', ['read']),
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.payload.reason, 'unrecoverable');
  });

  it('rejects an unapproved native tool before touching the connection', async () => {
    let resolved = false;
    const [records] = createAirtableMcpTools({
      getConnection: async () => {
        resolved = true;
        return { status: 'unavailable' as const };
      },
    });
    const result = await records!.execute(
      { op: 'call', nativeTool: 'drop_everything', connectionId: undefined, input: {} } as any,
      makeCtx('airtableRecords', ['read']),
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.payload.reason, 'bad_args');
    assert.equal(resolved, false, 'an unapproved operation must not reach connection resolution');
  });

  it('calls the approved native tool and returns its data', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const [records] = createAirtableMcpTools({
      getConnection: async () => ({
        status: 'resolved' as const,
        connection: {
          client: {
            describeTool: async () => ({ name: 'list_records_for_table', inputSchema: { type: 'object' } }),
            callTool: async (name: string, input: Record<string, unknown>) => {
              calls.push({ name, input });
              return { records: [{ id: 'recAAAAAAAAAAAAAA' }] };
            },
          },
        },
      }),
    });
    const result = await records!.execute(
      {
        op: 'call',
        nativeTool: 'list_records_for_table',
        connectionId: '11111111-1111-4111-8111-111111111111',
        input: { baseId: 'appAAAAAAAAAAAAAA', tableId: 'Orders' },
      } as any,
      makeCtx('airtableRecords', ['read']),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{
      name: 'list_records_for_table',
      input: { baseId: 'appAAAAAAAAAAAAAA', tableId: 'Orders', pageSize: 10 },
    }]);
  });

  it('bounds ordinary record reads before Airtable and keeps large fields out of model context', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const [records] = createAirtableMcpTools({
      getConnection: async () => ({
        status: 'resolved' as const,
        connection: {
          client: {
            describeTool: async () => ({ name: 'list_records_for_table', inputSchema: { type: 'object' } }),
            callTool: async (_name: string, input: Record<string, unknown>) => {
              calls.push(input);
              return {
                records: Array.from({ length: 10 }, (_, index) => ({
                  id: `rec${index}`,
                  cellValuesByFieldId: { fldName: `Order ${index}`, fldAttachment: 'x'.repeat(5_000) },
                })),
                nextCursor: 'next-page',
              };
            },
          },
        },
      }),
    });
    const result = await records!.execute(
      {
        op: 'call',
        nativeTool: 'list_records_for_table',
        connectionId: '11111111-1111-4111-8111-111111111111',
        input: { baseId: 'app1', tableId: 'tbl1', pageSize: 8_000 },
      } as any,
      makeCtx('airtableRecords', ['read']),
    );

    assert.equal(result.ok, true);
    assert.equal(calls[0]?.['pageSize'], 10);
    const value = result.ok ? result.value as any : null;
    assert.ok(Buffer.byteLength(JSON.stringify(value.data), 'utf8') <= 24_000);
    assert.match(value.data.records[0].cellValuesByFieldId.fldAttachment, /value omitted from preview/);
    assert.equal(value.data.hasMore, true);
  });

  it('queues a complete Lark export without putting credentials or records in the job', async () => {
    const jobs: unknown[] = [];
    let providerRead = false;
    const [records] = createAirtableMcpTools({
      exportQueue: {
        enqueue: async payload => {
          jobs.push(payload);
          return 'atx_job';
        },
      },
      getConnection: async () => ({
        status: 'resolved' as const,
        connection: {
          client: {
            describeTool: async () => ({ name: 'list_records_for_table', inputSchema: { type: 'object' } }),
            callTool: async () => {
              providerRead = true;
              return { records: [] };
            },
          },
        },
      }),
    });
    const ctx = makeCtx('airtableRecords', ['read'], {
      chatId: 'oc_test',
      requestId: 'om_test',
      traceId: 'trace_test',
    });
    ctx.perm.allowedToolIds.add(asToolId('dataExport'));
    ctx.perm.allowedActionsByTool.set(asToolId('dataExport'), new Set(['create']));
    const result = await records!.execute(
      {
        op: 'call',
        nativeTool: 'list_records_for_table',
        connectionId: '11111111-1111-4111-8111-111111111111',
        input: { baseId: 'app1', tableId: 'tbl1' },
        exportAll: true,
      } as any,
      ctx,
    );

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.exportQueued, true);
    assert.equal(result.ok && result.value.exportJobId, 'atx_job');
    assert.match(result.ok ? result.value.message : '', /5,000-row cap/i);
    assert.match(result.ok ? result.value.message : '', /not be described as complete/i);
    assert.equal(providerRead, false, 'interactive execution must not fetch the full dataset');
    assert.equal(jobs.length, 1);
    const serialized = JSON.stringify(jobs[0]);
    assert.doesNotMatch(serialized, /accessToken|refreshToken|apiKey|credential/i);
    assert.match(serialized, /"chatId":"oc_test"/);
  });

  it('converts an upstream throw into a tool error instead of propagating it', async () => {
    const [records] = createAirtableMcpTools({
      getConnection: async () => ({
        status: 'resolved' as const,
        connection: {
          client: {
            describeTool: async () => ({ name: 'list_records_for_table', inputSchema: { type: 'object' } }),
            callTool: async () => { throw new Error('airtable is down'); },
          },
        },
      }),
    });
    const result = await records!.execute(
      {
        op: 'call',
        nativeTool: 'list_records_for_table',
        connectionId: '11111111-1111-4111-8111-111111111111',
        input: {},
      } as any,
      makeCtx('airtableRecords', ['read']),
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.payload.reason, 'upstream_failure');
  });
});

describe('airtable tool family shape', () => {
  it('creates one tool per product, all in the airtable family', () => {
    const tools = unavailableTools();
    assert.equal(tools.length, AIRTABLE_PRODUCTS.length);
    for (const tool of tools) {
      assert.equal(tool.family, 'airtable');
      const actions = [...tool.actionGroups] as ToolActionGroup[];
      assert.ok(actions.includes('read'), `${tool.id} should support read`);
    }
  });
});

describe('Airtable MCP model-facing results', () => {
  it('unwraps a single JSON text result', () => {
    assert.deepEqual(
      unwrapAirtableMcpResult({
        content: [{ type: 'text', text: '{"bases":[{"id":"app1","name":"Ops"}]}' }],
      }),
      { bases: [{ id: 'app1', name: 'Ops' }] },
    );
  });

  it('keeps the complete table index without repeating full field schemas', () => {
    const result = compactAirtableMcpResult('list_tables_for_base', {
      tables: [{
        id: 'tbl1',
        name: 'Orders',
        primaryFieldId: 'fld1',
        fields: [
          { id: 'fld1', name: 'Order ID', type: 'singleLineText' },
          { id: 'fld2', name: 'Status', type: 'singleSelect', options: { choices: [] } },
        ],
        views: [{ id: 'viw1', name: 'All orders' }],
      }],
    }) as any;

    assert.deepEqual(result.tables, [{
      id: 'tbl1',
      name: 'Orders',
      primaryFieldId: 'fld1',
      fieldCount: 2,
      viewCount: 1,
    }]);
  });
});
