import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAitableTools, type AitableConnectionResolution } from '../../src/application/tools/families/aitable.tool.ts';
import { AitableError, AitablePartialWriteError } from '../../src/infrastructure/aitable/aitable.client.ts';
import { asToolId } from '../../src/shared/ids.ts';
import { aitableOperationNames } from '../../src/application/aitable/aitable-manifest.ts';

const TEXT_FIELD = { id: 'fld1', name: 'Title', type: 'Text' };
const FORMULA_FIELD = { id: 'fld2', name: 'Total', type: 'Formula' };

/** A stand-in AitableClient recording what the tool asked it to do. */
function fakeClient(over: Record<string, unknown> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const record = (name: string, result: unknown) => (...args: unknown[]) => {
    calls.push({ name, args });
    if (typeof result === 'function') return (result as (...a: unknown[]) => unknown)(...args);
    return Promise.resolve(result);
  };
  const client = {
    listSpaces: record('listSpaces', [{ id: 'spc1', name: 'Ops' }]),
    searchNodes: record('searchNodes', [{ id: 'dst1', name: 'Budget', type: 'Datasheet' }]),
    getNode: record('getNode', { id: 'dst1', name: 'Budget', type: 'Datasheet' }),
    listViews: record('listViews', [{ id: 'viw1', name: 'Grid', type: 'Grid' }]),
    listFields: record('listFields', [TEXT_FIELD, FORMULA_FIELD]),
    listRecords: record('listRecords', { records: [], total: 0, pageNum: 1, pageSize: 100 }),
    createRecords: record('createRecords', [{ recordId: 'rec1', fields: {} }]),
    updateRecords: record('updateRecords', [{ recordId: 'rec1', fields: {} }]),
    deleteRecords: record('deleteRecords', undefined),
    ...over,
  };
  return { client, calls };
}

function build(options: {
  resolution?: AitableConnectionResolution;
  client?: Record<string, unknown>;
  actions?: string[];
  toolId?: string;
} = {}) {
  const { client, calls } = fakeClient(options.client);
  const rejected: { companyId: string; connectionId: string }[] = [];
  const resolution: AitableConnectionResolution = options.resolution
    ?? { status: 'resolved', connectionId: 'conn-1', connection: { client: client as never } };

  const tools = createAitableTools({
    getConnection: async () => resolution,
    onKeyRejected: async (companyId, connectionId) => { rejected.push({ companyId, connectionId }); },
  });
  const toolId = options.toolId ?? 'aitableDatasheets';
  const tool = tools.find(candidate => String(candidate.id) === toolId)!;

  const permission = {
    allowedActionsByTool: new Map([
      [asToolId(toolId), new Set(options.actions ?? ['read', 'create', 'update', 'delete'])],
    ]),
  } as never;

  const ctx = { runContext: { companyId: 'co-1', userId: 'user-1' } } as never;
  return { tool, permission, ctx, calls, rejected };
}

const run = (t: ReturnType<typeof build>, args: Record<string, unknown>) =>
  t.tool.execute(args as never, t.ctx);

describe('AITable tool permissions', () => {
  it('exposes exactly the two manifest products', () => {
    const tools = createAitableTools({ getConnection: async () => ({ status: 'unavailable' }), onKeyRejected: async () => {} });
    assert.deepEqual(tools.map(tool => String(tool.id)).sort(), ['aitableDatasheets', 'aitableFields']);
  });

  // The manifest is the RBAC surface, so an unlisted operation must be refused
  // before any network call rather than merely failing upstream.
  it('rejects an operation absent from the manifest', () => {
    const t = build();
    const result = t.tool.permissionCheck!({ operation: 'drop_everything' } as never, t.permission);

    assert.equal(result.ok, false);
    assert.equal(t.calls.length, 0);
  });

  it('maps each operation to the action group it actually needs', () => {
    const t = build();
    const check = (operation: string) => t.tool.permissionCheck!({ operation } as never, t.permission);

    assert.equal(check('list_records').ok && check('list_records').value, 'read');
    assert.equal(check('create_records').ok && check('create_records').value, 'create');
    assert.equal(check('update_records').ok && check('update_records').value, 'update');
    assert.equal(check('delete_records').ok && check('delete_records').value, 'delete');
  });

  // A read grant must not buy a write. This is the check that keeps the
  // company-admin floor (read/create/update, no delete) meaningful.
  it('refuses an operation the caller was not granted', () => {
    const readOnly = build({ actions: ['read'] });

    assert.equal(readOnly.tool.permissionCheck!({ operation: 'list_records' } as never, readOnly.permission).ok, true);
    assert.equal(readOnly.tool.permissionCheck!({ operation: 'delete_records' } as never, readOnly.permission).ok, false);
    assert.equal(readOnly.tool.permissionCheck!({ operation: 'create_records' } as never, readOnly.permission).ok, false);
  });

  it('does not offer record operations on the fields tool', () => {
    const fields = build({ toolId: 'aitableFields' });
    assert.equal(fields.tool.permissionCheck!({ operation: 'delete_records' } as never, fields.permission).ok, false);
    assert.equal(fields.tool.permissionCheck!({ operation: 'get_fields' } as never, fields.permission).ok, true);
  });
});

