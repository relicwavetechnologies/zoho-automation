import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONNECTION_PROVIDER_NOT_SUPPORTED,
  createConnectionsTool,
} from '../../src/application/tools/families/connections.tool';
import { googleScopeGroupsForToolIds } from '../../src/application/google/google-scope-request';
import { makeAllowedPerm, makeCtx } from '../tools/tool-test.helpers';

describe('connectApp tool', () => {
  it('publishes a provider-neutral schema with toolIds and no scopes escape hatch', () => {
    const tool = createConnectionsTool({ connectionRequest: { request: async () => ({ status: 'unreachable' }) } });
    assert.equal(tool.id, 'connectApp');
    assert.equal(tool.argsSchema.safeParse({
      provider: 'google_workspace',
      toolIds: ['googleDrive', 'googleSheets'],
    }).success, true);
    assert.equal(tool.argsSchema.safeParse({
      provider: 'google_workspace',
      toolIds: ['googleDrive'],
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    }).success, false);
    assert.equal(tool.argsSchema.safeParse({
      provider: 'google_workspace',
      toolIds: [],
    }).success, false);
  });

  it('derives the narrow Google scope groups and sends one shared ask', async () => {
    const asks: any[] = [];
    const tool = createConnectionsTool({
      connectionRequest: {
        request: async input => {
          asks.push(input);
          return { status: 'sent', intentId: 'intent-1' };
        },
      },
    });
    const result = await tool.execute({
      provider: 'google_workspace',
      toolIds: ['googleDrive', 'googleSheets'],
    }, makeCtx('connectApp', ['create'], { runtimeRunId: 'run-1' }));

    assert.equal(result.ok, true);
    assert.deepEqual(asks[0].gap.toolIds, ['googleDrive', 'googleSheets']);
    assert.deepEqual(asks[0].gap.missingScopeGroups, googleScopeGroupsForToolIds(['googleDrive', 'googleSheets']));
    assert.deepEqual(result.ok ? result.value : undefined, {
      success: false,
      code: 'connection_ask_sent',
      intentId: 'intent-1',
      provider: 'google_workspace',
      message: 'A Google connection ask was sent to the member. End this run and wait for OAuth to complete.',
    });
  });

  it('hard fails unsupported providers with a named error', async () => {
    let called = false;
    const tool = createConnectionsTool({
      connectionRequest: { request: async () => { called = true; return { status: 'sent', intentId: 'unexpected' }; } },
    });
    const result = await tool.execute({
      provider: 'shopify',
      toolIds: ['shopifyAnalytics'],
    }, makeCtx('connectApp', ['create']));

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.payload.reason, 'bad_args');
    assert.match(result.error.message, new RegExp(CONNECTION_PROVIDER_NOT_SUPPORTED));
    assert.equal(called, false);
  });

  it('rejects unknown tool ids before asking for consent', async () => {
    const tool = createConnectionsTool({ connectionRequest: { request: async () => ({ status: 'sent', intentId: 'unexpected' }) } });
    const result = await tool.execute({
      provider: 'google_workspace',
      toolIds: ['googleDrive', 'drive.files.list'],
    }, makeCtx('connectApp', ['create']));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error.message, /connection_tool_id_unknown/);
  });

  it('requires the connectApp permission', () => {
    const tool = createConnectionsTool({ connectionRequest: { request: async () => ({ status: 'unreachable' }) } });
    assert.equal(tool.permissionCheck({ provider: 'google_workspace', toolIds: ['googleDrive'] }, makeAllowedPerm('connectApp', ['create'])).ok, true);
  });
});
