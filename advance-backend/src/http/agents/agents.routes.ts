/**
 * Agent definition + channel mapping routes.
 *
 * All routes require admin auth (COMPANY_ADMIN or SUPER_ADMIN).
 * SUPER_ADMIN must supply companyId via query param or request body.
 * COMPANY_ADMIN is scoped to their own company automatically.
 *
 * Routes:
 *   GET    /agents                     — list all agents for company
 *   POST   /agents                     — create agent
 *   GET    /agents/tools/registry      — list registered (non-deprecated) tools
 *   GET    /agents/models/catalog      — list available AI models
 *   GET    /agents/:id                 — get single agent
 *   PUT    /agents/:id                 — update agent
 *   DELETE /agents/:id                 — delete agent
 *   POST   /agents/:id/toggle          — toggle active status
 *   GET    /channel-mappings           — list channel→agent mappings
 *   POST   /channel-mappings           — create or update mapping
 *   DELETE /channel-mappings           — remove mapping
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AgentAdminService } from '../../application/agents/agent-admin.service';
import type { Logger } from '../../shared/logger';
import { AI_MODEL_CATALOG } from '../../shared/ai-model-catalog';

export interface AgentsRoutesDeps {
  agentAdminService: AgentAdminService;
  logger:            Logger;
}

// ── Helpers shared with admin-auth style ─────────────────────────────────────

type RouteError = Error & { status: number };

const routeError = (status: number, message: string): RouteError => {
  const e = new Error(message) as RouteError;
  e.status = status;
  return e;
};

const success = <T>(res: Response, data: T, message?: string, status = 200) =>
  res.status(status).json({ success: true, data, ...(message ? { message } : {}) });

const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ success: false, message });

const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof z.ZodError) {
        fail(res, 400, error.issues[0]?.message ?? 'Invalid request');
        return;
      }
      if (error instanceof Error && 'status' in error && typeof (error as RouteError).status === 'number') {
        fail(res, (error as RouteError).status, error.message);
        return;
      }
      throw error;
    }
  };

// ── Company scope resolution ──────────────────────────────────────────────────

function resolveCompanyId(res: Response, providedId?: string): string {
  const isSuperAdmin = Boolean(res.locals['isSuperAdmin']);
  const localId      = res.locals['companyId'] as string | undefined ?? '';

  if (isSuperAdmin) {
    const cid = providedId ?? '';
    if (!cid) throw routeError(400, 'companyId is required for super-admin requests');
    return cid;
  }

  if (providedId && providedId !== localId) {
    throw routeError(403, 'Access denied: company mismatch');
  }
  return localId;
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const companyQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
});

const createAgentSchema = z.object({
  companyId:    z.string().uuid().optional(),
  name:         z.string().trim().min(1).max(120),
  description:  z.string().trim().max(1000).optional(),
  systemPrompt: z.string().trim().min(1).max(50_000),
  isRootAgent:  z.boolean().optional(),
  toolIds:      z.array(z.string().trim().min(1)).max(500).optional(),
  modelId:      z.string().trim().min(1).max(255).nullable().optional(),
  provider:     z.string().trim().min(1).max(64).nullable().optional(),
  parentId:     z.string().cuid().nullable().optional(),
});

const updateAgentSchema = z.object({
  companyId:    z.string().uuid().optional(),
  name:         z.string().trim().min(1).max(120).optional(),
  description:  z.string().trim().max(1000).optional(),
  systemPrompt: z.string().trim().min(1).max(50_000).optional(),
  isRootAgent:  z.boolean().optional(),
  isActive:     z.boolean().optional(),
  toolIds:      z.array(z.string().trim().min(1)).max(500).optional(),
  modelId:      z.string().trim().min(1).max(255).nullable().optional(),
  provider:     z.string().trim().min(1).max(64).nullable().optional(),
  parentId:     z.string().cuid().nullable().optional(),
});

const setMappingSchema = z.object({
  companyId:         z.string().uuid().optional(),
  channelType:       z.enum(['lark', 'desktop']),
  channelIdentifier: z.string().trim().min(1).max(255),
  agentDefinitionId: z.string().cuid(),
});

const removeMappingSchema = z.object({
  companyId:         z.string().uuid().optional(),
  channelType:       z.string().trim().min(1).max(64),
  channelIdentifier: z.string().trim().min(1).max(255),
});

// ── Service result → HTTP response ────────────────────────────────────────────

function handleServiceError(res: Response, error: { kind: string; message: string }): void {
  switch (error.kind) {
    case 'not_found':  fail(res, 404, error.message); break;
    case 'conflict':   fail(res, 409, error.message); break;
    case 'validation': fail(res, 400, error.message); break;
    default:           fail(res, 500, error.message);
  }
}

// ── Router factory ────────────────────────────────────────────────────────────

export function createAgentsRoutes(deps: AgentsRoutesDeps): Router {
  const router = Router();

  // GET /agents/tools/registry  — must come before /agents/:id
  router.get('/agents/tools/registry', asyncRoute(async (req, res) => {
    const { companyId: qCompanyId } = companyQuerySchema.parse(req.query);
    resolveCompanyId(res, qCompanyId); // enforce scope even though result isn't needed
    const tools = await deps.agentAdminService.listRegisteredTools();
    success(res, tools, 'Registered tools loaded');
  }));

  // GET /agents/models/catalog  — must come before /agents/:id
  router.get('/agents/models/catalog', asyncRoute(async (_req, res) => {
    success(res, AI_MODEL_CATALOG, 'Model catalog loaded');
  }));

  // GET /agents
  router.get('/agents', asyncRoute(async (req, res) => {
    const { companyId: qCompanyId } = companyQuerySchema.parse(req.query);
    const companyId = resolveCompanyId(res, qCompanyId);
    const result = await deps.agentAdminService.listAgents(companyId);
    if (!result.ok) { handleServiceError(res, result.error); return; }
    success(res, result.value, 'Agents loaded');
  }));

  // POST /agents
  router.post('/agents', asyncRoute(async (req, res) => {
    const payload = createAgentSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);
    const result = await deps.agentAdminService.createAgent(companyId, {
      name:         payload.name,
      description:  payload.description,
      systemPrompt: payload.systemPrompt,
      isRootAgent:  payload.isRootAgent,
      toolIds:      payload.toolIds,
      modelId:      payload.modelId,
      provider:     payload.provider,
      parentId:     payload.parentId,
    });
    if (!result.ok) { handleServiceError(res, result.error); return; }
    success(res, result.value, 'Agent created', 201);
  }));

  // GET /agents/:id
  router.get('/agents/:id', asyncRoute(async (req, res) => {
    const { id } = req.params as { id: string };
    const { companyId: qCompanyId } = companyQuerySchema.parse(req.query);
    const companyId = resolveCompanyId(res, qCompanyId);
    const result = await deps.agentAdminService.getAgent(id, companyId);
    if (!result.ok) { handleServiceError(res, result.error); return; }
    success(res, result.value, 'Agent loaded');
  }));

  // PUT /agents/:id
  router.put('/agents/:id', asyncRoute(async (req, res) => {
    const { id } = req.params as { id: string };
    const payload = updateAgentSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);
    const result = await deps.agentAdminService.updateAgent(id, companyId, {
      name:         payload.name,
      description:  payload.description,
      systemPrompt: payload.systemPrompt,
      isRootAgent:  payload.isRootAgent,
      isActive:     payload.isActive,
      toolIds:      payload.toolIds,
      modelId:      payload.modelId,
      provider:     payload.provider,
      parentId:     payload.parentId,
    });
    if (!result.ok) { handleServiceError(res, result.error); return; }
    success(res, result.value, 'Agent updated');
  }));

  // DELETE /agents/:id
  router.delete('/agents/:id', asyncRoute(async (req, res) => {
    const { id } = req.params as { id: string };
    const { companyId: qCompanyId } = companyQuerySchema.parse(req.query);
    const companyId = resolveCompanyId(res, qCompanyId);
    const result = await deps.agentAdminService.deleteAgent(id, companyId);
    if (!result.ok) { handleServiceError(res, result.error); return; }
    success(res, { deleted: true }, 'Agent deleted');
  }));

  // POST /agents/:id/toggle
  router.post('/agents/:id/toggle', asyncRoute(async (req, res) => {
    const { id } = req.params as { id: string };
    const { companyId: qCompanyId } = companyQuerySchema.parse(req.query);
    const companyId = resolveCompanyId(res, qCompanyId);
    const result = await deps.agentAdminService.toggleActive(id, companyId);
    if (!result.ok) { handleServiceError(res, result.error); return; }
    success(res, result.value, 'Agent active status updated');
  }));

  // GET /channel-mappings
  router.get('/channel-mappings', asyncRoute(async (req, res) => {
    const { companyId: qCompanyId } = companyQuerySchema.parse(req.query);
    const companyId = resolveCompanyId(res, qCompanyId);
    const result = await deps.agentAdminService.listMappings(companyId);
    if (!result.ok) { handleServiceError(res, result.error); return; }
    success(res, result.value, 'Channel mappings loaded');
  }));

  // POST /channel-mappings
  router.post('/channel-mappings', asyncRoute(async (req, res) => {
    const payload = setMappingSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);
    const result = await deps.agentAdminService.setMapping({
      companyId,
      channelType:       payload.channelType,
      channelIdentifier: payload.channelIdentifier,
      agentDefinitionId: payload.agentDefinitionId,
    });
    if (!result.ok) { handleServiceError(res, result.error); return; }
    success(res, result.value, 'Channel mapping saved', 201);
  }));

  // DELETE /channel-mappings
  router.delete('/channel-mappings', asyncRoute(async (req, res) => {
    const payload = removeMappingSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);
    const result = await deps.agentAdminService.removeMapping(
      companyId,
      payload.channelType,
      payload.channelIdentifier,
    );
    if (!result.ok) { handleServiceError(res, result.error); return; }
    success(res, { deleted: true }, 'Channel mapping removed');
  }));

  return router;
}