describe('AITable manifest and implementation stay in step', () => {
  /** Minimum input each operation needs to get past its own argument checks. */
  const INPUT_FOR: Record<string, Record<string, unknown>> = {
    list_spaces: {},
    search_nodes: { spaceId: 'spc1' },
    get_node: { spaceId: 'spc1', nodeId: 'dst1' },
    list_views: { datasheetId: 'dst1' },
    get_fields: { datasheetId: 'dst1' },
    list_records: { datasheetId: 'dst1' },
    create_records: { datasheetId: 'dst1', records: [{ fields: { Title: 'x' } }] },
    update_records: { datasheetId: 'dst1', records: [{ recordId: 'rec1', fields: { Title: 'x' } }] },
    delete_records: { datasheetId: 'dst1', recordIds: ['rec1'] },
    create_field: { spaceId: 'spc1', datasheetId: 'dst1', name: 'Notes', type: 'Text' },
    delete_field: { spaceId: 'spc1', datasheetId: 'dst1', fieldId: 'fld1' },
  };

  // Declaring an operation with nothing behind it is precisely the fault found
  // in AITable's own MCP server, whose tool descriptions pointed the model at
  // an `update_record` that was never implemented.
  for (const toolId of ['aitableDatasheets', 'aitableFields']) {
    it(`${toolId}: every declared operation actually runs`, async () => {
      const t = build({ toolId, client: { createField: async () => ({ id: 'fld9', name: 'Notes' }), deleteField: async () => undefined } });
      for (const operation of aitableOperationNames(toolId)) {
        const input = INPUT_FOR[operation];
        assert.ok(input, `no fixture for ${operation} — add one rather than skipping it`);
        const result = await run(t, {
          connectionId: '00000000-0000-4000-8000-000000000001',
          operation,
          input,
        });
        assert.ok(result.ok, `${operation} returned an error`);
        assert.equal(result.value.success, true, `${operation} did not succeed`);
      }
    });
  }
});

