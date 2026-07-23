import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { GatewayDispatcher } from '../../src/application/gateway/gateway-dispatcher.ts';
import { ToolExecutor } from '../../src/application/gateway/tool-executor.ts';
import { ToolRegistry } from '../../src/application/orchestration/tools/tool-registry.ts';
import type { CatalogSkill } from '../../src/application/skills/skill-catalog.service.ts';
import { makeAllowedPerm, noopLogger } from '../tools/tool-test.helpers.ts';
import { asToolId } from '../../src/shared/ids.ts';
import { ok } from '../../src/shared/result.ts';

const member = {
  companyId: 'company-1',
  userId: 'member-1',
  aiRole: 'MEMBER',
  email: null,
  larkOpenId: null,
  sessionId: 'session-1',
};

const dashboard: CatalogSkill = {
  id: 'dashboard-v2',
  slug: 'cursor-design-html-dashboard',
  name: 'Cursor Design HTML Dashboard',
  description: 'Create an interactive HTML dashboard using the Cursor design system.',
  instructions: 'Use tabs, state transitions, and the Cursor design tokens.',
  toolIds: [],
  aliases: [],
  tags: ['html', 'dashboard'],
  revision: 2,
};
const oldDashboard: CatalogSkill = {
  id: 'dashboard-v1',
  slug: 'cursor-design-html-prototype',
  name: 'Cursor Design System HTML Prototype',
  description: 'Create a self-contained HTML prototype using the Cursor design system.',
  instructions: 'Older generic prototype recipe.',
  toolIds: [],
  aliases: [],
  tags: ['html'],
  revision: 1,
};
const webSearch: CatalogSkill = {
  id: 'web-search',
  slug: 'web-search',
  name: 'Web Search',
  description: 'Research current public information and verify sources.',
  instructions: 'Search multiple current sources and cite the evidence.',
  toolIds: ['webSearch'],
  aliases: [],
  tags: ['research'],
  revision: 1,
};
const seo: CatalogSkill = {
  id: 'seo-report',
  slug: 'competitive-seo-analysis-report',
  name: 'Competitive SEO Analysis Report',
  description: 'Compare two websites for on-page and off-page SEO.',
  instructions: 'Produce an SEO gap analysis.',
  toolIds: ['webSearch'],
  aliases: [],
  tags: ['seo'],
  revision: 1,
};
const gmail: CatalogSkill = {
  id: 'gmail-summary',
  slug: 'gmail-summary',
  name: 'Gmail Summary',
  description: 'Read Gmail and summarize matching messages.',
  instructions: 'Use the selected Gmail account and summarize messages.',
  toolIds: ['googleGmail'],
  aliases: [],
  tags: ['gmail'],
  revision: 1,
};

function makeDispatcher() {
  const permission = makeAllowedPerm('webSearch', ['read']);
  permission.allowedToolIds.add(asToolId('googleGmail'));
  permission.allowedActionsByTool.set(asToolId('googleGmail'), new Set(['read']));
  const permissions = {
    resolve: async () => ({ ok: true as const, value: permission }),
    canInvoke: async () => ({ ok: true as const, value: true }),
    invalidateCompany: async () => {},
    invalidateDept: async () => {},
  } as any;
  const registry = new ToolRegistry();
  registry.register({
    id: 'webSearch',
    family: 'context',
    actionGroups: new Set(['read']),
    argsSchema: z.object({ query: z.string(), limit: z.number().int().optional() }),
    resultSchema: z.object({ results: z.array(z.unknown()) }),
    description: 'Search current public web sources.',
    parameterDocs: 'query: focused search text; limit?: result count',
    permissionCheck: () => ({ ok: true, value: 'read' }),
    execute: async () => ({ ok: true, value: { results: [] } }),
  } as any);
  registry.register({
    id: 'googleGmail',
    family: 'google',
    actionGroups: new Set(['read']),
    argsSchema: z.object({ connectionId: z.string().uuid(), op: z.string(), input: z.record(z.unknown()) }),
    resultSchema: z.object({ data: z.unknown() }),
    description: 'Read Gmail through an accessible Google Workspace account.',
    parameterDocs: 'connectionId: exact accessible account; op: native operation; input: native arguments',
    permissionCheck: () => ok('read'),
    execute: async () => ok({ data: [] }),
  } as any);
  const catalog = {
    searchVisible: async ({ query }: { query: string }) => {
      if (query.startsWith('Summarize Gmail')) return [{ skill: gmail, score: 14 }];
      if (query.startsWith('Research the best TTS')) {
        return [
          { skill: seo, score: 7 },
          { skill: dashboard, score: 2 },
          { skill: webSearch, score: 2 },
        ];
      }
      if (query.startsWith('Compare current TTS')) {
        return [{ skill: webSearch, score: 14 }, { skill: seo, score: 5 }];
      }
      return [{ skill: dashboard, score: 16 }, { skill: oldDashboard, score: 12 }];
    },
    getVisible: async ({ skillId }: { skillId: string }) =>
      [dashboard, oldDashboard, webSearch, seo, gmail].find(skill => skill.id === skillId) ?? null,
    registryRevision: async () => 9,
  } as any;
  return new GatewayDispatcher({
    permissions,
    toolRegistry: registry,
    skillCatalog: catalog,
    toolExecutor: new ToolExecutor({
      toolRegistry: registry,
      permissions,
      logger: noopLogger,
      clock: { now: () => new Date(), nowMs: () => Date.now() },
    }),
    managerPersonaRuntime: {
      resolveDepartmentRules: async () => [{
        nodeId: 'node-dashboard',
        scopeKey: 'project-prototyping',
        ruleKey: 'html-preview-first-cursor-design',
        kind: 'workflow',
        instruction: 'Use the linked dashboard skill for data-heavy research.',
        confidence: 0.95,
        matchScore: 8.5,
        matchedOn: ['instruction', 'skill'],
        learningSources: [{
          source: 'teach',
          sourceId: 'teach-session-1',
          rationale: 'The manager demonstrated the preferred HTML presentation.',
          evidenceRefs: ['frame-1'],
          learnedAt: '2026-07-19T00:00:00.000Z',
        }],
        linkedSkills: [{
          id: dashboard.id,
          slug: dashboard.slug,
          name: dashboard.name,
          summary: dashboard.description,
          revision: dashboard.revision,
        }],
      }],
    } as any,
    connectionRegistry: {
      listAccessibleGoogleConnections: async () => ok([{
        connectionId: '8bba6aac-79aa-4729-9dd6-806f0238359e',
        provider: 'google_workspace',
        label: 'Work Google',
        accountEmail: 'member@example.com',
        ownerType: 'user',
        ownerUserId: 'member-1',
        access: 'read_write',
        scopes: ['gmail.readonly'],
        connectedAt: new Date('2026-07-01T00:00:00.000Z'),
      }]),
      listAccessibleZohoConnections: async () => ok([]),
      listAccessibleCanvaConnections: async () => ok([]),
      listAccessibleLarkConnections: async () => ok([]),
    },
    logger: noopLogger,
  });
}

