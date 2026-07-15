/**
 * Lark user OAuth connect + callback routes.
 *
 * Flow:
 *   1. GET /api/lark/auth/connect   — build consent URL, store CSRF nonce, return URL as JSON
 *      (called by /login slash command handler, not by browser redirect)
 *   2. GET /api/lark/auth/callback  — validate state, exchange code, persist tokens, DM user, show result page
 *
 * State parameter (base64url-encoded JSON):
 *   { companyId, userId, larkOpenId, nonce }
 *
 * CSRF: random nonce stored in Redis (TTL 10 min) on /connect, validated + consumed on /callback.
 *
 * After successful connect the callback:
 *   - Stores encrypted tokens in Divo's generic IntegrationConnection
 *   - Sends a Lark DM to the user confirming connection
 *   - Returns a simple HTML success page the user can close
 */

import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { Client as LarkSdkClient, LoggerLevel } from '@larksuiteoapi/node-sdk';
import type { LarkOAuthService } from '../../infrastructure/lark/lark-oauth.service';
import type { IntegrationConnectionRepository } from '../../infrastructure/persistence/integration-connection.repository';
import type { CachePort } from '../../shared/cache';
import type { Logger } from '../../shared/logger';
import type { ChannelIdentityRepository } from '../../infrastructure/persistence/channel-identity.repository';

// ─── State ────────────────────────────────────────────────────────────────────

interface OAuthState {
  companyId:  string;
  userId:     string;
  larkOpenId: string;
  nonce:      string;
}

export const LARK_OAUTH_NONCE_TTL_SECONDS = 600; // 10 min

export function larkOAuthNonceKey(nonce: string): string {
  return `lark:oauth:nonce:${nonce}`;
}

export function encodeLarkOAuthState(s: OAuthState): string {
  return Buffer.from(JSON.stringify(s)).toString('base64url');
}

function decodeState(raw: string): OAuthState | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      typeof parsed.companyId  === 'string' &&
      typeof parsed.userId     === 'string' &&
      typeof parsed.larkOpenId === 'string' &&
      typeof parsed.nonce      === 'string'
    ) return parsed as OAuthState;
    return null;
  } catch { return null; }
}

// ─── HTML pages ───────────────────────────────────────────────────────────────