describe('AITable tool execution', () => {
  it('reads records and passes the filter straight through', async () => {
    const t = build();
    const result = await run(t, {
      connectionId: '00000000-0000-4000-8000-000000000001',
      operation: 'list_records',
      input: { datasheetId: 'dst1', filterByFormula: '{Stage}="Open"' },
    });

    assert.ok(result.ok && result.value.success);
    const call = t.calls.find(c => c.name === 'listRecords')!;
    assert.equal((call.args[1] as any).filterByFormula, '{Stage}="Open"');
  });

  // The schema is fetched rather than trusted from the model, because encoding
  // is only safe against the datasheet's real field types.
  it('reads the live schema before encoding a write', async () => {
    const t = build();
    await run(t, {
      connectionId: '00000000-0000-4000-8000-000000000001',
      operation: 'create_records',
      input: { datasheetId: 'dst1', records: [{ fields: { Title: 'Launch' } }] },
    });

    assert.ok(t.calls.findIndex(c => c.name === 'listFields') < t.calls.findIndex(c => c.name === 'createRecords'));
  });

  // The upstream MCP server dropped values it could not encode and reported
  // success. Here the write must not happen at all.
  it('never writes when a field cannot be encoded', async () => {
    const t = build();
    const result = await run(t, {
      connectionId: '00000000-0000-4000-8000-000000000001',
      operation: 'create_records',
      input: { datasheetId: 'dst1', records: [{ fields: { Total: 99 } }] },
    });

    assert.equal(result.ok, false);
    assert.equal(t.calls.some(c => c.name === 'createRecords'), false, 'nothing may be written');
  });

  it('reports a partial write as a result, naming what already landed', async () => {
    const t = build({
      client: {
        createRecords: async () => {
          throw new AitablePartialWriteError(
            [{ recordId: 'rec1', fields: {} }],
            new AitableError('unreachable', 'boom'),
          );
        },
      },
    });
    const result = await run(t, {
      connectionId: '00000000-0000-4000-8000-000000000001',
      operation: 'create_records',
      input: { datasheetId: 'dst1', records: [{ fields: { Title: 'x' } }] },
    });

    // Not an error: the caller must be told what is already in the datasheet,
    // or a blind retry duplicates rows.
    assert.ok(result.ok);
    assert.equal(result.value.success, false);
    assert.equal((result.value.data as any).code, 'aitable_partial_write');
    assert.match(result.value.message!, /already there/i);
  });

  it('asks which account to use rather than guessing', async () => {
    const t = build({
      resolution: {
        status: 'choose_connection',
        connections: [
          { connectionId: 'c1', label: 'Finance', access: 'read_write' },
          { connectionId: 'c2', label: 'Growth', access: 'read_write' },
        ],
      },
    });
    const result = await run(t, { operation: 'list_records', input: { datasheetId: 'dst1' } });

    assert.ok(result.ok);
    assert.equal((result.value.data as any).code, 'aitable_connection_selection_required');
  });
});

describe('AITable dead-key handling', () => {
  // Without this the failure is indistinguishable from a permissions problem
  // and repeats forever with nothing to act on.
  it('names the connection and the fix when the stored key was already known dead', async () => {
    const t = build({
      resolution: {
        status: 'needs_key',
        connections: [{ connectionId: 'c1', label: 'Finance workspace', access: 'admin' }],
      },
    });
    const result = await run(t, { operation: 'list_records', input: { datasheetId: 'dst1' } });

    assert.ok(result.ok);
    assert.equal((result.value.data as any).code, 'aitable_key_needs_replacing');
    assert.match(result.value.message!, /Finance workspace/);
    assert.match(result.value.message!, /Re-enter the key/i);
  });

  // A live call is the only moment a revoked key can be discovered, since
  // there is no refresh cycle to find it during.
  it('records a key rejected mid-call so it stops being offered', async () => {
    const t = build({
      client: { listRecords: async () => { throw new AitableError('invalid_key', 'unauthorized', 401); } },
    });
    const result = await run(t, {
      connectionId: '00000000-0000-4000-8000-000000000001',
      operation: 'list_records',
      input: { datasheetId: 'dst1' },
    });

    assert.deepEqual(t.rejected, [{ companyId: 'co-1', connectionId: 'conn-1' }]);
    assert.ok(result.ok);
    assert.equal((result.value.data as any).code, 'aitable_key_needs_replacing');
  });

  // 403 means the key is fine but was pointed somewhere it may not go.
  // Condemning it would be a self-inflicted outage.
  it('does not condemn the key when one datasheet is forbidden', async () => {
    const t = build({
      client: { listRecords: async () => { throw new AitableError('forbidden', 'no access', 403); } },
    });
    const result = await run(t, {
      connectionId: '00000000-0000-4000-8000-000000000001',
      operation: 'list_records',
      input: { datasheetId: 'dst1' },
    });

    assert.deepEqual(t.rejected, [], 'a working key must not be marked dead');
    assert.equal(result.ok, false);
  });

  it('treats rate limiting as retryable rather than fatal', async () => {
    const t = build({
      client: { listRecords: async () => { throw new AitableError('rate_limited', 'slow down', 429); } },
    });
    const result = await run(t, {
      connectionId: '00000000-0000-4000-8000-000000000001',
      operation: 'list_records',
      input: { datasheetId: 'dst1' },
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.payload.reason, 'retryable');
  });
});
