/**
 * AI provider connection routes.
 *
 * Mounted at /api/admin/ai-providers.
 *
 *   GET    /status             — provider connection states
 *   POST   /openai/connect     — initiate Gateway dedicated account OAuth
 *   POST   /openai/complete    — complete Gateway OAuth and store returned API key
 *   DELETE /openai/disconnect  — clear Gateway credentials
 *   POST   /openai/test        — test Gateway dedicated account status endpoint
 *   PUT    /settings           — update company default AI provider/model
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { TypedEnv } from '../../config/env';
import type { Logger } from '../../shared/logger';
import { encryptToken, TokenCryptoError } from '../../infrastructure/shared/token.crypto';

export interface AiProvidersRoutesDeps {
  prisma: PrismaClient;
  env: TypedEnv;
  logger: Logger;
}

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
      if (error instanceof z.ZodError) { fail(res, 400, error.issues[0]?.message ?? 'Invalid request'); return; }
      if (error instanceof Error && 'status' in error && typeof (error as RouteError).status === 'number') {
        fail(res, (error as RouteError).status, error.message); return;
      }
      throw error;
    }
  };

const providerSchema = z.enum(['openai', 'google']);

const companyScopedSchema = z.object({
  companyId: z.string().uuid().optional(),
});

const connectOpenAiSchema = companyScopedSchema.extend({
  tier:  z.enum(['free', 'pro']).default('pro'),
  label: z.string().min(1).max(200).optional(),
});

const completeOpenAiSchema = companyScopedSchema.extend({
  dedicatedAccountId: z.string().min(1).max(200),
  callbackUrl:        z.string().url(),
});

const settingsSchema = companyScopedSchema.extend({
  defaultAiProvider: providerSchema,
  defaultAiModel:    z.string().min(1).max(200),
});

function normalizeGatewayUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

async function tryJson(res: globalThis.Response): Promise<unknown> {
  try { return await res.json(); } catch { return null; }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function createAiProvidersRoutes(deps: AiProvidersRoutesDeps): Router {
  const router = Router();
  const { prisma, env, logger } = deps;
  const log = logger.child({ routes: 'ai-providers' });

  function isSuperAdmin(res: Response): boolean {
    return Boolean(res.locals['isSuperAdmin']);
  }

  function resolveCompanyId(res: Response, providedId?: string): string {
    const localId = (res.locals['companyId'] as string | undefined) ?? '';
    if (!isSuperAdmin(res) && providedId && providedId !== localId) {
      throw routeError(403, 'Cannot manage AI providers for another company');
    }
    if (providedId) return providedId;
    if (!localId) throw routeError(400, 'companyId is required');
    return localId;
  }

  function encryptGatewayApiKey(apiKey: string): string {
    try {
      return encryptToken(apiKey, env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '').cipherText;
    } catch (error) {
      if (error instanceof TokenCryptoError) {
        throw routeError(500, 'Gateway API key encryption is not configured');
      }
      throw error;
    }
  }

  function gatewayBaseUrl(): string {
    const baseUrl = normalizeGatewayUrl(env.GATEWAY_BASE_URL ?? '');
    if (!baseUrl) throw routeError(500, 'Gateway base URL is not configured');
    return baseUrl;
  }

  async function gatewayRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = gatewayBaseUrl();
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (env.GATEWAY_ADMIN_API_KEY) {
      headers.set('Authorization', `Bearer ${env.GATEWAY_ADMIN_API_KEY}`);
      headers.set('x-api-key', env.GATEWAY_ADMIN_API_KEY);
    }

    const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
    const body = await tryJson(res);
    if (!res.ok) {
      const message = asString(asRecord(body)['message']) ?? asString(asRecord(body)['error']) ?? `Gateway request failed with HTTP ${res.status}`;
      throw routeError(res.status >= 400 && res.status < 500 ? res.status : 502, message);
    }

    return body as T;
  }

  function mapGatewayStatus(input: unknown): {
    status?: string;
    planType?: string | null;
    primaryWindowPct?: number | null;
    secondaryWindowPct?: number | null;
    creditsBalance?: number | null;
    lastUsedAt?: string | null;
  } {
    const data = asRecord(input);
    const rateLimits = asRecord(data['rate_limits']);
    const status = asString(data['status']) ?? undefined;
    return {
      ...(status ? { status } : {}),
      planType:           asString(rateLimits['plan_type']) ?? asString(data['tier']),
      primaryWindowPct:   asNumber(rateLimits['primary_used_percent']),
      secondaryWindowPct: asNumber(rateLimits['secondary_used_percent']),
      creditsBalance:     asNumber(rateLimits['credits_balance']),
      lastUsedAt:         asString(data['last_used_at']),
    };
  }

  router.get('/status', asyncRoute(async (req, res) => {
    const companyId = resolveCompanyId(res, typeof req.query.companyId === 'string' ? req.query.companyId : undefined);
    const company = await prisma.company.findUnique({
      where:  { id: companyId },
      select: {
        id:                        true,
        gatewayApiKey:             true,
        gatewayUrl:                true,
        gatewayDedicatedAccountId: true,
        defaultAiProvider:         true,
        defaultAiModel:            true,
        updatedAt:                 true,
      },
    });
    if (!company) throw routeError(404, 'Company not found');

    const openAiConnected = Boolean(company.gatewayApiKey && company.gatewayUrl && company.gatewayDedicatedAccountId);
    const googleConnected = Boolean(env.GOOGLE_GENERATIVE_AI_API_KEY || env.GEMINI_API_KEY);
    let gatewayStatus: ReturnType<typeof mapGatewayStatus> = {};
    if (openAiConnected && company.gatewayDedicatedAccountId) {
      try {
        gatewayStatus = mapGatewayStatus(await gatewayRequest(
          `/admin/dedicated/status/${encodeURIComponent(company.gatewayDedicatedAccountId)}`,
          { method: 'GET' },
        ));
      } catch (error) {
        log.warn('openai.gateway.status.failed', { companyId, error: error instanceof Error ? error.message : String(error) });
      }
    }

    success(res, {
      companyId: company.id,
      providers: {
        openai: {
          connected:          openAiConnected,
          status:             gatewayStatus.status ?? (openAiConnected ? 'connected' : 'disconnected'),
          gatewayUrl:         company.gatewayUrl,
          dedicatedAccountId: company.gatewayDedicatedAccountId,
          planType:           gatewayStatus.planType,
          primaryWindowPct:   gatewayStatus.primaryWindowPct,
          secondaryWindowPct: gatewayStatus.secondaryWindowPct,
          creditsBalance:     gatewayStatus.creditsBalance,
          lastUsedAt:         gatewayStatus.lastUsedAt,
        },
        google: {
          connected: googleConnected,
          status:    googleConnected ? 'connected' : 'disconnected',
        },
      },
      settings: {
        defaultAiProvider: company.defaultAiProvider,
        defaultAiModel:    company.defaultAiModel,
      },
      updatedAt: company.updatedAt.toISOString(),
    }, 'AI provider status loaded');
  }));

  router.post('/openai/connect', asyncRoute(async (req, res) => {
    const payload = connectOpenAiSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);
    const gatewayUrl = gatewayBaseUrl();
    const initiated = asRecord(await gatewayRequest('/admin/dedicated/initiate', {
      method: 'POST',
      body:   JSON.stringify({
        owner_app: 'divo',
        label:     payload.label ?? `Divo ${companyId}`,
        tier:      payload.tier,
      }),
    }));

    const authUrl = asString(initiated['auth_url']);
    const sessionId = asString(initiated['session_id']);
    const dedicatedAccountId = asString(initiated['dedicated_account_id']);
    if (!authUrl || !sessionId || !dedicatedAccountId) {
      throw routeError(502, 'Gateway initiate response is missing auth URL or dedicated account ID');
    }

    success(res, {
      companyId,
      gatewayUrl,
      authUrl,
      sessionId,
      dedicatedAccountId,
    }, 'OpenAI Gateway authorization started', 201);
  }));

  router.post('/openai/complete', asyncRoute(async (req, res) => {
    const payload = completeOpenAiSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);
    const gatewayUrl = gatewayBaseUrl();

    const completed = asRecord(await gatewayRequest('/admin/dedicated/complete', {
      method: 'POST',
      body:   JSON.stringify({
        dedicated_account_id: payload.dedicatedAccountId,
        callback_url:         payload.callbackUrl,
      }),
    }));

    const apiKey = asString(completed['api_key']);
    const dedicatedAccountId = asString(completed['dedicated_account_id']) ?? payload.dedicatedAccountId;
    if (!apiKey) throw routeError(502, 'Gateway complete response did not include an API key');

    const company = await prisma.company.update({
      where: { id: companyId },
      data:  {
        gatewayApiKey:             encryptGatewayApiKey(apiKey),
        gatewayUrl,
        gatewayDedicatedAccountId: dedicatedAccountId,
      },
      select: {
        id:                        true,
        gatewayUrl:                true,
        gatewayDedicatedAccountId: true,
        updatedAt:                 true,
      },
    });

    success(res, {
      companyId:          company.id,
      connected:          true,
      status:             asString(completed['status']) ?? 'active',
      gatewayUrl:         company.gatewayUrl,
      dedicatedAccountId: company.gatewayDedicatedAccountId,
      tier:               asString(completed['tier']),
      updatedAt:          company.updatedAt.toISOString(),
    }, 'OpenAI Gateway connected');
  }));

  router.delete('/openai/disconnect', asyncRoute(async (req, res) => {
    const payload = companyScopedSchema.parse(req.body ?? {});
    const companyId = resolveCompanyId(res, payload.companyId);
    const existing = await prisma.company.findUnique({
      where:  { id: companyId },
      select: { gatewayDedicatedAccountId: true },
    });

    if (existing?.gatewayDedicatedAccountId) {
      try {
        await gatewayRequest(`/admin/dedicated/disconnect/${encodeURIComponent(existing.gatewayDedicatedAccountId)}`, { method: 'POST' });
      } catch (error) {
        log.warn('openai.gateway.disconnect.failed', { companyId, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const company = await prisma.company.update({
      where: { id: companyId },
      data:  {
        gatewayApiKey:             null,
        gatewayUrl:                null,
        gatewayDedicatedAccountId: null,
      },
      select: { id: true, updatedAt: true },
    });

    success(res, {
      companyId: company.id,
      connected: false,
      updatedAt: company.updatedAt.toISOString(),
    }, 'OpenAI Gateway disconnected');
  }));

  router.post('/openai/test', asyncRoute(async (req, res) => {
    const payload = companyScopedSchema.parse(req.body ?? {});
    const companyId = resolveCompanyId(res, payload.companyId);
    const company = await prisma.company.findUnique({
      where:  { id: companyId },
      select: { gatewayApiKey: true, gatewayUrl: true, gatewayDedicatedAccountId: true },
    });
    if (!company) throw routeError(404, 'Company not found');
    if (!company.gatewayApiKey || !company.gatewayUrl || !company.gatewayDedicatedAccountId) {
      throw routeError(400, 'OpenAI Gateway is not connected');
    }

    const startedAt = Date.now();
    const body = await gatewayRequest(
      `/admin/dedicated/test/${encodeURIComponent(company.gatewayDedicatedAccountId)}`,
      { method: 'POST' },
    );
    const latencyMs = Date.now() - startedAt;
    const data = asRecord(body);

    success(res, {
      ok:        data['success'] !== false,
      status:    200,
      latencyMs: asNumber(data['latency_ms']) ?? latencyMs,
      response:  body,
    }, 'OpenAI Gateway connection test succeeded');
  }));

  router.put('/settings', asyncRoute(async (req, res) => {
    const payload = settingsSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);

    const company = await prisma.company.update({
      where: { id: companyId },
      data:  {
        defaultAiProvider: payload.defaultAiProvider,
        defaultAiModel:    payload.defaultAiModel,
      },
      select: {
        id:                true,
        defaultAiProvider: true,
        defaultAiModel:    true,
        updatedAt:         true,
      },
    });

    success(res, {
      companyId:          company.id,
      defaultAiProvider:  company.defaultAiProvider,
      defaultAiModel:     company.defaultAiModel,
      updatedAt:          company.updatedAt.toISOString(),
    }, 'AI provider settings updated');
  }));

  return router;
}
