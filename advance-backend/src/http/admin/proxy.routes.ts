/**
 * Admin proxy routes — the model proxy control plane (Guardrails).
 *
 * Mounted at /api/admin/proxy.
 *
 *   GET    /status   — proxy enabled? key configured? masked key + scope + last-used
 *   PUT    /key      — save / rotate a provider key (encrypted server-side)
 *   DELETE /key      — remove a stored key for a scope
 *   GET    /models   — the catalogue an admin grants from, with who serves each
 *
 * Every key path is scoped by `provider` (defaulting to deepseek, which is what
 * the single-provider clients sent before OpenAI existed here), so one company
 * can hold a DeepSeek key and an OpenAI key side by side.
 *
 * The plaintext key is accepted once on PUT, encrypted immediately, and never
 * returned again — reads expose only keyLast4 / a mask. Platform-scoped keys are
 * SUPER_ADMIN-only; company-scoped keys resolve from the caller's company.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { ProxyKeyStore, KEY_PROVIDERS } from '../../application/proxy/proxy-key.store';
import { TokenCryptoError } from '../../infrastructure/shared/token.crypto';
import {
  costUsd,
  PROXY_MODEL_SPECS,
  RUNTIME_MODEL_PREFERENCE,
  type ModelProvider,
} from '../../application/observability/pricing';

export interface ProxyRoutesDeps {
  prisma: PrismaClient;
  store: ProxyKeyStore;
  logger: Logger;
  enabled: boolean;   // LLM_PROXY_ENABLED
  /** Upstream host per provider, for display. */
  upstreams: Record<ModelProvider, string>;
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

type RouteError = Error & { status: number };
const routeError = (status: number, message: string): RouteError => {
  const e = new Error(message) as RouteError;
  e.status = status;
  return e;
};
const success = <T>(res: Response, data: T) => res.status(200).json({ success: true, data });
const fail = (res: Response, status: number, message: string) => res.status(status).json({ success: false, message });

const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response): Promise<void> => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof z.ZodError) { fail(res, 400, error.issues[0]?.message ?? 'Invalid request'); return; }
      if (error instanceof TokenCryptoError) { fail(res, 400, error.message); return; }
      if (error instanceof Error && 'status' in error && typeof (error as RouteError).status === 'number') {
        fail(res, (error as RouteError).status, error.message); return;
      }
      throw error;
    }
  };

function resolveCompanyId(res: Response, providedId?: string): string {
  const isSuperAdmin = Boolean(res.locals['isSuperAdmin']);
  const localId = (res.locals['companyId'] as string | undefined) ?? '';
  if (isSuperAdmin) {
    if (!providedId) throw routeError(400, 'companyId is required for super-admin requests');
    return providedId;
  }
  if (providedId && providedId !== localId) throw routeError(403, 'Access denied: company mismatch');
  return localId;
}
const qCompany = (req: Request, res: Response) =>
  resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
const qChannel = (req: Request): string | undefined => {
  const value = typeof req.query.channel === 'string' ? req.query.channel : undefined;
  return value && ['desktop', 'lark', 'web'].includes(value) ? value : undefined;
};

const bodyCompany = (req: Request, res: Response) => {
  const provided = typeof (req.body as { companyId?: unknown })?.companyId === 'string' ? (req.body as { companyId: string }).companyId : undefined;
  return resolveCompanyId(res, provided ?? (typeof req.query.companyId === 'string' ? req.query.companyId : undefined));
};

const providerSchema = z.enum(KEY_PROVIDERS).default('deepseek');

const keySchema = z.object({
  key: z.string().trim().min(20, 'That does not look like a valid API key').max(400),
  provider: providerSchema,
  scope: z.enum(['platform', 'company']),
  companyId: z.string().optional(),
});
const removeSchema = z.object({
  provider: providerSchema,
  scope: z.enum(['platform', 'company']),
  companyId: z.string().optional(),
});

/** Which provider this request is about. Absent means deepseek, as it always did. */
const qProvider = (req: Request): ModelProvider =>
  providerSchema.parse(typeof req.query.provider === 'string' ? req.query.provider : undefined);

