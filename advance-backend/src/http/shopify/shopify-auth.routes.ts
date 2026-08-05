import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import type { Logger } from '../../shared/logger';
import { ShopifyAuthorizationError, type ShopifyAuthorizationService } from '../../application/shopify/shopify-authorization.service';
import { normalizeShopDomain } from '../../domain/shopify/shopify-shop';

const connectQuerySchema = z.object({
  shop: z.string().trim().min(1).max(255),
  linkType: z.literal('company').default('company'),
  returnTo: z.string().trim().max(2_000).optional(),
}).strict();
const reconnectParamsSchema = z.object({ connectionId: z.string().uuid() }).strict();
const returnToQuerySchema = z.object({ returnTo: z.string().trim().max(2_000).optional() }).strict();

const NONCE_TTL_SECONDS = 600;
const COOKIE_NAME = 'divo_shopify_oauth_state';

export function createShopifyAuthRoutes(deps: {
  readonly authenticate: RequestHandler;
  readonly authorization: ShopifyAuthorizationService;
  readonly logger: Logger;
  readonly frontendBaseUrl: string;
}): Router {
  const router = Router();
  const log = deps.logger.child({ router: 'shopify-auth' });

  const setAuthorizationResponse = (
    res: Response,
    started: { signedState: string; authorizeUrl: string; expiresInSeconds: number },
  ) => {
    const secure = deps.authorization.usesSecureRedirectUri();
    res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, started.signedState, secure));
    res.status(200).json({ authorizeUrl: started.authorizeUrl, expiresInSeconds: started.expiresInSeconds });
  };

  router.get('/connections', deps.authenticate, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (res.locals['isAdmin'] !== true) {
      res.status(403).json({ error: 'company_connection_requires_admin' });
      return;
    }
    try {
      const connections = await deps.authorization.listCompanyConnections(String(res.locals['companyId']));
      res.status(200).json({ connections: connections.map(connection => ({
        connectionId: connection.connectionId,
        shopDomain: connection.shopDomain,
        label: connection.label,
        status: connection.status,
        reconnectRequired: connection.status === 'reauthorization_required',
        connectedAt: connection.connectedAt.toISOString(),
      })) });
    } catch (error) {
      log.warn('shopify.connections.list_failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ error: 'shopify_connection_status_unavailable' });
    }
  });

  router.get('/reconnect/:connectionId', deps.authenticate, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.authorization.isConfigured()) {
      res.status(503).json({ error: 'shopify_oauth_not_configured' });
      return;
    }
    if (res.locals['isAdmin'] !== true) {
      res.status(403).json({ error: 'company_connection_requires_admin' });
      return;
    }
    const params = reconnectParamsSchema.safeParse(req.params);
    const query = returnToQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) {
      res.status(400).json({ error: 'invalid_shopify_reconnect_request' });
      return;
    }
    let returnTo: string | undefined;
    if (query.data.returnTo) {
      try { returnTo = safeReturnTo(query.data.returnTo, deps.frontendBaseUrl); }
      catch { res.status(400).json({ error: 'invalid_return_to' }); return; }
    }
    try {
      const started = await deps.authorization.beginReconnect({
        companyId: String(res.locals['companyId']),
        userId: String(res.locals['userId']),
        connectionId: params.data.connectionId,
        ...(returnTo ? { returnTo } : {}),
      });
      setAuthorizationResponse(res, started);
    } catch (error) {
      if (error instanceof ShopifyAuthorizationError && error.code === 'not_found') {
        res.status(404).json({ error: 'shopify_connection_not_found' });
        return;
      }
      log.warn('shopify.oauth.reconnect_failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ error: 'oauth_state_storage_unavailable' });
    }
  });

  router.get('/connect', deps.authenticate, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.authorization.isConfigured()) {
      res.status(503).json({ error: 'shopify_oauth_not_configured' });
      return;
    }
    const parsed = connectQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_shopify_connect_request', issues: parsed.error.flatten() });
      return;
    }
    const shopDomain = normalizeShopDomain(parsed.data.shop);
    if (!shopDomain) {
      res.status(400).json({ error: 'invalid_shop_domain' });
      return;
    }
    if (res.locals['isAdmin'] !== true) {
      res.status(403).json({ error: 'company_connection_requires_admin' });
      return;
    }
    let returnTo: string | undefined;
    if (parsed.data.returnTo) {
      try {
        returnTo = safeReturnTo(parsed.data.returnTo, deps.frontendBaseUrl);
      } catch {
        res.status(400).json({ error: 'invalid_return_to' });
        return;
      }
    }
    try {
      const started = await deps.authorization.begin({
        companyId: String(res.locals['companyId']),
        userId: String(res.locals['userId']),
        shopDomain,
        ...(returnTo ? { returnTo } : {}),
      });
      log.info('shopify.oauth.started', {
        companyId: String(res.locals['companyId']),
        userId: String(res.locals['userId']),
        shopDomain,
        ownerType: 'company',
      });
      setAuthorizationResponse(res, started);
    } catch (error) {
      log.warn('shopify.oauth.state_store_failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ error: 'oauth_state_storage_unavailable' });
    }
  });

  router.get('/callback', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const failureUrl = `${deps.frontendBaseUrl}/settings/integrations?status=error&provider=shopify`;
    try {
      const params = new URL(req.originalUrl, 'http://localhost').searchParams;
      const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
      const outcome = await deps.authorization.complete({ searchParams: params, ...(cookie ? { signedStateCookie: cookie } : {}) });
      res.setHeader('Set-Cookie', expireCookie(COOKIE_NAME));
      if (outcome.status === 'denied') {
        res.redirect(`${deps.frontendBaseUrl}/settings/integrations?status=denied&provider=shopify`);
        return;
      }
      res.redirect(outcome.returnTo ?? `${deps.frontendBaseUrl}/settings/integrations?status=connected&provider=shopify`);
    } catch (error) {
      log.warn('shopify.oauth.callback_failed', { error: error instanceof Error ? error.message : String(error) });
      res.setHeader('Set-Cookie', expireCookie(COOKIE_NAME));
      res.redirect(failureUrl);
    }
  });

  return router;
}

function safeReturnTo(value: string, frontendBaseUrl: string): string {
  const frontend = new URL(frontendBaseUrl);
  const target = new URL(value, frontend);
  if (target.origin !== frontend.origin) throw new Error('returnTo must stay on the configured frontend origin.');
  return target.toString();
}

function serializeCookie(name: string, value: string, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Path=/api/shopify/auth; HttpOnly; SameSite=Lax; Max-Age=${NONCE_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

function expireCookie(name: string): string {
  return `${name}=; Path=/api/shopify/auth; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(';').flatMap(part => {
    const separator = part.indexOf('=');
    if (separator < 1) return [];
    const key = part.slice(0, separator).trim();
    try { return [[key, decodeURIComponent(part.slice(separator + 1).trim())]]; } catch { return []; }
  }));
}
