/**
 * Google OAuth 2.0 connect + callback routes.
 *
 * Flow:
 *   1. GET /api/google/auth/connect   — build consent URL, store CSRF nonce, redirect
 *   2. GET /api/google/auth/callback  — validate state, exchange code, persist link, redirect
 *
 * State parameter (base64-encoded JSON):
 *   { companyId, userId, nonce, linkType: 'user' | 'company', returnTo? }
 *
 * CSRF protection: a random nonce is written to Redis (TTL 10 min) on /connect and
 * validated on /callback before the code exchange.
 *
 * Authentication: /connect requires `x-company-id` + `x-user-id` request headers
 * (in production these come from the gateway JWT middleware).
 */

import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { GoogleOAuthService } from '../../infrastructure/google/google-oauth.service';
import type { GoogleUserAuthLinkRepository } from '../../infrastructure/google/google-user-auth-link.repository';
import type { CompanyGoogleAuthLinkRepository } from '../../infrastructure/google/company-google-auth-link.repository';
import type { CachePort } from '../../shared/cache';
import type { Logger } from '../../shared/logger';

// ─── State type ───────────────────────────────────────────────────────────────

interface OAuthState {
  companyId: string;
  userId:    string;
  nonce:     string;
  linkType:  'user' | 'company';
  returnTo?: string;
}

const NONCE_TTL_SECONDS = 600; // 10 minutes

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nonceKey(nonce: string): string {
  return `google:oauth:nonce:${nonce}`;
}

function encodeState(s: OAuthState): string {
  return Buffer.from(JSON.stringify(s)).toString('base64url');
}

function decodeState(raw: string): OAuthState | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed.companyId === 'string' &&
      typeof parsed.userId    === 'string' &&
      typeof parsed.nonce     === 'string' &&
      (parsed.linkType === 'user' || parsed.linkType === 'company')
    ) {
      return parsed as OAuthState;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createGoogleAuthRoutes(deps: {
  googleOAuthService:   GoogleOAuthService;
  googleUserLinkRepo:   GoogleUserAuthLinkRepository;
  companyGoogleAuthRepo: CompanyGoogleAuthLinkRepository;
  cache:                CachePort;
  logger:               Logger;
  frontendBaseUrl:      string;
}): Router {
  const router = Router();
  const log    = deps.logger.child({ router: 'google-auth' });

  // ── 1. Initiate consent flow ───────────────────────────────────────────────
  router.get('/connect', async (req: Request, res: Response) => {
    if (!deps.googleOAuthService.isConfigured()) {
      res.status(503).json({ error: 'google_oauth_not_configured' });
      return;
    }

    const companyId = req.headers['x-company-id'] as string | undefined;
    const userId    = req.headers['x-user-id']    as string | undefined;
    if (!companyId || !userId) {
      res.status(400).json({ error: 'missing_x_company_id_or_x_user_id_header' });
      return;
    }

    const linkType = (req.query['linkType'] as string) === 'company' ? 'company' : 'user';
    const returnTo = typeof req.query['returnTo'] === 'string' ? req.query['returnTo'] : undefined;
    const nonce    = randomBytes(24).toString('hex');

    // Store nonce in Redis to validate on callback
    await deps.cache.set(nonceKey(nonce), { companyId, userId }, NONCE_TTL_SECONDS);

    const state: OAuthState = { companyId, userId, nonce, linkType, ...(returnTo ? { returnTo } : {}) };
    const authorizeUrl = deps.googleOAuthService.getAuthorizeUrl({ state: encodeState(state) });

    log.info('google.auth.connect.initiated', { companyId, userId, linkType });
    res.redirect(authorizeUrl);
  });

  // ── 2. OAuth callback ──────────────────────────────────────────────────────
  router.get('/callback', async (req: Request, res: Response) => {
    const code      = req.query['code']  as string | undefined;
    const stateRaw  = req.query['state'] as string | undefined;
    const error     = req.query['error'] as string | undefined;

    const fallback = `${deps.frontendBaseUrl}/settings/integrations?status=error`;

    if (error) {
      log.warn('google.auth.callback.denied', { error });
      res.redirect(`${deps.frontendBaseUrl}/settings/integrations?status=denied`);
      return;
    }

    if (!code || !stateRaw) {
      res.redirect(fallback);
      return;
    }

    const state = decodeState(stateRaw);
    if (!state) {
      log.warn('google.auth.callback.invalid_state', { stateRaw });
      res.redirect(fallback);
      return;
    }

    // Validate CSRF nonce
    const stored = await deps.cache.get<{ companyId: string; userId: string }>(nonceKey(state.nonce));
    if (!stored.ok || !stored.value || stored.value.companyId !== state.companyId) {
      log.warn('google.auth.callback.nonce_mismatch', { companyId: state.companyId });
      res.redirect(fallback);
      return;
    }
    await deps.cache.del(nonceKey(state.nonce)); // consume the nonce

    try {
      // Exchange code for tokens
      const tokens = await deps.googleOAuthService.exchangeAuthorizationCode(code);

      // Fetch Google user info
      const userInfo = await deps.googleOAuthService.fetchUserInfo(tokens.accessToken);

      const expiresAt = tokens.expiresIn
        ? new Date(Date.now() + tokens.expiresIn * 1000)
        : undefined;

      if (state.linkType === 'company') {
        // Company-level Workspace link
        const result = await deps.companyGoogleAuthRepo.upsert({
          companyId:    state.companyId,
          googleUserId: userInfo.sub,
          accessToken:  tokens.accessToken,
          ...(userInfo.email        ? { googleEmail:          userInfo.email }         : {}),
          ...(userInfo.name         ? { googleName:           userInfo.name }          : {}),
          ...(tokens.refreshToken   ? { refreshToken:         tokens.refreshToken }    : {}),
          ...(tokens.tokenType      ? { tokenType:            tokens.tokenType }       : {}),
          ...(expiresAt             ? { accessTokenExpiresAt: expiresAt }              : {}),
        });
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        log.info('google.auth.company_link.saved', { companyId: state.companyId, googleEmail: userInfo.email });
      } else {
        // Per-user link
        const result = await deps.googleUserLinkRepo.upsert({
          companyId:    state.companyId,
          userId:       state.userId,
          googleUserId: userInfo.sub,
          accessToken:  tokens.accessToken,
          ...(userInfo.email        ? { googleEmail:          userInfo.email }         : {}),
          ...(userInfo.name         ? { googleName:           userInfo.name }          : {}),
          ...(tokens.refreshToken   ? { refreshToken:         tokens.refreshToken }    : {}),
          ...(tokens.tokenType      ? { tokenType:            tokens.tokenType }       : {}),
          ...(expiresAt             ? { accessTokenExpiresAt: expiresAt }              : {}),
        });
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        log.info('google.auth.user_link.saved', { companyId: state.companyId, userId: state.userId, googleEmail: userInfo.email });
      }

      const successUrl = state.returnTo ?? `${deps.frontendBaseUrl}/settings/integrations?status=connected&provider=google`;
      res.redirect(successUrl);
    } catch (e) {
      log.error('google.auth.callback.failed', { error: String(e), companyId: state.companyId });
      res.redirect(fallback);
    }
  });

  return router;
}
