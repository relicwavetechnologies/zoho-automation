import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderWorkBootstrapBrief } from '../../src/application/orchestration/tools/orchestration/work-bootstrap-brief';
import type { WorkBootstrap } from '../../src/application/gateway/work-bootstrap.service';

function bootstrap(overrides: Partial<WorkBootstrap> = {}): WorkBootstrap {
  return {
    version: 1,
    scope: 'run',
    registryRevision: 7,
    tools: [],
    nativeContracts: [],
    connections: [],
    advisories: [],
    ...overrides,
  };
}

describe('renderWorkBootstrapBrief', () => {
  it('gives the model the exact connectionId it is required to pass', () => {
    // The whole point of the slice. The Google tool schema rejects a call
    // without a connectionId, and on Lark there is no connections.list to ask.
    // If this ID is not in the prompt the model can only guess.
    const brief = renderWorkBootstrapBrief(bootstrap({
      connections: [{
        connectionId: '8bba6aac-79aa-4729-9dd6-806f0238359e',
        provider: 'google_workspace',
        label: 'Abhishek Google',
        accountEmail: 'abhishek@emiactech.com',
        accountName: null,
        ownerType: 'user',
        ownerUserId: 'owner-1',
        access: 'read_only',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        connectedAt: '2026-07-07T19:17:26.583Z',
        lastUsedAt: null,
      }],
    }));

    assert.match(brief, /8bba6aac-79aa-4729-9dd6-806f0238359e/);
    assert.match(brief, /abhishek@emiactech\.com/);
    assert.match(brief, /read_only/);
    assert.match(brief, /Never invent, guess, or reformat one/);
  });

  it('leaves scopes out of the prompt', () => {
    // A single Workspace account carries forty-odd scope URLs. The model cannot
    // act on them and the connection layer re-checks them on every call, so
    // they are pure token cost.
    const brief = renderWorkBootstrapBrief(bootstrap({
      connections: [{
        connectionId: 'c1',
        provider: 'google_workspace',
        label: 'Account',
        accountEmail: 'a@b.com',
        accountName: null,
        ownerType: 'user',
        ownerUserId: null,
        access: 'admin',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        connectedAt: '2026-07-07T19:17:26.583Z',
        lastUsedAt: null,
      }],
    }));

    assert.doesNotMatch(brief, /googleapis\.com/);
  });

  it('drops an oversized native schema rather than truncating it', () => {
    // A half-written JSON schema still reads as complete and teaches wrong
    // field names, which is worse than the describe round-trip it saved.
    const brief = renderWorkBootstrapBrief(bootstrap({
      nativeContracts: [{
        toolId: 'googleGmail',
        nativeTool: 'huge_operation',
        inputSchema: { blob: 'x'.repeat(5_000) },
      }],
    }));

    assert.doesNotMatch(brief, /xxxx/);
    assert.match(brief, /too large to preload/);
    assert.match(brief, /googleGmail · huge_operation/);
  });

  it('inlines a native schema small enough to be worth the tokens', () => {
    const brief = renderWorkBootstrapBrief(bootstrap({
      nativeContracts: [{
        toolId: 'googleGmail',
        nativeTool: 'search_gmail_messages',
        description: 'Searches messages.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      }],
    }));

    assert.match(brief, /search_gmail_messages/);
    assert.match(brief, /"properties":\{"query"/);
    assert.doesNotMatch(brief, /too large to preload/);
  });

  it('says nothing when there is nothing to say', () => {
    // An empty brief must append nothing, not an empty heading that reads to
    // the model as "no accounts exist".
    assert.equal(renderWorkBootstrapBrief(bootstrap()), '');
  });

  it('carries only required advisories', () => {
    const brief = renderWorkBootstrapBrief(bootstrap({
      advisories: [
        { code: 'connection_required', level: 'required', instruction: 'Ask the user to connect one.' },
        { code: 'native_contracts_loaded', level: 'info', instruction: 'Background detail.' },
      ],
    }));

    assert.match(brief, /Ask the user to connect one\./);
    assert.doesNotMatch(brief, /Background detail\./);
  });

  it('carries the exact governed wrapper contract into backend-hosted channels', () => {
    // Lark exposes only call_tool's generic SDK schema. Without this underlying
    // contract a no-recipe fallback knows the tool ID but must guess its args.
    const brief = renderWorkBootstrapBrief(bootstrap({
      tools: [{
        id: 'airtableRecords',
        family: 'airtable',
        description: 'Read Airtable records.',
        allowedActions: ['read'],
        parameterDocs: 'op: describe|call. nativeTool: list_bases.',
        argsSchema: {
          type: 'object',
          properties: {
            op: { enum: ['describe', 'call'] },
            nativeTool: { type: 'string' },
          },
          required: ['op', 'nativeTool'],
        },
      }],
      advisories: [{
        code: 'contracts_loaded',
        level: 'required',
        instruction: 'Exact tool contracts for this work are already loaded below. Do not call tools.list again for these tools during this run.',
      }],
    }));

    assert.match(brief, /Governed tool contracts already loaded/);
    assert.match(brief, /airtableRecords · airtable/);
    assert.match(brief, /op: describe\|call/);
    assert.match(brief, /"required":\["op","nativeTool"\]/);
    assert.doesNotMatch(brief, /tools\.list/);
  });

  it('does not forbid describing contracts it had to drop', () => {
    // The size cap and the advisory were decided independently, so a bootstrap
    // whose every schema was oversized still carried "do not call describe
    // again" — next to a section saying describe them. The required-level
    // instruction wins, and on a write operation that means invented field
    // names.
    const brief = renderWorkBootstrapBrief(bootstrap({
      nativeContracts: [{
        toolId: 'googleGmail',
        nativeTool: 'send_gmail_message',
        inputSchema: { blob: 'x'.repeat(5_000) },
      }],
      advisories: [{
        code: 'native_contracts_loaded',
        level: 'required',
        instruction: 'Likely native operation contracts for this workflow are already loaded below. Use their exact field names and do not call describe again for these operations during this run.',
      }],
    }));

    assert.doesNotMatch(brief, /do not call describe again/);
    assert.match(brief, /too large to preload/);
  });

  it('keeps the describe ban when contracts did survive', () => {
    const brief = renderWorkBootstrapBrief(bootstrap({
      nativeContracts: [{
        toolId: 'googleGmail',
        nativeTool: 'search_gmail_messages',
        inputSchema: { type: 'object' },
      }],
      advisories: [{
        code: 'native_contracts_loaded',
        level: 'required',
        instruction: 'Likely native operation contracts for this workflow are already loaded below. Use their exact field names and do not call describe again for these operations during this run.',
      }],
    }));

    assert.match(brief, /do not call describe again/);
  });

  it('does not claim accounts are listed when none are', () => {
    // Same failure shape one section over: the advisory is emitted by the
    // service, the list is rendered here, and only the pair is meaningful.
    const brief = renderWorkBootstrapBrief(bootstrap({
      advisories: [{
        code: 'connections_loaded',
        level: 'required',
        instruction: 'Accessible accounts required by this work are already loaded below.',
      }],
    }));

    assert.equal(brief, '');
  });

  it('rewrites advisories that name unreachable gateway operations', () => {
    // `connections.list` exists only on the gateway. Telling a Lark run not to
    // call it again implies it could have, which is the confusion that led the
    // model to invent `op: 'connections'` against the Gmail tool.
    const brief = renderWorkBootstrapBrief(bootstrap({
      connections: [{
        connectionId: 'c1',
        provider: 'google_workspace',
        label: 'Account',
        accountEmail: 'a@b.com',
        accountName: null,
        ownerType: 'user',
        ownerUserId: null,
        access: 'read_only',
        scopes: [],
        connectedAt: '2026-07-07T19:17:26.583Z',
        lastUsedAt: null,
      }],
      advisories: [{
        code: 'connections_loaded',
        level: 'required',
        instruction: 'Accessible accounts required by this work are already loaded below. Reuse the selected exact connectionId and do not call connections.list again during this run.',
      }],
    }));

    assert.doesNotMatch(brief, /connections\.list/);
    assert.match(brief, /Reuse one of those exact connectionId values/);
  });
});
