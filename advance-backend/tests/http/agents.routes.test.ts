/**
 * Unit tests for agents.routes.ts.
 *
 * Tests all 11 routes without spinning up a real Express server:
 *   GET    /agents                  — list agents
 *   POST   /agents                  — create agent
 *   GET    /agents/tools/registry   — list registered tools
 *   GET    /agents/models/catalog   — list model catalog
 *   GET    /agents/:id              — get single agent
 *   PUT    /agents/:id              — update agent
 *   DELETE /agents/:id              — delete agent
 *   POST   /agents/:id/toggle       — toggle active status
 *   GET    /channel-mappings        — list channel mappings
 *   POST   /channel-mappings        — set mapping
 *   DELETE /channel-mappings        — remove mapping
 *
 * Verifies per endpoint:
 *   - 200/201 happy path + response shape
 *   - Company scope enforcement (SUPER_ADMIN needs companyId, COMPANY_ADMIN is auto-scoped)
 *   - 404 / 409 / 400 / 500 from service error kinds
 *   - Zod validation rejects bad input (400)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createAgentsRoutes } from '../../src/http/agents/agents.routes.ts';
import type { AgentAdminService } from '../../src/application/agents/agent-admin.service.ts';
import type { AgentAdminView } from '../../src/infrastructure/persistence/agent-definition.repository.ts';
import type { ChannelMappingView } from '../../src/infrastructure/persistence/channel-mapping.repository.ts';
import { AI_MODEL_CATALOG } from '../../src/shared/ai-model-catalog.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noopLogger = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
  child: function() { return this as typeof noopLogger; },
} as any;

const DEFAULT_LOCALS = { companyId: 'co-1', isSuperAdmin: false, userId: 'u-1' };
const SUPER_ADMIN_LOCALS = { companyId: '', isSuperAdmin: true, userId: 'u-sa' };

async function callRoute(
  router: ReturnType<typeof createAgentsRoutes>,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: {
    query?:  Record<string, string>;
    body?:   Record<string, unknown>;
    locals?: Record<string, unknown>;
  } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    let status = 200;
    let responseBody: unknown = {};

    const locals: Record<string, unknown> = opts.locals ?? { ...DEFAULT_LOCALS };

    const req = {
      method,
      path,
      params:  {},
      query:   opts.query ?? {},
      body:    opts.body  ?? {},
      headers: {},
    } as unknown as Request;

    const res = {
      locals,
      status: (s: number) => { status = s; return res; },
      json: (b: unknown) => {
        responseBody = b;
        resolve({ status, body: responseBody });
        return res;
      },
    } as unknown as Response;

    const next = (err?: unknown) => {
      if (err) {
        // Simulates error boundary: unwrap status from RouteError
        const e = err as Error & { status?: number };
        status = e.status ?? 500;
        responseBody = { success: false, message: e.message };
      }
      resolve({ status, body: responseBody });
    };

    const routerAny = router as any;
    const stack: any[] = routerAny.stack ?? [];

    function matchLayer(layer: any, url: string): Record<string, string> | null {
      if (!layer.route) return null;
      const routePath: string = layer.route.path;
      const routeMethod: string = Object.keys(layer.route.methods)[0]!.toUpperCase();
      if (routeMethod !== method) return null;

      const paramNames: string[] = [];
      const pattern = routePath.replace(/:([^/]+)/g, (_: string, name: string) => {
        paramNames.push(name);
        return '([^/]+)';
      });
      const re = new RegExp(`^${pattern}$`);
      const m = url.match(re);
      if (!m) return null;
      const params: Record<string, string> = {};
      paramNames.forEach((name, i) => { params[name] = m[i + 1]!; });
      return params;
    }

    let matched = false;
    for (const layer of stack) {
      const params = matchLayer(layer, path);
      if (params !== null) {
        req.params = params as any;
        matched = true;
        const handler = layer.route.stack[0]?.handle;
        if (handler) {
          Promise.resolve(handler(req, res, next)).catch(next);
        } else {
          next();
        }
        break;
      }
    }
    if (!matched) next();
  });
}

// ─── Fake data ────────────────────────────────────────────────────────────────

const fakeAgent: AgentAdminView = {
  id:           'ag-1',
  companyId:    'co-1',
  name:         'Sales Agent',
  slug:         'sales-agent',
  systemPrompt: 'You are a sales agent.',
  maxSteps:     8,
  temperature:  0,
  isRootAgent:  true,
  isActive:     true,
  toolIds:      ['zoho-crm'],
  children:     [],
  createdAt:    new Date('2025-01-01'),
  updatedAt:    new Date('2025-01-02'),
};

const fakeMapping: ChannelMappingView = {
  id:                'map-1',
  companyId:         'co-1',
  channelType:       'lark',
  channelIdentifier: 'chat-123',
  agentDefinitionId: 'ag-1',
  isActive:          true,
  createdAt:         new Date('2025-01-01'),
  updatedAt:         new Date('2025-01-01'),
  agentDefinition:   { id: 'ag-1', name: 'Sales Agent' },
};

function makeService(overrides: Partial<AgentAdminService> = {}): AgentAdminService {
  return {
    listAgents:          async () => ({ ok: true, value: [fakeAgent] }),
    getAgent:            async () => ({ ok: true, value: fakeAgent }),
    createAgent:         async () => ({ ok: true, value: fakeAgent }),
    updateAgent:         async () => ({ ok: true, value: fakeAgent }),
    deleteAgent:         async () => ({ ok: true, value: undefined }),
    toggleActive:        async () => ({ ok: true, value: { ...fakeAgent, isActive: false } }),
    listRegisteredTools: async () => [],
    listMappings:        async () => ({ ok: true, value: [fakeMapping] }),
    setMapping:          async () => ({ ok: true, value: fakeMapping }),
    removeMapping:       async () => ({ ok: true, value: undefined }),
    ...overrides,
  } as unknown as AgentAdminService;
}

function makeRouter(overrides: Partial<AgentAdminService> = {}) {
  return createAgentsRoutes({ agentAdminService: makeService(overrides), logger: noopLogger });
}

// ─── GET /agents ──────────────────────────────────────────────────────────────

describe('GET /agents', () => {
  it('returns 200 with agent list', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/agents');
    assert.equal(status, 200);
    const b = body as any;
    assert.equal(b.success, true);
    assert.equal(b.data.length, 1);
    assert.equal(b.data[0].id, 'ag-1');
  });

  it('returns 400 when SUPER_ADMIN omits companyId', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/agents', {
      locals: SUPER_ADMIN_LOCALS,
    });
    assert.equal(status, 400);
  });

  it('returns 200 when SUPER_ADMIN provides companyId via query', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/agents', {
      locals: SUPER_ADMIN_LOCALS,
      query:  { companyId: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000099' },
    });
    assert.equal(status, 200);
  });

  it('returns 403 when COMPANY_ADMIN passes a different companyId', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/agents', {
      query: { companyId: 'bbbbbbbb-bbbb-bbbb-bbbb-000000000002' },
    });
    assert.equal(status, 403);
  });

  it('returns 500 when service fails', async () => {
    const { status } = await callRoute(
      makeRouter({ listAgents: async () => ({ ok: false, error: { kind: 'internal', message: 'db down' } }) }),
      'GET', '/agents',
    );
    assert.equal(status, 500);
  });
});

// ─── GET /agents/tools/registry ───────────────────────────────────────────────

describe('GET /agents/tools/registry', () => {
  it('returns 200 with tool list', async () => {
    const svc = makeService({
      listRegisteredTools: async () => [{ id: 'rt-1', toolId: 'zoho-crm', name: 'Zoho CRM' } as any],
    });
    const router = createAgentsRoutes({ agentAdminService: svc, logger: noopLogger });
    const { status, body } = await callRoute(router, 'GET', '/agents/tools/registry');
    assert.equal(status, 200);
    assert.equal((body as any).data.length, 1);
  });

  it('returns 400 when SUPER_ADMIN omits companyId', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/agents/tools/registry', {
      locals: SUPER_ADMIN_LOCALS,
    });
    assert.equal(status, 400);
  });
});

// ─── GET /agents/models/catalog ───────────────────────────────────────────────

describe('GET /agents/models/catalog', () => {
  it('returns 200 with catalog entries', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/agents/models/catalog');
    assert.equal(status, 200);
    const b = body as any;
    assert.ok(Array.isArray(b.data));
    assert.equal(b.data.length, AI_MODEL_CATALOG.length);
    assert.ok(b.data.every((e: any) => ['google', 'openai'].includes(e.provider)));
  });
});

// ─── POST /agents ─────────────────────────────────────────────────────────────

describe('POST /agents', () => {
  const validBody = {
    name:         'New Agent',
    systemPrompt: 'You are helpful.',
  };

  it('returns 201 on success', async () => {
    const { status, body } = await callRoute(makeRouter(), 'POST', '/agents', { body: validBody });
    assert.equal(status, 201);
    assert.equal((body as any).success, true);
    assert.equal((body as any).data.id, 'ag-1');
  });

  it('returns 400 when name is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/agents', {
      body: { systemPrompt: 'hello' },
    });
    assert.equal(status, 400);
  });

  it('returns 400 when systemPrompt is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/agents', {
      body: { name: 'Agent X' },
    });
    assert.equal(status, 400);
  });

  it('returns 409 on name conflict', async () => {
    const { status } = await callRoute(
      makeRouter({ createAgent: async () => ({ ok: false, error: { kind: 'conflict', message: 'name taken' } }) }),
      'POST', '/agents',
      { body: validBody },
    );
    assert.equal(status, 409);
  });

  it('returns 400 on validation error from service', async () => {
    const { status } = await callRoute(
      makeRouter({ createAgent: async () => ({ ok: false, error: { kind: 'validation', message: 'bad tool' } }) }),
      'POST', '/agents',
      { body: validBody },
    );
    assert.equal(status, 400);
  });

  it('returns 400 when SUPER_ADMIN omits companyId', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/agents', {
      locals: SUPER_ADMIN_LOCALS,
      body:   validBody,
    });
    assert.equal(status, 400);
  });

  it('passes companyId from body for SUPER_ADMIN', async () => {
    let capturedCompanyId: string | undefined;
    const router = createAgentsRoutes({
      agentAdminService: makeService({
        createAgent: async (cid) => { capturedCompanyId = cid; return { ok: true, value: fakeAgent }; },
      }),
      logger: noopLogger,
    });
    await callRoute(router, 'POST', '/agents', {
      locals: SUPER_ADMIN_LOCALS,
      body:   { ...validBody, companyId: 'cccccccc-cccc-cccc-cccc-000000000099' },
    });
    assert.equal(capturedCompanyId, 'cccccccc-cccc-cccc-cccc-000000000099');
  });

  it('passes dynamic runtime fields to service', async () => {
    let capturedInput: any;
    const router = createAgentsRoutes({
      agentAdminService: makeService({
        createAgent: async (_cid, input) => { capturedInput = input; return { ok: true, value: fakeAgent }; },
      }),
      logger: noopLogger,
    });

    await callRoute(router, 'POST', '/agents', {
      body: {
        ...validBody,
        slug:                  'sales-research',
        capabilityDescription: 'Handles sales research.',
        hookId:                'zoho-read',
        maxSteps:              12,
        temperature:           0.2,
      },
    });

    assert.equal(capturedInput.slug, 'sales-research');
    assert.equal(capturedInput.capabilityDescription, 'Handles sales research.');
    assert.equal(capturedInput.hookId, 'zoho-read');
    assert.equal(capturedInput.maxSteps, 12);
    assert.equal(capturedInput.temperature, 0.2);
  });
});

// ─── GET /agents/:id ──────────────────────────────────────────────────────────

describe('GET /agents/:id', () => {
  it('returns 200 with agent detail', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/agents/ag-1');
    assert.equal(status, 200);
    assert.equal((body as any).data.id, 'ag-1');
  });

  it('returns 404 when not found', async () => {
    const { status } = await callRoute(
      makeRouter({ getAgent: async () => ({ ok: false, error: { kind: 'not_found', message: 'not found' } }) }),
      'GET', '/agents/missing',
    );
    assert.equal(status, 404);
  });

  it('passes correct id to service', async () => {
    let capturedId: string | undefined;
    const router = createAgentsRoutes({
      agentAdminService: makeService({
        getAgent: async (id) => { capturedId = id; return { ok: true, value: fakeAgent }; },
      }),
      logger: noopLogger,
    });
    await callRoute(router, 'GET', '/agents/ag-xyz');
    assert.equal(capturedId, 'ag-xyz');
  });
});

// ─── PUT /agents/:id ──────────────────────────────────────────────────────────

describe('PUT /agents/:id', () => {
  it('returns 200 on successful update', async () => {
    const { status, body } = await callRoute(makeRouter(), 'PUT', '/agents/ag-1', {
      body: { name: 'Updated Agent' },
    });
    assert.equal(status, 200);
    assert.equal((body as any).success, true);
  });

  it('returns 404 when agent not found', async () => {
    const { status } = await callRoute(
      makeRouter({ updateAgent: async () => ({ ok: false, error: { kind: 'not_found', message: 'missing' } }) }),
      'PUT', '/agents/missing',
      { body: { name: 'X' } },
    );
    assert.equal(status, 404);
  });

  it('returns 409 on name conflict', async () => {
    const { status } = await callRoute(
      makeRouter({ updateAgent: async () => ({ ok: false, error: { kind: 'conflict', message: 'conflict' } }) }),
      'PUT', '/agents/ag-1',
      { body: { name: 'Taken' } },
    );
    assert.equal(status, 409);
  });

  it('returns 400 on validation error', async () => {
    const { status } = await callRoute(
      makeRouter({ updateAgent: async () => ({ ok: false, error: { kind: 'validation', message: 'cycle' } }) }),
      'PUT', '/agents/ag-1',
      { body: { parentId: 'ag-1' } },
    );
    assert.equal(status, 400);
  });

  it('passes id and update fields to service', async () => {
    let capturedId: string | undefined;
    let capturedInput: any;
    const router = createAgentsRoutes({
      agentAdminService: makeService({
        updateAgent: async (id, _cid, input) => {
          capturedId    = id;
          capturedInput = input;
          return { ok: true, value: fakeAgent };
        },
      }),
      logger: noopLogger,
    });
    await callRoute(router, 'PUT', '/agents/ag-99', { body: { name: 'Renamed', isActive: false } });
    assert.equal(capturedId, 'ag-99');
    assert.equal(capturedInput.name, 'Renamed');
    assert.equal(capturedInput.isActive, false);
  });

  it('passes dynamic runtime fields on update', async () => {
    let capturedInput: any;
    const router = createAgentsRoutes({
      agentAdminService: makeService({
        updateAgent: async (_id, _cid, input) => {
          capturedInput = input;
          return { ok: true, value: fakeAgent };
        },
      }),
      logger: noopLogger,
    });

    await callRoute(router, 'PUT', '/agents/ag-99', {
      body: {
        slug:                  'sales-ops',
        capabilityDescription: 'Routes sales operations tasks.',
        hookId:                null,
        maxSteps:              10,
        temperature:           0.1,
      },
    });

    assert.equal(capturedInput.slug, 'sales-ops');
    assert.equal(capturedInput.capabilityDescription, 'Routes sales operations tasks.');
    assert.equal(capturedInput.hookId, null);
    assert.equal(capturedInput.maxSteps, 10);
    assert.equal(capturedInput.temperature, 0.1);
  });
});

// ─── DELETE /agents/:id ───────────────────────────────────────────────────────

describe('DELETE /agents/:id', () => {
  it('returns 200 with deleted:true', async () => {
    const { status, body } = await callRoute(makeRouter(), 'DELETE', '/agents/ag-1');
    assert.equal(status, 200);
    assert.equal((body as any).data.deleted, true);
  });

  it('returns 404 when not found', async () => {
    const { status } = await callRoute(
      makeRouter({ deleteAgent: async () => ({ ok: false, error: { kind: 'not_found', message: 'gone' } }) }),
      'DELETE', '/agents/gone',
    );
    assert.equal(status, 404);
  });

  it('returns 400 when agent has children', async () => {
    const { status } = await callRoute(
      makeRouter({ deleteAgent: async () => ({ ok: false, error: { kind: 'validation', message: 'has children' } }) }),
      'DELETE', '/agents/ag-parent',
    );
    assert.equal(status, 400);
  });
});

// ─── POST /agents/:id/toggle ──────────────────────────────────────────────────

describe('POST /agents/:id/toggle', () => {
  it('returns 200 with toggled agent', async () => {
    const { status, body } = await callRoute(makeRouter(), 'POST', '/agents/ag-1/toggle');
    assert.equal(status, 200);
    assert.equal((body as any).data.isActive, false);
  });

  it('returns 404 when not found', async () => {
    const { status } = await callRoute(
      makeRouter({ toggleActive: async () => ({ ok: false, error: { kind: 'not_found', message: 'missing' } }) }),
      'POST', '/agents/missing/toggle',
    );
    assert.equal(status, 404);
  });

  it('passes correct id to service', async () => {
    let capturedId: string | undefined;
    const router = createAgentsRoutes({
      agentAdminService: makeService({
        toggleActive: async (id) => { capturedId = id; return { ok: true, value: fakeAgent }; },
      }),
      logger: noopLogger,
    });
    await callRoute(router, 'POST', '/agents/ag-toggle-me/toggle');
    assert.equal(capturedId, 'ag-toggle-me');
  });
});

// ─── GET /channel-mappings ────────────────────────────────────────────────────

describe('GET /channel-mappings', () => {
  it('returns 200 with mapping list', async () => {
    const { status, body } = await callRoute(makeRouter(), 'GET', '/channel-mappings');
    assert.equal(status, 200);
    const b = body as any;
    assert.equal(b.data.length, 1);
    assert.equal(b.data[0].id, 'map-1');
  });

  it('returns 400 when SUPER_ADMIN omits companyId', async () => {
    const { status } = await callRoute(makeRouter(), 'GET', '/channel-mappings', {
      locals: SUPER_ADMIN_LOCALS,
    });
    assert.equal(status, 400);
  });

  it('returns 500 when service fails', async () => {
    const { status } = await callRoute(
      makeRouter({ listMappings: async () => ({ ok: false, error: { kind: 'internal', message: 'db' } }) }),
      'GET', '/channel-mappings',
    );
    assert.equal(status, 500);
  });
});

// ─── POST /channel-mappings ───────────────────────────────────────────────────

describe('POST /channel-mappings', () => {
  const validMapping = {
    channelType:       'lark',
    channelIdentifier: 'chat-abc',
    agentDefinitionId: 'clxxxxxxxxxxxxxxxxxxxxxx',
  };

  it('returns 201 on success', async () => {
    const { status, body } = await callRoute(makeRouter(), 'POST', '/channel-mappings', {
      body: validMapping,
    });
    assert.equal(status, 201);
    assert.equal((body as any).data.id, 'map-1');
  });

  it('returns 400 when channelType is invalid', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/channel-mappings', {
      body: { ...validMapping, channelType: 'slack' },
    });
    assert.equal(status, 400);
  });

  it('returns 400 when agentDefinitionId is not a CUID', async () => {
    const { status } = await callRoute(makeRouter(), 'POST', '/channel-mappings', {
      body: { ...validMapping, agentDefinitionId: 'not-a-cuid' },
    });
    assert.equal(status, 400);
  });

  it('returns 404 when agent not found', async () => {
    const { status } = await callRoute(
      makeRouter({ setMapping: async () => ({ ok: false, error: { kind: 'not_found', message: 'agent gone' } }) }),
      'POST', '/channel-mappings',
      { body: validMapping },
    );
    assert.equal(status, 404);
  });

  it('passes companyId from locals to service', async () => {
    let capturedInput: any;
    const router = createAgentsRoutes({
      agentAdminService: makeService({
        setMapping: async (input) => { capturedInput = input; return { ok: true, value: fakeMapping }; },
      }),
      logger: noopLogger,
    });
    await callRoute(router, 'POST', '/channel-mappings', { body: validMapping });
    assert.equal(capturedInput.companyId, 'co-1');
    assert.equal(capturedInput.channelType, 'lark');
    assert.equal(capturedInput.channelIdentifier, 'chat-abc');
  });
});

// ─── DELETE /channel-mappings ─────────────────────────────────────────────────

describe('DELETE /channel-mappings', () => {
  const validBody = {
    channelType:       'lark',
    channelIdentifier: 'chat-abc',
  };

  it('returns 200 with deleted:true', async () => {
    const { status, body } = await callRoute(makeRouter(), 'DELETE', '/channel-mappings', {
      body: validBody,
    });
    assert.equal(status, 200);
    assert.equal((body as any).data.deleted, true);
  });

  it('returns 400 when channelType is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'DELETE', '/channel-mappings', {
      body: { channelIdentifier: 'chat-abc' },
    });
    assert.equal(status, 400);
  });

  it('returns 400 when channelIdentifier is missing', async () => {
    const { status } = await callRoute(makeRouter(), 'DELETE', '/channel-mappings', {
      body: { channelType: 'lark' },
    });
    assert.equal(status, 400);
  });

  it('passes companyId from locals to service', async () => {
    let capturedCompanyId: string | undefined;
    const router = createAgentsRoutes({
      agentAdminService: makeService({
        removeMapping: async (cid) => { capturedCompanyId = cid; return { ok: true, value: undefined }; },
      }),
      logger: noopLogger,
    });
    await callRoute(router, 'DELETE', '/channel-mappings', { body: validBody });
    assert.equal(capturedCompanyId, 'co-1');
  });
});
