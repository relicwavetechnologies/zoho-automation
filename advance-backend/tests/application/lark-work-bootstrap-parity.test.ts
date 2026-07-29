import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { WorkBootstrapService } from '../../src/application/gateway/work-bootstrap.service';
import { createGovernedDiscoverSkillTool } from '../../src/application/orchestration/tools/orchestration/discover-governed-skill';
import { createResolveGovernedWorkTool } from '../../src/application/orchestration/tools/orchestration/resolve-governed-work';
import { ToolRegistry } from '../../src/application/orchestration/tools/tool-registry';
import { createAirtableMcpTools } from '../../src/application/orchestration/tools/families/airtable-mcp.tool';
import {
  TOOL_FAMILY_DEFINITIONS,
  TOOL_FAMILY_IDS,
  toolFamiliesForQuery,
  type ToolFamily,
} from '../../src/domain/tools/tool-id';
import { asToolId } from '../../src/shared/ids';
import { ok } from '../../src/shared/result';
import type { PermissionResult } from '../../src/application/permissions/permission.types';
import type { AccessibleConnection } from '../../src/application/connections/connection-registry.port';
import type { Tool } from '../../src/application/orchestration/tools/tool.contract';

const GMAIL_TOOL_ID = 'googleGmail';
const AIRTABLE_TOOL_ID = 'airtableRecords';
const SHARED_CONNECTION_ID = '8bba6aac-79aa-4729-9dd6-806f0238359e';
const SHARED_AIRTABLE_CONNECTION_ID = '26834d04-6276-4b46-bbf8-ca46a7a7ee61';

function permissionFor(toolId: string): PermissionResult {
  return {
    allowedToolIds: new Set([asToolId(toolId)]),
    allowedActionsByTool: new Map([[asToolId(toolId), new Set(['read' as const])]]),
    decisions: [],
  };
}

