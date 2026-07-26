import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WorkBootstrapService } from '../../src/application/gateway/work-bootstrap.service';
import { createGovernedDiscoverSkillTool } from '../../src/application/orchestration/tools/orchestration/discover-governed-skill';
import { createResolveGovernedWorkTool } from '../../src/application/orchestration/tools/orchestration/resolve-governed-work';
import { ToolRegistry } from '../../src/application/orchestration/tools/tool-registry';
import { asToolId } from '../../src/shared/ids';
import { ok } from '../../src/shared/result';
import type { PermissionResult } from '../../src/application/permissions/permission.types';
import type { AccessibleConnection } from '../../src/application/connections/connection-registry.port';
import type { Tool } from '../../src/application/orchestration/tools/tool.contract';

const GMAIL_TOOL_ID = 'googleGmail';
const SHARED_CONNECTION_ID = '8bba6aac-79aa-4729-9dd6-806f0238359e';

function permissionFor(toolId: string): PermissionResult {
  return {
    allowedToolIds: new Set([asToolId(toolId)]),
    allowedActionsByTool: new Map([[asToolId(toolId), new Set(['read' as const])]]),
    decisions: [],
  };
}

function registryWith(toolId: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    id: asToolId(toolId),
    family: 'google',
    actionGroups: new Set(['read' as const]),
    argsSchema: { _def: {} },
    resultSchema: { _def: {} },
    description: 'Gmail',
    parameterDocs: 'connectionId: required.',
    permissionCheck: () => ok('read' as const),
    execute: async () => ok({}),
  } as unknown as Tool<unknown, unknown>);
  return registry;
}

const sharedGoogleAccount: AccessibleConnection = {
  connectionId: SHARED_CONNECTION_ID,
  provider: 'google_workspace',
  label: 'Abhishek Google',
  accountEmail: 'abhishek@emiactech.com',
  ownerType: 'user',
  ownerUserId: 'owner-user',
  access: 'read_only',
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  connectedAt: new Date('2026-07-07T19:17:26.583Z'),
};

function bootstrapService(connections: AccessibleConnection[]): WorkBootstrapService {
  return new WorkBootstrapService({
    toolRegistry: registryWith(GMAIL_TOOL_ID),
    connectionRegistry: {
      listAccessibleGoogleConnections: async () => ok(connections),
      listAccessibleZohoConnections: async () => ok([]),
      listAccessibleCanvaConnections: async () => ok([]),
      listAccessibleAirtableConnections: async () => ok([]),
      listAccessibleLarkConnections: async () => ok([]),
    },
  });
}

function discoverSkillTool(workBootstrap?: WorkBootstrapService) {
  return createGovernedDiscoverSkillTool({
    skillCatalog: {
      searchVisible: async () => [{
        skill: {
          id: 'skill-gmail',
          slug: 'gmail',
          name: 'Gmail',
          description: 'Read and send mail.',
          instructions: 'Use googleGmail.',
          toolIds: [GMAIL_TOOL_ID],
        },
      }],
    } as never,
    companyId: 'company-1',
    userId: 'anish',
    permission: permissionFor(GMAIL_TOOL_ID),
    grantedSkillIds: new Set(['skill-gmail']),
    visibleSkills: [],
    permittedTools: [],
    ...(workBootstrap ? { workBootstrap } : {}),
  });
}

async function runDiscovery(tool: ReturnType<typeof discoverSkillTool>): Promise<string> {
  return await (tool as unknown as {
    execute: (input: unknown) => Promise<string>;
  }).execute({ query: 'read my mail' });
}

describe('Lark discovery carries the same account context desktop gets', () => {
  it('hands the model a shared account it could never have discovered otherwise', async () => {
    // The live failure this slice exists for. Anish held a read-only grant on
    // another member's Google account. The Gmail tool schema requires an exact
    // connectionId, `connections.list` is a gateway op the engine cannot reach,
    // and nothing preloaded the account — so the model guessed UUIDs until it
    // gave up and told him he had no Gmail access.
    const output = await runDiscovery(discoverSkillTool(bootstrapService([sharedGoogleAccount])));

    assert.match(output, new RegExp(SHARED_CONNECTION_ID));
    assert.match(output, /abhishek@emiactech\.com/);
  });

  it('tells the model to ask rather than guess when no account is shared', async () => {
    // The other half: absence has to arrive as an explicit instruction. Silence
    // reads identically to "not loaded yet" and invites the same guessing.
    const output = await runDiscovery(discoverSkillTool(bootstrapService([])));

    assert.doesNotMatch(output, new RegExp(SHARED_CONNECTION_ID));
    assert.match(output, /No accessible google_workspace account/);
    assert.match(output, /instead of guessing credentials/);
  });

  it('still loads the skill when no bootstrap is wired', async () => {
    // Discovery context is an addition, never a precondition: a caller without
    // a connection registry must still get its skill instructions.
    const output = await runDiscovery(discoverSkillTool(undefined));

    assert.match(output, /Approved skill loaded: Gmail/);
    assert.doesNotMatch(output, /Connected accounts/);
  });
});

function resolveWorkTool(workBootstrap?: WorkBootstrapService) {
  return createResolveGovernedWorkTool({
    resolver: {
      resolve: async () => ({
        originalQuery: 'read my mail',
        queries: ['read my mail'],
        registryRevision: 3,
        persona: { rules: [], linkedSkills: [] },
        additionalSkills: [{
          source: 'skill_search',
          matchedQueries: ['read my mail'],
          bestScore: 0.9,
          reason: 'strong match',
          skill: {
            id: 'skill-gmail',
            slug: 'gmail',
            name: 'Gmail',
            description: 'Read mail.',
            instructions: 'Use googleGmail.',
            toolIds: [GMAIL_TOOL_ID],
          },
        }],
        rejectedSkills: [],
      }),
    } as never,
    companyId: 'company-1',
    userId: 'anish',
    permission: permissionFor(GMAIL_TOOL_ID),
    ...(workBootstrap ? { workBootstrap } : {}),
  });
}

async function runResolve(tool: ReturnType<typeof resolveWorkTool>): Promise<string> {
  return await (tool as unknown as {
    execute: (input: unknown) => Promise<string>;
  }).execute({ query: 'read my mail' });
}

describe('Lark work resolution carries the same account context desktop gets', () => {
  it('attaches the account brief to a matched recipe', async () => {
    const output = await runResolve(resolveWorkTool(bootstrapService([sharedGoogleAccount])));

    assert.match(output, /Divo work context resolved for/);
    assert.match(output, new RegExp(SHARED_CONNECTION_ID));
  });

  it('returns the recipes even when the bootstrap throws', async () => {
    // Discovery context must never sink the resolution it decorates. Without
    // the brief the model is where it was before this existed; without the
    // recipes it has nothing at all.
    const exploding = {
      build: async () => { throw new Error('connection registry is down'); },
    } as unknown as WorkBootstrapService;

    const output = await runResolve(resolveWorkTool(exploding));

    assert.match(output, /Divo work context resolved for/);
    assert.match(output, /Use googleGmail\./);
    assert.doesNotMatch(output, /connection registry is down/);
  });
});