export function createProxyRoutes(deps: ProxyRoutesDeps): Router {
  const router = Router();
  const { store, prisma } = deps;
  const hostOf = (value: string): string => { try { return new URL(value).host; } catch { return value; } };
  const upstreamHosts = Object.fromEntries(
    Object.entries(deps.upstreams).map(([provider, url]) => [provider, hostOf(url)]),
  ) as Record<ModelProvider, string>;

  const requireSuperAdminForPlatform = (res: Response, scope: 'platform' | 'company') => {
    if (scope === 'platform' && !res.locals['isSuperAdmin']) {
      throw routeError(403, 'Only a super-admin can set a platform-wide key');
    }
  };

  const envelope = (provider: ModelProvider, status: Awaited<ReturnType<ProxyKeyStore['status']>>) => ({
    ...status,
    provider,
    enabled: true,
    desktopProxyEnabled: deps.enabled,
    larkEnabled: true,
    upstream: upstreamHosts[provider],
    canEncrypt: store.canEncrypt(),
  });

  // ─── GET /status ────────────────────────────────────────────────────
  router.get('/status', asyncRoute(async (req, res) => {
    const companyId = qCompany(req, res);
    const provider = qProvider(req);
    success(res, envelope(provider, await store.status(provider, companyId)));
  }));

  // ─── GET /models — the catalogue the grant is drawn from ────────────
  // Served rather than mirrored in the UI so a model added to pricing.ts shows
  // up in the admin panel without a second edit that can drift out of step.
  //
  // Returned in runtime preference order, best first, because that ordering is
  // what decides which of a member's granted models actually answers. An admin
  // panel that showed a different order would be describing a choice the
  // backend does not make.
  router.get('/models', asyncRoute(async (_req, res) => {
    const ordered = RUNTIME_MODEL_PREFERENCE
      .map((id) => PROXY_MODEL_SPECS.find((spec) => spec.id === id))
      .filter((spec): spec is (typeof PROXY_MODEL_SPECS)[number] => Boolean(spec));
    success(res, ordered.map((spec) => ({
      id: spec.id,
      label: spec.label,
      provider: spec.provider,
      vision: spec.vision,
      inputPerMillionUsd: spec.rate.cacheMissIn,
      outputPerMillionUsd: spec.rate.output,
    })));
  }));

  // ─── PUT /key — save / rotate ───────────────────────────────────────
  router.put('/key', asyncRoute(async (req, res) => {
    const body = keySchema.parse(req.body ?? {});
    requireSuperAdminForPlatform(res, body.scope);
    const companyId = bodyCompany(req, res);
    const createdBy = res.locals['userId'] as string | undefined;
    const status = await store.save({ provider: body.provider, scope: body.scope, companyId, plaintextKey: body.key, createdBy });
    deps.logger.info('proxy.key.saved', { companyId, provider: body.provider, scope: body.scope, by: createdBy });
    success(res, envelope(body.provider, status));
  }));

  // ─── DELETE /key — remove ───────────────────────────────────────────
  router.delete('/key', asyncRoute(async (req, res) => {
    const body = removeSchema.parse(req.body ?? {});
    requireSuperAdminForPlatform(res, body.scope);
    const companyId = bodyCompany(req, res);
    const status = await store.remove({ provider: body.provider, scope: body.scope, companyId });
    deps.logger.info('proxy.key.removed', { companyId, provider: body.provider, scope: body.scope });
    success(res, envelope(body.provider, status));
  }));

  // ─── GET /metrics — proxy health over the last 24h ──────────────────
  router.get('/metrics', asyncRoute(async (req, res) => {
    const companyId = qCompany(req, res);
    const channel = qChannel(req);
    const requestWhere = { companyId, ...(channel ? { channel } : {}) };
    const since24h = new Date(Date.now() - 24 * 3_600_000);
    const [agg, todayCount, denied, last] = await Promise.all([
      prisma.proxyRequestLog.aggregate({
        where:  { ...requestWhere, createdAt: { gte: since24h } },
        _count: { id: true },
        _avg:   { latencyMs: true },
        _sum:   { cacheHitTokens: true, cacheMissTokens: true, outputTokens: true },
      }),
      prisma.proxyRequestLog.count({ where: { ...requestWhere, createdAt: { gte: startOfToday() } } }),
      prisma.proxyRequestLog.count({ where: { ...requestWhere, createdAt: { gte: since24h }, decision: 'denied' } }),
      // "Last used" = last time the proxy actually routed to upstream (allowed), not a denial/503.
      prisma.proxyRequestLog.findFirst({ where: { ...requestWhere, decision: 'allowed' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ]);
    const total = agg._count.id;
    const tokens = (agg._sum.cacheHitTokens ?? 0) + (agg._sum.cacheMissTokens ?? 0) + (agg._sum.outputTokens ?? 0);
    success(res, {
      requests24h:   total,
      requestsToday: todayCount,
      errorRatePct:  total > 0 ? Math.round((denied / total) * 1000) / 10 : 0,
      avgLatencyMs:  Math.round(agg._avg.latencyMs ?? 0),
      tokensPerMin:  Math.round(tokens / (24 * 60)),
      lastUsedAt:    last?.createdAt.toISOString() ?? null,
    });
  }));

  // ─── GET /audit — recent proxied requests (allow/deny feed) ─────────
  router.get('/audit', asyncRoute(async (req, res) => {
    const companyId = qCompany(req, res);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const decisionQ = typeof req.query.decision === 'string' ? req.query.decision : undefined;
    const decision = decisionQ === 'allowed' || decisionQ === 'denied' ? decisionQ : undefined;
    const userId = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : undefined;
    const channel = qChannel(req);

    const rows = await prisma.proxyRequestLog.findMany({
      where:   { companyId, ...(decision ? { decision } : {}), ...(userId ? { userId } : {}), ...(channel ? { channel } : {}) },
      orderBy: { createdAt: 'desc' },
      take:    limit,
    });
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.name ?? u.email ?? u.id]));

    success(res, rows.map((r) => ({
      id:        r.id,
      createdAt: r.createdAt.toISOString(),
      userId:    r.userId,
      user:      nameById.get(r.userId) ?? r.userId,
      model:     r.model,
      channel:   r.channel,
      provider:  r.provider,
      agentTarget: r.agentTarget,
      tokens:    r.cacheHitTokens + r.cacheMissTokens + r.outputTokens,
      costUsd:   costUsd(r.model, { cacheMissIn: r.cacheMissTokens, cacheHitIn: r.cacheHitTokens, output: r.outputTokens }),
      latencyMs: r.latencyMs,
      decision:  r.decision,
      reason:    r.reason,
      httpStatus: r.httpStatus,
    })));
  }));

  return router;
}