function registryWith(
  toolId: string,
  family: ToolFamily = 'google',
  parameterDocs = 'connectionId: required.',
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    id: asToolId(toolId),
    family,
    actionGroups: new Set(['read' as const]),
    argsSchema: z.object({
      connectionId: z.string().uuid(),
      op: z.enum(['describe', 'call']),
      nativeTool: z.string(),
      input: z.record(z.unknown()).optional(),
    }),
    resultSchema: z.object({}),
    description: `${family} capability`,
    parameterDocs,
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

const sharedAirtableAccount: AccessibleConnection = {
  connectionId: SHARED_AIRTABLE_CONNECTION_ID,
  provider: 'airtable',
  label: 'EMTL Airtable',
  accountEmail: 'abhishek@emiactech.com',
  ownerType: 'user',
  ownerUserId: 'owner-user',
  access: 'read_only',
  scopes: ['data.records:read'],
  connectedAt: new Date('2026-07-25T19:17:26.583Z'),
};

const gmailSkill = {
  id: 'skill-gmail',
  slug: 'gmail',
  name: 'Gmail',
  description: 'Read and send mail.',
  instructions: 'Use googleGmail.',
  toolIds: [GMAIL_TOOL_ID],
  aliases: [],
  tags: ['google', 'gmail'],
  revision: 1,
};

function bootstrapService(
  connections: AccessibleConnection[],
  toolId = GMAIL_TOOL_ID,
  family: ToolFamily = 'google',
  parameterDocs?: string,
): WorkBootstrapService {
  return new WorkBootstrapService({
    toolRegistry: registryWith(toolId, family, parameterDocs),
    connectionRegistry: {
      listAccessibleGoogleConnections: async () => ok(connections.filter(item => item.provider === 'google_workspace')),
      listAccessibleZohoConnections: async () => ok(connections.filter(item => item.provider === 'zoho')),
      listAccessibleCanvaConnections: async () => ok(connections.filter(item => item.provider === 'canva')),
      listAccessibleAirtableConnections: async () => ok(connections.filter(item => item.provider === 'airtable')),
      listAccessibleAitableConnections: async () => ok(connections.filter(item => item.provider === 'aitable')),
      listAccessibleLarkConnections: async () => ok(connections.filter(item => item.provider === 'lark')),
    },
  });
}

function discoverSkillTool(workBootstrap?: WorkBootstrapService) {
  return createGovernedDiscoverSkillTool({
    skillCatalog: {
      searchVisibleRouters: async () => [{
        skillId: gmailSkill.id,
        slug: gmailSkill.slug,
        name: gmailSkill.name,
        description: gmailSkill.description,
        score: 1,
        matchedTerms: ['mail'],
      }],
      getVisible: async ({ skillId }: { skillId: string }) =>
        skillId === gmailSkill.id ? gmailSkill : null,
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
  const executable = tool as unknown as {
    execute: (input: unknown) => Promise<string>;
  };
  const candidates = await executable.execute({ query: 'read my mail' });
  assert.match(candidates, /skill-gmail/);
  return executable.execute({ query: 'read my mail', skillId: gmailSkill.id });
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

  it('derives provider contracts and accounts when no recipe row exists', async () => {
    const query = 'Show me the Airtable connections available to me. Read only.';
    const tool = createResolveGovernedWorkTool({
      resolver: {
        resolve: async () => ({
          originalQuery: query,
          queries: [query],
          registryRevision: 3,
          persona: { rules: [], linkedSkills: [] },
          additionalSkills: [],
          rejectedSkills: [],
        }),
      } as never,
      companyId: 'company-1',
      userId: 'anish',
      permission: permissionFor(AIRTABLE_TOOL_ID),
      workBootstrap: bootstrapService(
        [sharedAirtableAccount],
        AIRTABLE_TOOL_ID,
        'airtable',
        'op: describe|call. nativeTool: list_bases.',
      ),
    });

    const output = await (tool as unknown as {
      execute: (input: unknown) => Promise<string>;
    }).execute({ query });

    assert.match(output, /Canonical capability contracts and accounts/);
    assert.match(output, /airtableRecords · airtable/);
    assert.match(output, /op: describe\|call/);
    assert.match(output, /Wrapper args schema/);
    assert.match(output, new RegExp(SHARED_AIRTABLE_CONNECTION_ID));
    assert.doesNotMatch(output, /Use discover_skill only/);
  });
});

describe('provider-neutral router bootstrap', () => {
  it('loads connection availability without loading every candidate tool contract', async () => {
    const service = bootstrapService(
      [sharedAirtableAccount],
      AIRTABLE_TOOL_ID,
      'airtable',
    );

    const bootstrap = await service.build({
      companyId: 'company-1',
      userId: 'user-1',
      permission: permissionFor(AIRTABLE_TOOL_ID),
      registryRevision: 1,
      query: 'How many customer queries are in each status?',
      toolIds: [],
      providerFamilies: ['airtable', 'aitable'],
    });

    assert.deepEqual(bootstrap.tools, []);
    assert.equal(bootstrap.connections.length, 1);
    assert.equal(bootstrap.connections[0]?.provider, 'airtable');
    assert.ok(bootstrap.advisories.some(
      advisory => advisory.code === 'connection_required' && advisory.provider === 'aitable',
    ));
  });
});

describe('canonical family routing metadata', () => {
  it('reconciles capabilities before both local and production startup', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };

    assert.equal(packageJson.scripts?.predev, 'pnpm capabilities:reconcile');
    assert.equal(packageJson.scripts?.prestart, 'pnpm capabilities:reconcile');
  });

  it('recognizes every configured provider alias without provider-specific branches', () => {
    for (const family of TOOL_FAMILY_IDS) {
      for (const alias of TOOL_FAMILY_DEFINITIONS[family].routingAliases) {
        assert.ok(
          toolFamiliesForQuery(`Use ${alias} for this work`).includes(family),
          `${alias} should route to ${family}`,
        );
      }
    }
  });

  it('does not tell backend channels to omit a required Airtable connection ID', () => {
    const [tool] = createAirtableMcpTools({
      getConnection: async () => ({ status: 'unavailable' }),
    });

    assert.match(tool!.parameterDocs, /connectionId: required for call/);
    assert.doesNotMatch(tool!.parameterDocs, /backend selects only one eligible account/);
  });

  it('uses family-derived tools only as a no-recipe fallback', async () => {
    const registry = registryWith(GMAIL_TOOL_ID);
    registry.register(registryWith(AIRTABLE_TOOL_ID, 'airtable').byId(asToolId(AIRTABLE_TOOL_ID))!);
    const permission: PermissionResult = {
      allowedToolIds: new Set([asToolId(GMAIL_TOOL_ID), asToolId(AIRTABLE_TOOL_ID)]),
      allowedActionsByTool: new Map([
        [asToolId(GMAIL_TOOL_ID), new Set(['read' as const])],
        [asToolId(AIRTABLE_TOOL_ID), new Set(['read' as const])],
      ]),
      decisions: [],
    };

    const result = await new WorkBootstrapService({ toolRegistry: registry }).build({
      companyId: 'company-1',
      userId: 'anish',
      permission,
      registryRevision: 1,
      query: 'Use Airtable after reading Gmail',
      toolIds: [GMAIL_TOOL_ID],
    });

    assert.deepEqual(result.tools.map(tool => tool.id), [GMAIL_TOOL_ID]);
  });
});