describe('gateway work.resolve', () => {
  it('merges persona-linked recipes with strong complementary burst-search results', async () => {
    const result = await makeDispatcher().dispatch({
      op: 'work.resolve',
      departmentId: 'department-1',
      payload: {
        query: 'Research the best TTS models and write an HTML document',
        variants: [
          'Compare current TTS models using public web research, benchmarks, pricing, and quality',
          'Present the TTS research as an interactive HTML dashboard using company design standards',
        ],
      },
    }, member);

    assert.equal(result.ok, true);
    const data = result.data as any;
    assert.equal(data.queries.length, 3);
    assert.equal(data.persona.rules[0].learningSources[0].sourceId, 'teach-session-1');
    assert.equal(data.persona.linkedSkills[0].skill.id, dashboard.id);
    assert.match(data.persona.linkedSkills[0].skill.instructions, /tabs, state transitions/i);
    assert.deepEqual(data.additionalSkills.map((entry: any) => entry.skill.id), [webSearch.id]);
    assert.ok(data.rejectedSkills.some((entry: any) =>
      entry.id === seo.id && /relevance threshold/i.test(entry.reason)));
    assert.ok(data.rejectedSkills.some((entry: any) =>
      entry.id === oldDashboard.id && /persona-linked/i.test(entry.reason)));
    assert.equal(data.bootstrap.version, 1);
    assert.equal(data.bootstrap.scope, 'run');
    assert.deepEqual(data.bootstrap.tools.map((tool: any) => tool.id), ['webSearch']);
    assert.equal(data.bootstrap.tools[0].argsSchema.properties.query.type, 'string');
    assert.ok(data.bootstrap.advisories.some((entry: any) => entry.code === 'contracts_loaded'));
  });

  it('preserves the exact query and allows no more than two variants', async () => {
    const result = await makeDispatcher().dispatch({
      op: 'work.resolve',
      departmentId: 'department-1',
      payload: {
        query: 'Research TTS models',
        variants: ['one', 'two', 'three'],
      },
    }, member);

    assert.equal(result.ok, false);
    assert.equal(result.status, 'bad_request');
    assert.match(result.error?.message ?? '', /variants/i);
  });

  it('preloads only the relevant accessible account for selected connection-backed tools', async () => {
    const result = await makeDispatcher().dispatch({
      op: 'work.resolve',
      departmentId: 'department-1',
      payload: { query: 'Summarize Gmail messages for this week' },
    }, member);

    assert.equal(result.ok, true);
    const data = result.data as any;
    assert.ok(data.bootstrap.tools.some((tool: any) => tool.id === 'googleGmail'));
    assert.deepEqual(data.bootstrap.connections.map((connection: any) => connection.provider), ['google_workspace']);
    assert.equal(data.bootstrap.connections[0].accountEmail, 'member@example.com');
    assert.ok(data.bootstrap.advisories.some((entry: any) => entry.code === 'connections_loaded'));
  });
});
