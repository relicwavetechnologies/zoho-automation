/**
 * Zoho OAuth 2.0 connect + callback routes.
 *
 * Flow:
 *   1. GET /api/zoho/auth/connect   — build Zoho consent URL, store CSRF nonce, redirect
 *   2. GET /api/zoho/auth/callback  — validate state, exchange code, upsert ZohoConnection, redirect
 *
 * State parameter (base64-encoded JSON):
 *   { companyId, environment, nonce, returnTo? }
 *
 * CSRF protection: nonce stored in Redis with 10-minute TTL.
 *
 * Authentication: /connect requires `x-company-id` + `x-user-id` request headers.
 */

import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { ZohoTokenService } from '../../infrastructure/zoho/zoho-token.service';
import type { ZohoConnectionRepository } from '../../infrastructure/zoho/zoho-connection.repository';
import type { CachePort } from '../../shared/cache';
import type { Logger } from '../../shared/logger';
import type { TypedEnv } from '../../config/env';

// ─── State type ───────────────────────────────────────────────────────────────

interface ZohoOAuthState {
  companyId:   string;
  environment: string;
  nonce:       string;
  returnTo?:   string;
}

const NONCE_TTL_SECONDS    = 600;  // 10 minutes
const ZOHO_ACCOUNTS_BASE   = 'https://accounts.zoho.com';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nonceKey(nonce: string): string {
  return `zoho:oauth:nonce:${nonce}`;
}

function encodeState(s: ZohoOAuthState): string {
  return Buffer.from(JSON.stringify(s)).toString('base64url');
}

function decodeState(raw: string): ZohoOAuthState | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed.companyId === 'string' && typeof parsed.nonce === 'string') {
      return { ...parsed, environment: parsed.environment ?? 'prod' } as ZohoOAuthState;
    }
    return null;
  } catch {
    return null;
  }
}

/** Build the Zoho OAuth consent URL. */
function buildZohoAuthorizeUrl(opts: {
  clientId:    string;
  redirectUri: string;
  scopes:      string[];
  state:       string;
  accountsBaseUrl: string;
}): string {
  const url = new URL(`${opts.accountsBaseUrl.replace(/\/$/, '')}/oauth/v2/auth`);
  url.searchParams.set('client_id',     opts.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope',         opts.scopes.join(' '));
  url.searchParams.set('redirect_uri',  opts.redirectUri);
  url.searchParams.set('access_type',   'offline');
  url.searchParams.set('state',         opts.state);
  url.searchParams.set('prompt',        'consent');
  return url.toString();
}

// ─── Default Zoho scopes ──────────────────────────────────────────────────────

const DEFAULT_ZOHO_SCOPES = [
  'ZohoCRM.modules.ALL',
  'ZohoCRM.settings.ALL',
  'ZohoBooks.fullaccess.all',
  'ZohoBooks.contacts.all',
  'ZohoBooks.invoices.all',
  'ZohoBooks.expenses.all',
];

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createZohoAuthRoutes(deps: {
  zohoTokenService:    ZohoTokenService;
  zohoConnectionRepo:  ZohoConnectionRepository;
  cache:               CachePort;
  logger:              Logger;
  env:                 TypedEnv;
  frontendBaseUrl:     string;
}): Router {
  const router = Router();
  const log    = deps.logger.child({ router: 'zoho-auth' });

  const clientId    = (deps.env.ZOHO_CLIENT_ID     ?? '').trim();
  const redirectUri = (deps.env.ZOHO_REDIRECT_URI  ?? '').trim();
  const accountsBase = (deps.env.ZOHO_ACCOUNTS_BASE_URL ?? ZOHO_ACCOUNTS_BASE).trim();

  // ── 1. Initiate consent flow ───────────────────────────────────────────────
  router.get('/connect', async (req: Request, res: Response) => {
    if (!deps.zohoTokenService.isConfigured() || !redirectUri) {
      res.status(503).json({ error: 'zoho_oauth_not_configured' });
      return;
    }

    const companyId   = req.headers['x-company-id'] as string | undefined;
    const userId      = req.headers['x-user-id']    as string | undefined;
    if (!companyId || !userId) {
      res.status(400).json({ error: 'missing_x_company_id_or_x_user_id_header' });
      return;
    }

    const environment = (req.query['environment'] as string) || 'prod';
    const returnTo    = typeof req.query['returnTo'] === 'string' ? req.query['returnTo'] : undefined;
    const scopesParam = typeof req.query['scopes']   === 'string' ? req.query['scopes'].split(',') : undefined;
    const scopes      = scopesParam ?? DEFAULT_ZOHO_SCOPES;
    const nonce       = randomBytes(24).toString('hex');

    await deps.cache.set(nonceKey(nonce), { companyId, userId }, NONCE_TTL_SECONDS);

    const state: ZohoOAuthState = { companyId, environment, nonce, ...(returnTo ? { returnTo } : {}) };
    const authorizeUrl = buildZohoAuthorizeUrl({
      clientId,
      redirectUri,
      scopes,
      state:           encodeState(state),
      accountsBaseUrl: accountsBase,
    });

    log.info('zoho.auth.connect.initiated', { companyId, environment });
    res.redirect(authorizeUrl);
  });

  // ── 2. OAuth callback ──────────────────────────────────────────────────────
  router.get('/callback', async (req: Request, res: Response) => {
    const code     = req.query['code']  as string | undefined;
    const stateRaw = req.query['state'] as string | undefined;
    const error    = req.query['error'] as string | undefined;

    const fallback = `${deps.frontendBaseUrl}/settings/integrations?status=error`;

    if (error) {
      log.warn('zoho.auth.callback.denied', { error });
      res.redirect(`${deps.frontendBaseUrl}/settings/integrations?status=denied`);
      return;
    }

    if (!code || !stateRaw) {
      res.redirect(fallback);
      return;
    }

    const state = decodeState(stateRaw);
    if (!state) {
      log.warn('zoho.auth.callback.invalid_state', { stateRaw });
      res.redirect(fallback);
      return;
    }

    // Validate CSRF nonce
    const stored = await deps.cache.get<{ companyId: string }>(nonceKey(state.nonce));
    if (!stored.ok || !stored.value || stored.value.companyId !== state.companyId) {
      log.warn('zoho.auth.callback.nonce_mismatch', { companyId: state.companyId });
      res.redirect(fallback);
      return;
    }
    await deps.cache.del(nonceKey(state.nonce));

    try {
      // Exchange code for tokens
      const tokens = await deps.zohoTokenService.exchangeAuthorizationCode({
        companyId:         state.companyId,
        environment:       state.environment,
        authorizationCode: code,
        redirectUri,
      });

      // Persist to ZohoConnection
      const upsertResult = await deps.zohoConnectionRepo.upsertFromExchange({
        companyId:   state.companyId,
        environment: state.environment,
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        expiresIn:   tokens.expiresIn,
        scopes:      tokens.scopes,
      });

      if (!upsertResult.ok) {
        throw new Error(upsertResult.error.message);
      }

      log.info('zoho.auth.connection.saved', { companyId: state.companyId, environment: state.environment, scopes: tokens.scopes });

      const successUrl = state.returnTo ?? `${deps.frontendBaseUrl}/settings/integrations?status=connected&provider=zoho`;
      res.redirect(successUrl);
    } catch (e) {
      log.error('zoho.auth.callback.failed', { error: String(e), companyId: state.companyId });
      res.redirect(fallback);
    }
  });

  return router;
}
