import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createGoogleWorkspaceMcpTools,
  type GoogleWorkspaceMcpPort,
} from '../../src/application/orchestration/tools/families/google-workspace-mcp.tool';
import {
  GOOGLE_WORKSPACE_PRODUCTS,
  GOOGLE_WORKSPACE_TOOL_IDS,
  googleWorkspaceActionFor,
  googleWorkspaceScopeGroupsFor,
} from '../../src/application/google/google-workspace-mcp-manifest';
import { GOOGLE_SCOPE } from '../../src/domain/google/google-workspace-scope';
import { makeAllowedPerm, makeCtx, makeDeniedPerm } from './tool-test.helpers';

describe('Google Workspace MCP product tools', () => {
  it('creates exactly one governed tool for every manifest product', () => {
    const tools = createGoogleWorkspaceMcpTools({ getConnection: async () => null });
    assert.deepEqual(tools.map((tool) => tool.id), GOOGLE_WORKSPACE_TOOL_IDS);
    assert.equal(tools.length, 11);
  });

  it('rejects a native operation owned by another Google product', () => {
    const [gmail] = createGoogleWorkspaceMcpTools({ getConnection: async () => null });
    const result = gmail!.permissionCheck({
      connectionId: 'connection-1',
      op: 'call',
      nativeTool: 'create_spreadsheet',
      input: {},
    }, makeAllowedPerm('googleGmail', ['create']));
    assert.equal(result.ok, false);
  });

  it('describes a reviewed operation through the selected connection', async () => {
    const connectionRequests: unknown[] = [];
    const client: GoogleWorkspaceMcpPort = {
      describeTool: async (name) => ({ name, description: 'schema', inputSchema: { type: 'object' } }),
      callTool: async () => { throw new Error('unexpected call'); },
    };
    const tools = createGoogleWorkspaceMcpTools({
      getConnection: async (request) => {
        connectionRequests.push(request);
        return { status: 'resolved', connection: { client } };
      },
    });
    const docs = tools.find((tool) => tool.id === 'googleDocs')!;
    const result = await docs.execute({
      connectionId: 'connection-1',
      op: 'describe',
      nativeTool: 'create_doc',
      input: {},
    }, makeCtx('googleDocs', ['read']));

    assert.equal(result.ok, true);
    assert.deepEqual(connectionRequests, [{
      companyId: 'co-test',
      userId: 'user-test',
      connectionId: 'connection-1',
      minimumAccess: 'read_only',
      requiredScopeGroups: [],
    }]);
  });

  it('maps native mutation semantics to Divo action groups and scope requirements', async () => {
    const requests: any[] = [];
    const calls: any[] = [];
    const client: GoogleWorkspaceMcpPort = {
      describeTool: async () => null,
      callTool: async (name, input) => {
        calls.push({ name, input });
        return { spreadsheetId: 'sheet-1' };
      },
    };
    const tools = createGoogleWorkspaceMcpTools({
      getConnection: async (request) => {
        requests.push(request);
        return { status: 'resolved', connection: { client } };
      },
    });
    const sheets = tools.find((tool) => tool.id === 'googleSheets')!;
    const args = {
      connectionId: 'connection-1',
      op: 'call' as const,
      nativeTool: 'create_spreadsheet',
      input: { title: 'Quarterly plan' },
    };

    const permission = sheets.permissionCheck(args, makeAllowedPerm('googleSheets', ['create']));
    assert.equal(permission.ok, true);
    assert.equal(permission.ok && permission.value, 'create');
    const result = await sheets.execute(args, makeCtx('googleSheets', ['create']));
    assert.equal(result.ok, true);
    assert.equal(requests[0].minimumAccess, 'read_write');
    assert.deepEqual(requests[0].requiredScopeGroups, GOOGLE_WORKSPACE_PRODUCTS.find((p) => p.toolId === 'googleSheets')!.writeScopeGroups);
    assert.deepEqual(calls, [{ name: 'create_spreadsheet', input: { title: 'Quarterly plan' } }]);
  });

  it('preflights the selected connection and native schema without executing the operation', async () => {
    const requests: any[] = [];
    let executions = 0;
    const client: GoogleWorkspaceMcpPort = {
      describeTool: async (name) => ({
        name,
        inputSchema: {
          type: 'object',
          properties: { action: { const: 'create' }, summary: { type: 'string', minLength: 1 } },
          required: ['action', 'summary'],
          additionalProperties: false,
        },
      }),
      callTool: async () => { executions += 1; return {}; },
    };
    const calendar = createGoogleWorkspaceMcpTools({
      getConnection: async (request) => {
        requests.push(request);
        return { status: 'resolved', connection: { client } };
      },
    }).find((tool) => tool.id === 'googleCalendar')!;
    const ctx = makeCtx('googleCalendar', ['create']);

    const invalid = await calendar.preflight!({
      connectionId: '11111111-1111-4111-8111-111111111111',
      op: 'call', nativeTool: 'manage_event', input: {},
    }, ctx);
    const valid = await calendar.preflight!({
      connectionId: '11111111-1111-4111-8111-111111111111',
      op: 'call', nativeTool: 'manage_event', input: { action: 'create', summary: 'Vendor follow-up' },
    }, ctx);

    assert.equal(invalid.ok, false);
    assert.match(invalid.ok ? '' : invalid.error.message, /must have required property/i);
    assert.equal(valid.ok, true);
    assert.equal(executions, 0);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].minimumAccess, 'read_write');
    assert.deepEqual(valid.ok && valid.value, {
      level: 'native_schema_and_connection',
      connectionEligible: true,
      nativeSchemaValidated: true,
      nativeTool: 'manage_event',
      action: 'create',
    });
  });

  it('does not execute when the Divo action is denied', () => {
    const tasks = createGoogleWorkspaceMcpTools({ getConnection: async () => null })
      .find((tool) => tool.id === 'googleTasks')!;
    const result = tasks.permissionCheck({
      connectionId: 'connection-1',
      op: 'call',
      nativeTool: 'manage_task',
      input: { action: 'delete', task_list_id: 'list-1', task_id: 'task-1' },
    }, makeDeniedPerm());
    assert.equal(result.ok, false);
  });

  it('accepts describe without a synthetic native input object', async () => {
    const descriptions: string[] = [];
    const client: GoogleWorkspaceMcpPort = {
      describeTool: async (name) => {
        descriptions.push(name);
        return { name, inputSchema: { type: 'object' } };
      },
      callTool: async () => { throw new Error('unexpected call'); },
    };
    const gmail = createGoogleWorkspaceMcpTools({
      getConnection: async () => ({ status: 'resolved', connection: { client } }),
    }).find((tool) => tool.id === 'googleGmail')!;

    const parsed = gmail.argsSchema.safeParse({
      op: 'describe',
      nativeTool: 'search_gmail_messages',
    });
    assert.equal(parsed.success, true);
    if (!parsed.success) return;

    const result = await gmail.execute(parsed.data, makeCtx('googleGmail', ['read']));
    assert.equal(result.ok, true);
    assert.deepEqual(descriptions, ['search_gmail_messages']);
  });

  it('returns structured account choices instead of guessing an ambiguous connection', async () => {
    const gmail = createGoogleWorkspaceMcpTools({
      getConnection: async () => ({
        status: 'choose_connection',
        connections: [
          {
            connectionId: '11111111-1111-4111-8111-111111111111',
            label: 'Personal',
            accountEmail: 'personal@example.com',
            access: 'read_only',
          },
          {
            connectionId: '22222222-2222-4222-8222-222222222222',
            label: 'Work',
            accountEmail: 'work@example.com',
            access: 'read_write',
          },
        ],
      }),
    }).find((tool) => tool.id === 'googleGmail')!;

    const result = await gmail.execute({
      op: 'call',
      nativeTool: 'search_gmail_messages',
      input: { query: 'is:unread newer_than:14d' },
    }, makeCtx('googleGmail', ['read']));

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.value.data, {
      code: 'google_workspace_connection_selection_required',
      connections: [
        {
          connectionId: '11111111-1111-4111-8111-111111111111',
          label: 'Personal',
          accountEmail: 'personal@example.com',
          access: 'read_only',
        },
        {
          connectionId: '22222222-2222-4222-8222-222222222222',
          label: 'Work',
          accountEmail: 'work@example.com',
          access: 'read_write',
        },
      ],
    });
  });

  it('classifies destructive and executable native actions without a fallback switch', () => {
    assert.equal(googleWorkspaceActionFor('manage_event', { action: 'delete' }), 'delete');
    assert.equal(googleWorkspaceActionFor('manage_drive_access', { action: 'grant' }), 'create');
    assert.equal(googleWorkspaceActionFor('run_script_function', {}), 'execute');
  });

  it('keeps specialist native scopes in the reviewed operation matrix', () => {
    const gmail = GOOGLE_WORKSPACE_PRODUCTS.find((product) => product.toolId === 'googleGmail')!;
    const forms = GOOGLE_WORKSPACE_PRODUCTS.find((product) => product.toolId === 'googleForms')!;
    const appscript = GOOGLE_WORKSPACE_PRODUCTS.find((product) => product.toolId === 'googleAppsScript')!;
    assert.deepEqual(
      googleWorkspaceScopeGroupsFor(gmail, 'send_gmail_message', 'send'),
      [[GOOGLE_SCOPE.gmailSend, GOOGLE_SCOPE.gmailModify]],
    );
    assert(googleWorkspaceScopeGroupsFor(forms, 'list_form_responses', 'read')
      .some((group) => group.includes(GOOGLE_SCOPE.formsResponsesReadonly)));
    const executeScopes = googleWorkspaceScopeGroupsFor(appscript, 'run_script_function', 'execute');
    assert(executeScopes.some((group) => group.includes(GOOGLE_SCOPE.scriptExternalRequest)));
    assert(executeScopes.some((group) => group.includes(GOOGLE_SCOPE.scriptApp)));
    assert.deepEqual(
      googleWorkspaceScopeGroupsFor(
        GOOGLE_WORKSPACE_PRODUCTS.find((product) => product.toolId === 'googleSheets')!,
        'manage_sheet_data_validation',
        'update',
      ),
      [[GOOGLE_SCOPE.sheetsFull]],
    );
  });

  it('governs the Divo Sheets dropdown adapter as a Sheets update', async () => {
    const calls: unknown[] = [];
    const client: GoogleWorkspaceMcpPort = {
      describeTool: async (name) => ({ name, inputSchema: { type: 'object' } }),
      callTool: async (name, input) => { calls.push({ name, input }); return { updatedRanges: ['Sheet1!D2:D100'] }; },
    };
    const sheets = createGoogleWorkspaceMcpTools({
      getConnection: async () => ({ status: 'resolved', connection: { client } }),
    }).find((tool) => tool.id === 'googleSheets')!;
    const args = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      op: 'call' as const,
      nativeTool: 'manage_sheet_data_validation',
      input: {
        spreadsheet_id: 'sheet-1', action: 'set', ranges: ['Sheet1!D2:D100'],
        rule: { type: 'one_of_list', values: ['Open', 'Closed'] },
      },
    };

    const permission = sheets.permissionCheck(args, makeAllowedPerm('googleSheets', ['update']));
    assert.equal(permission.ok && permission.value, 'update');
    const result = await sheets.execute(args, makeCtx('googleSheets', ['update']));
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{ name: 'manage_sheet_data_validation', input: args.input }]);
  });

  it('rejects nested Sheet cells before connection lookup or provider mutation', async () => {
    let connectionLookups = 0;
    const sheets = createGoogleWorkspaceMcpTools({
      getConnection: async () => {
        connectionLookups += 1;
        return { status: 'unavailable' as const };
      },
    }).find((tool) => tool.id === 'googleSheets')!;
    const args = {
      connectionId: '11111111-1111-4111-8111-111111111111',
      op: 'call' as const,
      nativeTool: 'modify_sheet_values',
      input: {
        spreadsheet_id: 'sheet-1',
        range_name: 'Data!A1:B2',
        values: [
          ['Name', 'Metadata'],
          ['Alice', { source: 'gmail' }],
        ],
      },
    };

    const result = await sheets.execute(args, makeCtx('googleSheets', ['update']));

    assert.equal(result.ok, false);
    assert.equal(connectionLookups, 0);
    assert.match(
      result.ok ? '' : result.error.message,
      /values\[1\]\[1\].*serialize objects and arrays/i,
    );
  });
});
