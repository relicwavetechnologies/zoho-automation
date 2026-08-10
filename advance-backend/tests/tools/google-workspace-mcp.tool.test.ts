import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createGoogleWorkspaceMcpTools,
  type GoogleWorkspaceMcpPort,
} from '../../src/application/tools/families/google-workspace-mcp.tool';
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

  it('publishes only each product\'s approved native operation names to Pi', () => {
    const sheets = createGoogleWorkspaceMcpTools({ getConnection: async () => null })
      .find(tool => tool.id === 'googleSheets')!;

    assert.equal(sheets.argsSchema.safeParse({ op: 'describe', nativeTool: 'format_sheet_range' }).success, true);
    assert.equal(sheets.argsSchema.safeParse({ op: 'describe', nativeTool: 'send_gmail_message' }).success, false);
    assert.equal(sheets.argsSchema.safeParse({ op: 'describe', nativeTool: 'get_values' }).success, false);
  });

  it('publishes the governed resolved-Sheet call in the Pi contract', () => {
    const tools = createGoogleWorkspaceMcpTools({ getConnection: async () => null });
    const sheets = tools.find(tool => tool.id === 'googleSheets')!;
    const gmail = tools.find(tool => tool.id === 'googleGmail')!;
    const handle = '11111111-1111-4111-8111-111111111111';

    assert.equal(sheets.argsSchema.safeParse({
      op: 'call_resolved_sheet',
      destinationReferenceId: handle,
      nativeTool: 'format_sheet_range',
      input: { range: 'A1:B2' },
    }).success, true);
    assert.equal(sheets.argsSchema.safeParse({
      op: 'call_resolved_sheet',
      destinationReferenceId: handle,
      nativeTool: 'send_gmail_message',
      input: {},
    }).success, false);
    assert.equal(gmail.argsSchema.safeParse({
      op: 'call_resolved_sheet',
      destinationReferenceId: handle,
      nativeTool: 'search_gmail_messages',
      input: {},
    }).success, false);
    assert.equal(gmail.argsSchema.safeParse({
      op: 'resolve_reference',
      url: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
    }).success, false);
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

  it('resolves a pasted Sheet through the backend-owned resource resolver', async () => {
    const requests: unknown[] = [];
    let connectionLookups = 0;
    const sheets = createGoogleWorkspaceMcpTools({
      getConnection: async () => {
        connectionLookups += 1;
        return { status: 'unavailable' as const };
      },
      resolveSheetReference: async request => {
        requests.push(request);
        return {
          status: 'resolved',
          resource: {
            provider: 'google',
            kind: 'spreadsheet',
            resourceId: 'sheet-1',
            connectionId: '11111111-1111-4111-8111-111111111111',
            canonicalUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
          },
        };
      },
    }).find((tool) => tool.id === 'googleSheets')!;
    const parsed = sheets.argsSchema.safeParse({
      op: 'resolve_reference',
      url: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
    });
    assert.equal(parsed.success, true);
    if (!parsed.success) return;

    const permission = sheets.permissionCheck(parsed.data, makeAllowedPerm('googleSheets', ['read']));
    assert.equal(permission.ok && permission.value, 'read');
    const result = await sheets.execute(parsed.data, makeCtx('googleSheets', ['read']));

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.success, true);
    assert.equal(connectionLookups, 0);
    assert.deepEqual(requests, [{
      companyId: 'co-test',
      userId: 'user-test',
      url: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
    }]);
  });

  it('starts resumable Google authorization when no personal account can open a pasted Sheet', async () => {
    const authorizationReasons: string[] = [];
    const sheets = createGoogleWorkspaceMcpTools({
      getConnection: async () => ({ status: 'unavailable' as const }),
      resolveSheetReference: async () => ({ status: 'no_connection' }),
      beginAuthorization: async request => {
        authorizationReasons.push(request.reason);
        return { status: 'sent', intentId: 'intent-1' };
      },
    }).find((tool) => tool.id === 'googleSheets')!;
    const parsed = sheets.argsSchema.safeParse({
      op: 'resolve_reference',
      url: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
    });
    assert.equal(parsed.success, true);
    if (!parsed.success) return;

    const result = await sheets.execute(parsed.data, makeCtx('googleSheets', ['read']));

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.success, false);
    assert.deepEqual(result.ok && result.value.data, {
      code: 'google_workspace_authorization_pending',
      intentId: 'intent-1',
    });
    assert.deepEqual(authorizationReasons, [
      'Connect a writable personal Google account to open this Sheet.',
    ]);
  });

  it('starts Google re-consent when a Sheet connection lacks full write scopes', async () => {
    const authorizationReasons: string[] = [];
    const sheets = createGoogleWorkspaceMcpTools({
      getConnection: async () => ({ status: 'unavailable' as const }),
      resolveSheetReference: async () => ({ status: 'missing_scope' }),
      beginAuthorization: async request => {
        authorizationReasons.push(request.reason);
        return { status: 'sent', intentId: 'intent-2' };
      },
    }).find((tool) => tool.id === 'googleSheets')!;
    const parsed = sheets.argsSchema.safeParse({
      op: 'resolve_reference',
      url: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
    });
    assert.equal(parsed.success, true);
    if (!parsed.success) return;

    const result = await sheets.execute(parsed.data, makeCtx('googleSheets', ['read']));

    assert.equal(result.ok && result.value.success, false);
    assert.deepEqual(authorizationReasons, [
      'Reconnect Google to grant Drive and Sheets write access for this Sheet.',
    ]);
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

  /**
   * The three-trip loop this removes: call fails on a field name, model calls
   * describe to learn the contract, model repeats the call. The schema is
   * already known here, so it travels with the rejection.
   */
  it('returns the native schema alongside a rejected argument name', async () => {
    let describeCalls = 0;
    const client: GoogleWorkspaceMcpPort = {
      describeTool: async (name) => {
        describeCalls += 1;
        return { name, description: 'schema', inputSchema: { type: 'object', properties: { page_size: { type: 'integer' } } } };
      },
      callTool: async () => {
        throw new Error('1 validation error for call[search_gmail_messages]\nmaxResults\n  Extra inputs are not permitted');
      },
    };
    const tools = createGoogleWorkspaceMcpTools({
      getConnection: async () => ({ status: 'resolved', connection: { client } }),
    });
    const gmail = tools.find((tool) => tool.id === 'googleGmail')!;
    const result = await gmail.execute({
      connectionId: 'connection-1',
      op: 'call',
      nativeTool: 'search_gmail_messages',
      input: { maxResults: 20 },
    }, makeCtx('googleGmail', ['read']));

    assert.equal(result.ok, false);
    const message = result.ok ? '' : String((result.error as { message?: string }).message);
    // The original rejection survives — it is still the useful part.
    assert.match(message, /Extra inputs are not permitted/);
    // And the answer to the model's next question arrives with it.
    assert.match(message, /page_size/);
    assert.match(message, /do not call describe/i);
    assert.equal(describeCalls, 1);
  });

  it('leaves a failure that is not about the contract alone', async () => {
    let describeCalls = 0;
    const client: GoogleWorkspaceMcpPort = {
      describeTool: async () => { describeCalls += 1; return null; },
      callTool: async () => { throw new Error('Quota exceeded for quota metric'); },
    };
    const tools = createGoogleWorkspaceMcpTools({
      getConnection: async () => ({ status: 'resolved', connection: { client } }),
    });
    const gmail = tools.find((tool) => tool.id === 'googleGmail')!;
    const result = await gmail.execute({
      connectionId: 'connection-1',
      op: 'call',
      nativeTool: 'search_gmail_messages',
      input: {},
    }, makeCtx('googleGmail', ['read']));

    assert.equal(result.ok, false);
    // A quota problem is not a contract problem; a schema under it is noise.
    assert.equal(describeCalls, 0);
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

  it('passes parent cancellation through connection resolution and MCP execution', async () => {
    const controller = new AbortController();
    let connectionSignal: AbortSignal | undefined;
    let callSignal: AbortSignal | undefined;
    const client: GoogleWorkspaceMcpPort = {
      describeTool: async () => null,
      callTool: async (_name, _input, abortSignal) => {
        callSignal = abortSignal;
        return { spreadsheetId: 'sheet-1' };
      },
    };
    const sheets = createGoogleWorkspaceMcpTools({
      getConnection: async (request) => {
        connectionSignal = request.abortSignal;
        return { status: 'resolved', connection: { client } };
      },
    }).find((tool) => tool.id === 'googleSheets')!;

    const result = await sheets.execute({
      connectionId: '11111111-1111-4111-8111-111111111111',
      op: 'call',
      nativeTool: 'create_spreadsheet',
      input: { title: 'Quarterly plan' },
    }, {
      ...makeCtx('googleSheets', ['create']),
      abortSignal: controller.signal,
    });

    assert.equal(result.ok, true);
    assert.equal(connectionSignal, controller.signal);
    assert.equal(callSignal, controller.signal);
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

  it('names a usable account rather than declaring the member has none', async () => {
    // The model guessed a well-formed UUID. Told only "connection unavailable",
    // it concluded the member had no Gmail at all and said so — while he held a
    // read-only grant on a shared account. The reachable account has to appear
    // in the error, or the run has no way back.
    const gmail = createGoogleWorkspaceMcpTools({
      getConnection: async () => ({
        status: 'unavailable',
        reason: 'requested_not_accessible',
        accessible: [{
          connectionId: '8bba6aac-79aa-4729-9dd6-806f0238359e',
          label: 'Shared Google',
          accountEmail: 'abhishek@emiactech.com',
          access: 'read_only',
        }],
      }),
    }).find((tool) => tool.id === 'googleGmail')!;

    const result = await gmail.execute({
      op: 'call',
      connectionId: '11111111-1111-4111-8111-111111111111',
      nativeTool: 'search_gmail_messages',
      input: { query: 'is:unread' },
    }, makeCtx('googleGmail', ['read']));

    assert.equal(result.ok, false);
    const message = !result.ok ? result.error.message : '';
    assert.match(message, /8bba6aac-79aa-4729-9dd6-806f0238359e/);
    assert.match(message, /abhishek@emiactech\.com/);
  });

  it('offers a stronger account when the named one is too weak', async () => {
    // A read-only account cannot send. If a read_write account is also shared,
    // stranding the run without naming it turns a solvable request into a dead
    // end — and telling the model not to switch accounts guarantees it.
    const gmail = createGoogleWorkspaceMcpTools({
      getConnection: async () => ({
        status: 'unavailable',
        reason: 'insufficient_access',
        accessible: [{
          connectionId: '22222222-2222-4222-8222-222222222222',
          label: 'Work',
          accountEmail: 'work@example.com',
          access: 'read_write',
        }],
      }),
    }).find((tool) => tool.id === 'googleGmail')!;

    const result = await gmail.execute({
      op: 'call',
      connectionId: '11111111-1111-4111-8111-111111111111',
      nativeTool: 'send_gmail_message',
      input: { to: ['a@b.com'], subject: 's', body: 'b' },
    }, makeCtx('googleGmail', ['send']));

    assert.equal(result.ok, false);
    const message = !result.ok ? result.error.message : '';
    assert.match(message, /22222222-2222-4222-8222-222222222222/);
    assert.doesNotMatch(message, /switch accounts/);
  });

  it('tells the model to stop when the member genuinely has no account', async () => {
    const gmail = createGoogleWorkspaceMcpTools({
      getConnection: async () => ({
        status: 'unavailable',
        reason: 'none_accessible',
        accessible: [],
      }),
    }).find((tool) => tool.id === 'googleGmail')!;

    const result = await gmail.execute({
      op: 'call',
      connectionId: '11111111-1111-4111-8111-111111111111',
      nativeTool: 'search_gmail_messages',
      input: { query: 'is:unread' },
    }, makeCtx('googleGmail', ['read']));

    assert.equal(result.ok, false);
    const message = !result.ok ? result.error.message : '';
    assert.match(message, /no Gmail account connected or shared/);
    assert.match(message, /do not retry/);
  });

  it('starts deferred OAuth from backend-owned Lark context when no account exists', async () => {
    let authorizationInput: any;
    const gmail = createGoogleWorkspaceMcpTools({
      getConnection: async () => ({
        status: 'unavailable',
        reason: 'none_accessible',
        accessible: [],
      }),
      beginAuthorization: async (input) => {
        authorizationInput = input;
        return { status: 'sent', intentId: 'intent-1' };
      },
    }).find((tool) => tool.id === 'googleGmail')!;
    const result = await gmail.execute({
      op: 'call',
      connectionId: '11111111-1111-4111-8111-111111111111',
      nativeTool: 'search_gmail_messages',
      input: { query: 'newer_than:1d OTP' },
    }, makeCtx('googleGmail', ['read'], { runtimeRunId: 'run-1' }));

    assert.equal(result.ok, true);
    assert.equal(result.ok && (result.value.data as any).code, 'google_workspace_authorization_pending');
    assert.equal(authorizationInput.toolId, 'googleGmail');
    // See the note in mail-automations.tool.test.ts: the tool forwards the live
    // run context, and whether an authorization can start from it is proved
    // against the real closure in begin-google-authorization.test.ts.
    assert.equal(authorizationInput.runContext.runtimeRunId, 'run-1');
    assert.match(result.ok ? result.value.message ?? '' : '', /fresh run automatically/);
  });

  it('points a member at Connected apps when no card can be sent', async () => {
    // Off Lark there is no conversation to deliver a Connect card into, so the
    // tool used to return the bare connection problem — accurate, and useless.
    const gmail = createGoogleWorkspaceMcpTools({
      getConnection: async () => ({
        status: 'unavailable',
        reason: 'none_accessible',
        accessible: [],
      }),
    }).find((tool) => tool.id === 'googleGmail')!;

    const result = await gmail.execute({
      op: 'call',
      connectionId: '11111111-1111-4111-8111-111111111111',
      nativeTool: 'search_gmail_messages',
      input: { query: 'newer_than:1d OTP' },
    }, makeCtx('googleGmail', ['read'], {}));

    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error.message : '', /Connected apps/);
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
