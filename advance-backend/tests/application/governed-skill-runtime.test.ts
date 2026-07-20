import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { createGovernedDiscoverSkillTool } from '../../src/application/orchestration/tools/orchestration/discover-governed-skill.ts';
import { createCallToolTool } from '../../src/application/orchestration/tools/orchestration/call-tool.ts';
import { createResolveGovernedWorkTool } from '../../src/application/orchestration/tools/orchestration/resolve-governed-work.ts';
import { ToolRegistry } from '../../src/application/orchestration/tools/tool-registry.ts';
import { ToolExecutor } from '../../src/application/gateway/tool-executor.ts';
import { buildBrainSystemPrompt } from '../../src/application/orchestration/brain-prompt.ts';
import { asToolId } from '../../src/shared/ids.ts';
import { ok } from '../../src/shared/result.ts';

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: function () { return this; },
} as any;

const permission = {
  allowedToolIds: new Set([asToolId('larkDoc')]),
  allowedActionsByTool: new Map(),
  decisions: [],
} as any;

function appTool(id: string, docs: string, execute?: () => Promise<any>) {
  return {
    id: asToolId(id),
    family: 'lark',
    actionGroups: new Set(['read']),
    argsSchema: z.object({ op: z.string() }),
    resultSchema: z.unknown(),
    description: `${id} description`,
    parameterDocs: docs,
    permissionCheck: () => ok('read'),
    execute: execute ?? (async () => ok({ done: id })),
  } as any;
}

async function executeDynamic(tool: unknown, input: unknown): Promise<string> {
  return (tool as any).execute(input, { toolCallId: 'call-1', messages: [] });
}

describe('governed DB skill tools', () => {
  it('loads DB instructions but exposes only request-permitted tool documentation', async () => {
    const allowed = appTool('larkDoc', 'Allowed document schema');
    const denied = appTool('larkMessaging', 'Denied messaging schema');
    const skill = {
      id: 'skill-1', slug: 'lark-documents', name: 'Lark Documents',
      description: 'Create Lark docs', instructions: 'Return the canonical document URL.',
      toolIds: ['larkDoc', 'larkMessaging'], revision: 3,
    };
    const skillCatalog = {
      searchVisible: async (input: any) => {
        assert.equal(input.companyId, 'company-1');
        assert.equal(input.grantedSkillIds.has('skill-1'), true);
        return [{ skill, score: 9 }];
      },
    } as any;

    const tool = createGovernedDiscoverSkillTool({
      skillCatalog,
      companyId: 'company-1',
      permission,
      grantedSkillIds: new Set(['skill-1']),
      visibleSkills: [skill],
      permittedTools: [allowed],
    });
    const output = await executeDynamic(tool, { query: 'create a lark document' });

    assert.match(output, /Return the canonical document URL/);
    assert.match(output, /Allowed document schema/);
    assert.doesNotMatch(output, /Denied messaging schema/);
    assert.doesNotMatch(output, /larkMessaging/);
    void denied;
  });

  it('fails closed when no approved skill matches', async () => {
    const tool = createGovernedDiscoverSkillTool({
      skillCatalog: { searchVisible: async () => [] } as any,
      companyId: 'company-1',
      permission,
      grantedSkillIds: new Set(),
      visibleSkills: [],
      permittedTools: [],
    });

    const output = await executeDynamic(tool, { query: 'payroll' });
    assert.match(output, /No skills are approved/);
  });

  it('refuses a globally registered tool outside the request-scoped allowed set', async () => {
    let deniedExecuted = false;
    const registry = new ToolRegistry();
    registry.register(appTool('larkDoc', 'doc schema'));
    registry.register(appTool('runCommand', 'bash schema', async () => {
      deniedExecuted = true;
      return ok({ done: true });
    }));

    const tool = createCallToolTool(registry, {
      runContext: { companyId: 'company-1', userId: 'user-1', companyRole: 'MEMBER', channel: 'lark' } as any,
      perm: permission,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() } as any,
      chatId: 'chat-1',
    }, new Set(['larkDoc']));

    assert.doesNotMatch((tool as any).description, /runCommand/);
    const output = await executeDynamic(tool, { toolId: 'runCommand', args: { op: 'execute' } });
    assert.match(output, /^permission_denied:/);
    assert.equal(deniedExecuted, false);
  });

  it('routes Lark call_tool through the shared governed executor', async () => {
    let calls = 0;
    const registry = new ToolRegistry();
    registry.register(appTool('larkDoc', 'doc schema', async () => {
      calls += 1;
      return ok({ created: true });
    }));
    const runtimeExecutor = new ToolExecutor({
      toolRegistry: registry,
      permissions: {} as any,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() } as any,
    });
    const tool = createCallToolTool(registry, {
      runContext: { companyId: 'company-1', userId: 'user-1', companyRole: 'MEMBER', channel: 'lark' } as any,
      perm: permission,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() } as any,
      chatId: 'chat-1',
    }, new Set(['larkDoc']), undefined, runtimeExecutor);

    const output = await executeDynamic(tool, { toolId: 'larkDoc', args: { op: 'create' } });

    assert.equal(calls, 1);
    assert.match(output, /"created":true/);
  });

  it('exposes shared work resolution before the skill-discovery fallback', async () => {
    const tool = createResolveGovernedWorkTool({
      resolver: {
        resolve: async () => ({
          originalQuery: 'Create a launch document',
          queries: ['Create a launch document'],
          registryRevision: 4,
          persona: {
            rules: [{ scopeKey: 'launch', ruleKey: 'document', instruction: 'Use the launch template.' }],
            linkedSkills: [{ source: 'persona_link', references: [], skill: {
              id: 'launch-doc', slug: 'launch-doc', name: 'Launch document', description: 'Launch recipe',
              instructions: 'Use the approved launch structure.', toolIds: ['larkDoc'], revision: 2,
            } }],
          },
          additionalSkills: [],
          rejectedSkills: [{ id: 'seo', name: 'SEO report', bestScore: 2, matchedQueries: [], reason: 'Below relevance threshold.' }],
          resolutionOrder: [],
          note: 'advisory',
        }),
      } as any,
      companyId: 'company-1',
      userId: 'user-1',
      permission,
    });
    const output = await executeDynamic(tool, { query: 'Create a launch document' });
    const prompt = buildBrainSystemPrompt({ skillCatalog: '- Launch document', currentDateTime: 'Saturday, 19 July 2026' });

    assert.match(output, /Use the approved launch structure/);
    assert.match(output, /Rejected matches/);
    assert.match(prompt, /resolve_work\(query, variants\?\)/);
    assert.match(prompt, /discover_skill.*bounded fallback/i);
    assert.match(prompt, /scheduleTask will refuse to create anything until that recipe is loaded/i);
    assert.match(prompt, /Never cancel an existing schedule first/i);
  });
});
