/**
 * AI provider connection routes.
 *
 * Mounted at /api/admin/ai-providers.
 *
 *   GET    /status             — provider connection states
 *   POST   /openai/connect     — store Gateway dedicated account credentials
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
import { decryptToken, encryptToken, TokenCryptoError } from '../../infrastructure/shared/token.crypto';

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
  apiKey:             z.string().min(1),
  gatewayUrl:         z.string().url(),
  dedicatedAccountId: z.string().min(1).max(200),
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

export function createAiProvidersRoutes(deps: AiProvidersRoutesDeps): Router {
  const router = Router();
  const { prisma, env, logger } = deps;
  const log = logger.child({ routes: 'ai-providers' });

  function assertSuperAdmin(res: Response): void {
    if (!Boolean(res.locals['isSuperAdmin'])) {
      throw routeError(403, 'Super admin access required');
    }
  }

  function resolveCompanyId(res: Response, providedId?: string): string {
    const localId = (res.locals['companyId'] as string | undefined) ?? '';
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

  function decryptGatewayApiKey(cipherText: string): string {
    try {
      return decryptToken(cipherText, env.ZOHO_TOKEN_ENCRYPTION_KEY ?? '');
    } catch (error) {
      if (error instanceof TokenCryptoError) {
        throw routeError(500, 'Stored Gateway API key cannot be decrypted');
      }
      throw error;
    }
  }

  router.get('/status', asyncRoute(async (req, res) => {
    assertSuperAdmin(res);
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

    success(res, {
      companyId: company.id,
      providers: {
        openai: {
          connected:          openAiConnected,
          status:             openAiConnected ? 'connected' : 'disconnected',
          gatewayUrl:         company.gatewayUrl,
          dedicatedAccountId: company.gatewayDedicatedAccountId,
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
    assertSuperAdmin(res);
    const payload = connectOpenAiSchema.parse(req.body);
    const companyId = resolveCompanyId(res, payload.companyId);
    const gatewayUrl = normalizeGatewayUrl(payload.gatewayUrl);
    const encryptedKey = encryptGatewayApiKey(payload.apiKey);

    const company = await prisma.company.update({
      where: { id: companyId },
      data:  {
        gatewayApiKey:             encryptedKey,
        gatewayUrl,
        gatewayDedicatedAccountId: payload.dedicatedAccountId.trim(),
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
      gatewayUrl:         company.gatewayUrl,
      dedicatedAccountId: company.gatewayDedicatedAccountId,
      updatedAt:          company.updatedAt.toISOString(),
    }, 'OpenAI Gateway connected', 201);
  }));

  router.delete('/openai/disconnect', asyncRoute(async (req, res) => {
    assertSuperAdmin(res);
    const payload = companyScopedSchema.parse(req.body ?? {});
    const companyId = resolveCompanyId(res, payload.companyId);

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
    assertSuperAdmin(res);
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

    const apiKey = decryptGatewayApiKey(company.gatewayApiKey);
    const url = `${normalizeGatewayUrl(company.gatewayUrl)}/admin/dedicated/status/${encodeURIComponent(company.gatewayDedicatedAccountId)}`;
    const startedAt = Date.now();
    const gatewayRes = await fetch(url, {
      method:  'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'x-api-key':  apiKey,
      },
    });
    const latencyMs = Date.now() - startedAt;
    const body = await tryJson(gatewayRes);

    if (!gatewayRes.ok) {
      log.warn('openai.gateway.test.failed', { companyId, status: gatewayRes.status, latencyMs });
      success(res, {
        ok:        false,
        status:    gatewayRes.status,
        latencyMs,
        response:  body,
      }, 'OpenAI Gateway test failed', 502);
      return;
    }

    success(res, {
      ok:        true,
      status:    gatewayRes.status,
      latencyMs,
      response:  body,
    }, 'OpenAI Gateway connection test succeeded');
  }));

  router.put('/settings', asyncRoute(async (req, res) => {
    assertSuperAdmin(res);
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
