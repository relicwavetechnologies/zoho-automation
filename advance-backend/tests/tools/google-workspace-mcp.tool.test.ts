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
        return { client, accountEmail: 'member@example.com' };
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
        return { client, accountEmail: 'member@example.com' };
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
  });
});
