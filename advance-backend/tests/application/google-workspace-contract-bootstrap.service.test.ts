import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GoogleWorkspaceContractBootstrapService,
  suggestedGoogleWorkspaceNativeTools,
} from '../../src/application/gateway/google-workspace-contract-bootstrap.service.ts';

const member = {
  companyId: 'company-1',
  userId: 'member-1',
  aiRole: 'MEMBER',
  email: 'member@example.com',
  larkOpenId: null,
  sessionId: 'session-1',
};

const connection = {
  connectionId: '8bba6aac-79aa-4729-9dd6-806f0238359e',
  provider: 'google_workspace' as const,
  label: 'Work Google',
  accountEmail: 'member@example.com',
  ownerType: 'user' as const,
  ownerUserId: 'member-1',
  access: 'read_write' as const,
  scopes: [],
  connectedAt: new Date('2026-07-01T00:00:00.000Z'),
};

describe('Google Workspace work-contract bootstrap', () => {
  it('selects the bounded source, destination, and verification contracts for Gmail to Sheets', () => {
    const selected = suggestedGoogleWorkspaceNativeTools(
      'Analyze Gmail, deduplicate records, create a spreadsheet with two tabs, write rows, then verify by reading back exact ranges',
      ['googleGmail', 'googleSheets'],
    );

    assert.deepEqual(selected, [
      { toolId: 'googleGmail', nativeTool: 'search_gmail_messages' },
      { toolId: 'googleGmail', nativeTool: 'get_gmail_messages_content_batch' },
      { toolId: 'googleSheets', nativeTool: 'create_spreadsheet' },
      { toolId: 'googleSheets', nativeTool: 'create_sheet' },
      { toolId: 'googleSheets', nativeTool: 'modify_sheet_values' },
      { toolId: 'googleSheets', nativeTool: 'read_sheet_values' },
    ]);
  });

  it('recognizes plain data-transfer wording without requiring implementation vocabulary', () => {
    assert.deepEqual(
      suggestedGoogleWorkspaceNativeTools(
        'Copy Gmail messages to a Google Sheet',
        ['googleGmail', 'googleSheets'],
      ),
      [
        { toolId: 'googleGmail', nativeTool: 'search_gmail_messages' },
        { toolId: 'googleGmail', nativeTool: 'get_gmail_messages_content_batch' },
        { toolId: 'googleSheets', nativeTool: 'create_spreadsheet' },
        { toolId: 'googleSheets', nativeTool: 'modify_sheet_values' },
      ],
    );

    assert.deepEqual(
      suggestedGoogleWorkspaceNativeTools(
        'Move CRM records into a Google Sheet',
        ['zohoCrm', 'googleSheets'],
      ),
      [
        { toolId: 'googleSheets', nativeTool: 'create_spreadsheet' },
        { toolId: 'googleSheets', nativeTool: 'modify_sheet_values' },
      ],
    );

    assert.deepEqual(
      suggestedGoogleWorkspaceNativeTools(
        'Copy Gmail messages to Sheets',
        ['googleGmail', 'googleSheets'],
      ),
      [
        { toolId: 'googleGmail', nativeTool: 'search_gmail_messages' },
        { toolId: 'googleGmail', nativeTool: 'get_gmail_messages_content_batch' },
        { toolId: 'googleSheets', nativeTool: 'create_spreadsheet' },
        { toolId: 'googleSheets', nativeTool: 'modify_sheet_values' },
      ],
    );
  });

  it('does not preload spreadsheet creation when an existing destination is explicit', () => {
    assert.deepEqual(
      suggestedGoogleWorkspaceNativeTools(
        'Transfer Gmail messages into the existing Google Sheet and check the result',
        ['googleGmail', 'googleSheets'],
      ),
      [
        { toolId: 'googleGmail', nativeTool: 'search_gmail_messages' },
        { toolId: 'googleGmail', nativeTool: 'get_gmail_messages_content_batch' },
        { toolId: 'googleSheets', nativeTool: 'modify_sheet_values' },
        { toolId: 'googleSheets', nativeTool: 'read_sheet_values' },
      ],
    );

    assert.deepEqual(
      suggestedGoogleWorkspaceNativeTools(
        'Move Gmail messages into the existing sheet',
        ['googleGmail', 'googleSheets'],
      ),
      [
        { toolId: 'googleGmail', nativeTool: 'search_gmail_messages' },
        { toolId: 'googleGmail', nativeTool: 'get_gmail_messages_content_batch' },
        { toolId: 'googleSheets', nativeTool: 'modify_sheet_values' },
      ],
    );
  });

  it('preloads formatting before the first call for ordinary spreadsheet editing language', () => {
    assert.deepEqual(
      suggestedGoogleWorkspaceNativeTools(
        'Tidy this existing Google Sheet: bold and center the header, then read back to verify it',
        ['googleSheets'],
      ),
      [
        { toolId: 'googleSheets', nativeTool: 'format_sheet_range' },
        { toolId: 'googleSheets', nativeTool: 'resize_sheet_dimensions' },
        { toolId: 'googleSheets', nativeTool: 'read_sheet_values' },
      ],
    );
  });

  it('preloads conditional formatting only when the requested styling needs it', () => {
    assert.deepEqual(
      suggestedGoogleWorkspaceNativeTools(
        'Beautify this spreadsheet with alternating row shading',
        ['googleSheets'],
      ),
      [
        { toolId: 'googleSheets', nativeTool: 'modify_sheet_values' },
        { toolId: 'googleSheets', nativeTool: 'format_sheet_range' },
        { toolId: 'googleSheets', nativeTool: 'resize_sheet_dimensions' },
        { toolId: 'googleSheets', nativeTool: 'manage_conditional_formatting' },
      ],
    );
  });

  it('loads schemas through one accessible connection without selecting it for execution', async () => {
    const resolutions: Array<Record<string, unknown>> = [];
    const described: string[] = [];
    const service = new GoogleWorkspaceContractBootstrapService(async (input) => {
      resolutions.push(input as unknown as Record<string, unknown>);
      return {
        status: 'resolved' as const,
        connection: {
          client: {
            describeTool: async (name: string) => {
              described.push(name);
              return {
                name,
                inputSchema: {
                  type: 'object',
                  properties: { query: { type: 'string' } },
                },
              };
            },
            callTool: async () => {
              throw new Error('contract bootstrap must not execute provider operations');
            },
          },
        },
      };
    });

    const result = await service.load({
      member,
      query: 'Search Gmail records and export them to a new spreadsheet, then verify the rows',
      toolIds: ['googleGmail', 'googleSheets'],
      connections: [connection],
    });

    assert.equal(resolutions.length, 1);
    assert.equal(resolutions[0]?.connectionId, connection.connectionId);
    assert.deepEqual(resolutions[0]?.requiredScopeGroups, []);
    assert.equal(resolutions[0]?.markLastUsed, false);
    assert.ok(described.includes('search_gmail_messages'));
    assert.ok(described.includes('create_spreadsheet'));
    assert.ok(described.includes('modify_sheet_values'));
    assert.ok(described.includes('read_sheet_values'));
    assert.equal(result.unavailableNativeTools.length, 0);
    assert.equal(result.contracts.length, described.length);
  });

  it('reports missing schemas explicitly instead of implying they were loaded', async () => {
    const service = new GoogleWorkspaceContractBootstrapService(async () => ({
      status: 'resolved' as const,
      connection: {
        client: {
          describeTool: async () => null,
          callTool: async () => undefined,
        },
      },
    }));

    const result = await service.load({
      member,
      query: 'Search Gmail',
      toolIds: ['googleGmail'],
      connections: [connection],
    });

    assert.deepEqual(result.contracts, []);
    assert.deepEqual(result.unavailableNativeTools, ['search_gmail_messages']);
  });

  it('fails open when connection or schema discovery is temporarily unavailable', async () => {
    const connectionFailure = new GoogleWorkspaceContractBootstrapService(async () => {
      throw new Error('schema sidecar unavailable');
    });
    const connectionResult = await connectionFailure.load({
      member,
      query: 'Search Gmail',
      toolIds: ['googleGmail'],
      connections: [connection],
    });
    assert.deepEqual(connectionResult.contracts, []);
    assert.deepEqual(connectionResult.unavailableNativeTools, ['search_gmail_messages']);

    const schemaFailure = new GoogleWorkspaceContractBootstrapService(async () => ({
      status: 'resolved' as const,
      connection: {
        client: {
          describeTool: async () => {
            throw new Error('catalog read failed');
          },
          callTool: async () => undefined,
        },
      },
    }));
    const schemaResult = await schemaFailure.load({
      member,
      query: 'Search Gmail',
      toolIds: ['googleGmail'],
      connections: [connection],
    });
    assert.deepEqual(schemaResult.contracts, []);
    assert.deepEqual(schemaResult.unavailableNativeTools, ['search_gmail_messages']);
  });

  it('forwards and does not swallow cancellation during schema discovery', async () => {
    const controller = new AbortController();
    let describedWith: AbortSignal | undefined;
    const service = new GoogleWorkspaceContractBootstrapService(async () => ({
      status: 'resolved' as const,
      connection: {
        client: {
          describeTool: async (_name: string, abortSignal?: AbortSignal) => {
            describedWith = abortSignal;
            return new Promise((_resolve, reject) => {
              abortSignal?.addEventListener(
                'abort',
                () => reject(abortSignal.reason),
                { once: true },
              );
            });
          },
          callTool: async () => undefined,
        },
      },
    }));

    const pending = service.load({
      member,
      query: 'Search Gmail',
      toolIds: ['googleGmail'],
      connections: [connection],
      abortSignal: controller.signal,
    });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new Error('schema discovery cancelled'));

    await assert.rejects(pending, /schema discovery cancelled/);
    assert.equal(describedWith, controller.signal);
  });
});