const successHtml = (name: string) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Divo — Connected</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0fdf4}
.card{background:#fff;border-radius:12px;padding:40px 48px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.icon{font-size:48px;margin-bottom:16px}.title{font-size:22px;font-weight:700;color:#15803d;margin:0 0 8px}
.sub{color:#6b7280;font-size:15px;margin:0}</style></head>
<body><div class="card">
<div class="icon">✅</div>
<p class="title">Connected as ${escapeHtml(name)}</p>
<p class="sub">You can close this tab and return to Lark.</p>
</div></body></html>`;

const errorHtml = (reason: string) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Divo — Error</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fef2f2}
.card{background:#fff;border-radius:12px;padding:40px 48px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.icon{font-size:48px;margin-bottom:16px}.title{font-size:22px;font-weight:700;color:#dc2626;margin:0 0 8px}
.sub{color:#6b7280;font-size:15px;margin:0}</style></head>
<body><div class="card">
<div class="icon">❌</div>
<p class="title">Connection failed</p>
<p class="sub">${escapeHtml(reason)}</p>
</div></body></html>`;

function escapeHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Lark DM helper (SDK tenant-token based) ──────────────────────────────────

async function sendLarkDm(
  appId:      string,
  appSecret:  string,
  openId:     string,
  text:       string,
  apiBase:    string,
): Promise<void> {
  const client = new LarkSdkClient({
    appId,
    appSecret,
    domain: apiBase.replace(/\/$/, ''),
    loggerLevel: LoggerLevel.warn,
    source: 'divo',
  });
  const response = await client.im.v1.message.create({
    params: { receive_id_type: 'open_id' },
    data: { receive_id: openId, msg_type: 'text', content: JSON.stringify({ text }) },
  });
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`Lark DM failed: ${response.msg ?? response.code}`);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createLarkAuthRoutes(deps: {
  larkOAuthService:      LarkOAuthService;
  connectionRepo:        IntegrationConnectionRepository;
  cache:                 CachePort;
  logger:                Logger;
  appId:                 string;
  appSecret:             string;
  apiBase:               string;
  /** Optional: invalidate identity cache after OAuth link is saved. */
  channelIdentityRepo?:  ChannelIdentityRepository;
}): Router {
  const router = Router();
  const log    = deps.logger.child({ router: 'lark-auth' });

  // ── 1. Generate authorize URL ──────────────────────────────────────────────
  //
  // Legacy HTTP entry point. The webhook normally creates this URL internally.
  // Header values are never trusted: they must match the server-side Lark
  // identity mapping before an OAuth nonce is issued.
  //
  router.get('/connect', async (req: Request, res: Response) => {
    if (!deps.larkOAuthService.isConfigured()) {
      res.status(503).json({ error: 'lark_oauth_not_configured' });
      return;
    }

    const companyId  = req.headers['x-company-id']   as string | undefined;
    const userId     = req.headers['x-user-id']       as string | undefined;
    const larkOpenId = req.headers['x-lark-open-id']  as string | undefined;

    if (!companyId || !userId || !larkOpenId) {
      res.status(400).json({ error: 'missing_required_headers' });
      return;
    }

    if (!deps.channelIdentityRepo) {
      res.status(503).json({ error: 'lark_identity_validation_unavailable' });
      return;
    }

    const identity = await deps.channelIdentityRepo.prepareLarkLogin(larkOpenId);
    if (
      !identity.ok
      || identity.value?.status !== 'ready'
      || identity.value.companyId !== companyId
      || identity.value.userId !== userId
      || identity.value.larkOpenId !== larkOpenId
    ) {
      log.warn('lark.auth.connect.identity_mismatch', { companyId, userId, larkOpenId });
      res.status(403).json({ error: 'lark_identity_mismatch' });
      return;
    }

    const nonce = deps.larkOAuthService.generateNonce();
    await deps.cache.set(larkOAuthNonceKey(nonce), { companyId, userId, larkOpenId }, LARK_OAUTH_NONCE_TTL_SECONDS);

    const state = encodeLarkOAuthState({ companyId, userId, larkOpenId, nonce });
    const url   = deps.larkOAuthService.getAuthorizeUrl(state);

    log.info('lark.auth.connect.initiated', { companyId, userId, larkOpenId });
    res.json({ url });
  });

  // ── 2. OAuth callback ──────────────────────────────────────────────────────

  router.get('/callback', async (req: Request, res: Response) => {
    const code     = req.query['code']  as string | undefined;
    const stateRaw = req.query['state'] as string | undefined;
    const error    = req.query['error'] as string | undefined;

    const sendError = (reason: string) => {
      res.status(400).send(errorHtml(reason));
    };

    if (error) {
      log.warn('lark.auth.callback.denied', { error });
      sendError('You denied the authorization request.');
      return;
    }

    if (!code || !stateRaw) {
      sendError('Invalid callback — missing code or state.');
      return;
    }

    const state = decodeState(stateRaw);
    if (!state) {
      log.warn('lark.auth.callback.invalid_state', { stateRaw: stateRaw.slice(0, 40) });
      sendError('Invalid state parameter.');
      return;
    }

    // Validate CSRF nonce
    const stored = await deps.cache.get<{ companyId: string; userId: string; larkOpenId: string }>(
      larkOAuthNonceKey(state.nonce),
    );
    if (
      !stored.ok
      || !stored.value
      || stored.value.companyId !== state.companyId
      || stored.value.userId !== state.userId
      || stored.value.larkOpenId !== state.larkOpenId
    ) {
      log.warn('lark.auth.callback.nonce_mismatch', { companyId: state.companyId });
      sendError('Session expired or invalid — please run /login again.');
      return;
    }
    await deps.cache.del(larkOAuthNonceKey(state.nonce));

    try {
      const tokens = await deps.larkOAuthService.exchangeCode(code);

      if (!tokens.accessToken) {
        throw new Error('No access token returned from Lark');
      }

      if (!tokens.larkOpenId || tokens.larkOpenId !== state.larkOpenId) {
        log.warn('lark.auth.callback.account_mismatch', {
          expectedLarkOpenId: state.larkOpenId,
          returnedLarkOpenId: tokens.larkOpenId || null,
          companyId: state.companyId,
          userId: state.userId,
        });
        throw new Error('The authorised Lark account does not match the account that started this connection');
      }

      const accessExpiresAt  = new Date(Date.now() + tokens.expiresIn * 1000);
      const refreshExpiresAt = tokens.refreshTokenExpiresIn
        ? new Date(Date.now() + tokens.refreshTokenExpiresIn * 1000)
        : null;

      const resolvedOpenId = tokens.larkOpenId;
      const result = await deps.connectionRepo.upsertLarkConnection({
        companyId: state.companyId,
        ownerType: 'user',
        ownerUserId: state.userId,
        createdBy: state.userId,
        larkOpenId: resolvedOpenId,
        larkTenantKey: tokens.tenantKey,
        larkEmail: tokens.larkEmail,
        larkUserId: tokens.larkUserId,
        larkName: tokens.larkName,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenType: tokens.tokenType,
        accessTokenExpiresAt: accessExpiresAt,
        refreshTokenExpiresAt: refreshExpiresAt,
        scopes: tokens.scope?.split(/\s+/).filter(Boolean) ?? [],
        initialAccess: 'admin',
      });

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      const displayName = tokens.larkName ?? tokens.larkEmail ?? 'you';
      log.info('lark.auth.user_link.saved', {
        companyId:  state.companyId,
        userId:     state.userId,
        larkOpenId: resolvedOpenId,
        larkEmail:  tokens.larkEmail,
      });

      // Bust identity cache so next message resolves fresh DB state.
      if (resolvedOpenId && deps.channelIdentityRepo) {
        void deps.channelIdentityRepo.invalidateIdentityCache(resolvedOpenId);
      }

      // Send DM confirmation (best-effort — don't fail the callback if this errors)
      const openIdForDm = resolvedOpenId;
      if (openIdForDm) {
        void sendLarkDm(
          deps.appId,
          deps.appSecret,
          openIdForDm,
          `✅ Connected! I can now act on your behalf in Lark — tasks, calendar, and more will show as created by you. Type /status to check your connection.`,
          deps.apiBase,
        ).catch(e => log.warn('lark.auth.dm_failed', { error: String(e) }));
      }

      res.send(successHtml(displayName));
    } catch (e) {
      log.error('lark.auth.callback.failed', { error: String(e), companyId: state.companyId });
      sendError('Something went wrong during the connection. Please try again.');
    }
  });

  return router;
}
