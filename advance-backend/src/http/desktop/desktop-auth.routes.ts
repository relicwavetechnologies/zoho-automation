import { Router, type Request, type Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma';
import type { LarkOAuthService } from '../../infrastructure/lark/lark-oauth.service';
import type { GoogleOAuthService } from '../../infrastructure/google/google-oauth.service';
import type { LarkUserAuthLinkRepository } from '../../infrastructure/persistence/lark-user-auth-link.repository';
import type { GoogleUserAuthLinkRepository } from '../../infrastructure/google/google-user-auth-link.repository';
import type { Logger } from '../../shared/logger';
import { createMemberAuthMiddleware } from '../middleware/member-auth.middleware';

export interface DesktopAuthRoutesDeps {
  prisma:                 PrismaClient;
  larkOAuthService:       LarkOAuthService;
  googleOAuthService:     GoogleOAuthService;
  larkUserAuthLinkRepo:   LarkUserAuthLinkRepository;
  googleUserAuthLinkRepo: GoogleUserAuthLinkRepository;
  logger:                 Logger;
  memberJwtSecret:        string;
  backendPublicUrl:       string;
  sessionTtlMinutes:      number;
}

interface StatePayload {
  kind: string;
  nonce: string;
  userId?: string;
  companyId?: string;
  sessionId?: string;
  exp?: number;
}

const DESKTOP_PROTOCOL = 'cursorr';
const HANDOFF_TTL_MS   = 5 * 60 * 1000;

const pendingCallbacks = new Map<string, { code: string; state: string; createdAt: number }>();
const pendingCallbackCleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingCallbacks) {
    if (now - v.createdAt > 5 * 60 * 1000) pendingCallbacks.delete(k);
  }
}, 60_000);
pendingCallbackCleanup.unref?.();

function signJwt(payload: Record<string, unknown>, secret: string, expiresInSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
  })).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token: string, secret: string): StatePayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64url');
  try {
    if (!timingSafeEqual(Buffer.from(sigB64, 'base64url'), Buffer.from(expected, 'base64url'))) return null;
  } catch { return null; }
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as StatePayload;
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

async function issueDesktopSession(
  deps: DesktopAuthRoutesDeps,
  userId: string,
  companyId: string,
  role: string,
  opts: { authProvider: string; larkTenantKey?: string; larkOpenId?: string; larkUserId?: string | null },
) {
  const sessionId = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + deps.sessionTtlMinutes * 60 * 1000);

  await deps.prisma.memberSession.create({
    data: {
      sessionId,
      userId,
      companyId,
      role,
      channel:       'desktop',
      authProvider:   opts.authProvider,
      larkTenantKey:  opts.larkTenantKey ?? null,
      larkOpenId:     opts.larkOpenId ?? null,
      larkUserId:     opts.larkUserId ?? null,
      expiresAt,
    },
  });

  const token = signJwt(
    { userId, sessionId, role, companyId, channel: 'desktop' },
    deps.memberJwtSecret,
    deps.sessionTtlMinutes * 60,
  );

  return { token, sessionId, userId, companyId, role, expiresAt };
}

export function createDesktopAuthRoutes(deps: DesktopAuthRoutesDeps): Router {
  const router = Router();
  const log = deps.logger.child({ service: 'desktop-auth' });

  const memberAuth = createMemberAuthMiddleware({
    prisma:    deps.prisma,
    jwtSecret: deps.memberJwtSecret,
    logger:    deps.logger,
  });

  // ── Lark OAuth (no auth) ──────────────────────────────────────────────────

  router.get('/lark/authorize-url', async (_req: Request, res: Response) => {
    try {
      if (!deps.larkOAuthService.isConfigured()) {
        res.status(503).json({ success: false, message: 'Lark OAuth not configured' });
        return;
      }

      const nonce = randomBytes(16).toString('hex');
      const state = signJwt(
        { kind: 'desktop_lark_login', nonce },
        deps.memberJwtSecret,
        600,
      );

      const redirectUri = `${deps.backendPublicUrl}/api/desktop/auth/lark/callback`;
      const authorizeUrl = deps.larkOAuthService.getAuthorizeUrl(state, { redirectUri });

      res.json({ success: true, data: { authorizeUrl, redirectUri, nonce } });
    } catch (e) {
      log.error('lark.authorize-url.error', { error: String(e) });
      res.status(500).json({ success: false, message: 'Failed to generate authorize URL' });
    }
  });

  router.get('/lark/callback', (req: Request, res: Response) => {
    const { code, state } = req.query;
    if (!code || !state) {
      res.status(400).send('<html><body><h2>Missing code or state</h2></body></html>');
      return;
    }

    const statePayload = verifyJwt(String(state), deps.memberJwtSecret);
    if (statePayload?.nonce) {
      pendingCallbacks.set(statePayload.nonce, {
        code: String(code),
        state: String(state),
        createdAt: Date.now(),
      });
    }

    res.send(`<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Divo authentication complete</title>
  </head>
  <body style="background:#111217;color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">
    <main style="width:min(420px,calc(100vw - 48px));border:1px solid rgba(255,255,255,.12);border-radius:18px;background:#181a22;padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.45);text-align:center">
      <div style="width:44px;height:44px;border-radius:14px;background:linear-gradient(135deg,#2563eb,#7c3aed);display:grid;place-items:center;margin:0 auto 16px;font-weight:800">D</div>
      <h1 style="font-size:20px;line-height:1.25;margin:0 0 8px">Authentication complete</h1>
      <p style="font-size:14px;line-height:1.6;color:#a1a1aa;margin:0 0 18px">Return to Divo Desktop. This tab can be closed.</p>
      <button onclick="window.close()" style="border:1px solid rgba(255,255,255,.16);border-radius:10px;background:#f4f4f5;color:#111217;padding:10px 14px;font-weight:650;cursor:pointer">Close window</button>
      <p style="font-size:12px;color:#71717a;margin:18px 0 0">If it does not close automatically, close it manually.</p>
    </main>
    <script>setTimeout(() => window.close(), 2500);</script>
  </body>
</html>`);
  });

  router.get('/lark/poll', (req: Request, res: Response) => {
    const nonce = String(req.query.nonce ?? '');
    if (!nonce) {
      res.status(400).json({ success: false, message: 'nonce required' });
      return;
    }
    const pending = pendingCallbacks.get(nonce);
    if (!pending) {
      res.json({ success: false, pending: true });
      return;
    }
    pendingCallbacks.delete(nonce);
    res.json({ success: true, data: { code: pending.code, state: pending.state } });
  });

  router.post('/lark/exchange', async (req: Request, res: Response) => {
    try {
      const { code, state } = req.body as { code?: string; state?: string };
      log.info('lark.exchange.attempt', { hasCode: !!code, hasState: !!state, codeLen: code?.length, stateLen: state?.length });
      if (!code || !state) {
        log.warn('lark.exchange.missing_params', { code: !!code, state: !!state });
        res.status(400).json({ success: false, message: 'code and state are required' });
        return;
      }

      const payload = verifyJwt(state, deps.memberJwtSecret);
      if (!payload || payload.kind !== 'desktop_lark_login') {
        log.warn('lark.exchange.bad_state', { payloadKind: payload?.kind, hasPayload: !!payload });
        res.status(400).json({ success: false, message: 'Invalid or expired state token' });
        return;
      }

      const redirectUri = `${deps.backendPublicUrl}/api/desktop/auth/lark/callback`;
      const tokenBundle = await deps.larkOAuthService.exchangeCode(code, redirectUri);
      log.info('lark.exchange.token_bundle', {
        larkEmail: tokenBundle.larkEmail, larkName: tokenBundle.larkName,
        larkOpenId: tokenBundle.larkOpenId, tenantKey: tokenBundle.tenantKey,
      });

      const tenantKey = tokenBundle.tenantKey ?? '';

      const company = await deps.prisma.company.findFirst();
      if (!company) {
        res.status(500).json({ success: false, message: 'No company configured' });
        return;
      }
      const companyId = company.id;

      let email = (tokenBundle.larkEmail?.trim()) || null;

      let user: { id: string; email: string; name: string | null } | null = null;

      if (email) {
        user = await deps.prisma.user.findFirst({
          where: { email: { equals: email, mode: 'insensitive' as const } },
        });
      }

      if (!user && tokenBundle.larkOpenId) {
        const existingLink = await deps.prisma.larkUserAuthLink.findFirst({
          where: { larkOpenId: tokenBundle.larkOpenId, companyId, revokedAt: null },
          select: { userId: true },
        });
        if (existingLink) {
          user = await deps.prisma.user.findUnique({ where: { id: existingLink.userId } });
        }
      }

      if (!user) {
        if (!email) {
          log.warn('lark.exchange.email_missing', {
            larkOpenId: tokenBundle.larkOpenId,
            returnedScopes: tokenBundle.scope,
          });
          res.status(400).json({
            success: false,
            message: 'Lark did not return an email. Check that the Lark app has email scope enabled and published, then sign in again.',
          });
          return;
        }

        const userEmail = email;
        const hashedPassword = createHmac('sha256', deps.memberJwtSecret)
          .update(randomBytes(32)).digest('hex');
        user = await deps.prisma.user.create({
          data: { email: userEmail, name: tokenBundle.larkName ?? 'Lark User', password: hashedPassword },
        });
        log.info('lark.exchange.user_created', { userId: user.id, email: userEmail });
      }

      const membership = await deps.prisma.adminMembership.findFirst({
        where: { userId: user.id, companyId, isActive: true },
      });
      const role = membership?.role ?? 'MEMBER';
      if (!membership) {
        await deps.prisma.adminMembership.create({
          data: { userId: user.id, companyId, role: 'MEMBER', isActive: true },
        });
      }

      const accessExpiry = new Date(Date.now() + (tokenBundle.expiresIn ?? 7200) * 1000);
      const refreshExpiry = tokenBundle.refreshTokenExpiresIn
        ? new Date(Date.now() + tokenBundle.refreshTokenExpiresIn * 1000)
        : new Date(Date.now() + 30 * 24 * 3600 * 1000);

      const upsertResult = await deps.larkUserAuthLinkRepo.upsert({
        userId:    user.id,
        companyId,
        larkTenantKey: tenantKey,
        larkOpenId:    tokenBundle.larkOpenId,
        larkUserId:    tokenBundle.larkUserId ?? null,
        larkEmail:     email || user.email,
        larkName:      tokenBundle.larkName ?? null,
        accessToken:   tokenBundle.accessToken,
        refreshToken:  tokenBundle.refreshToken ?? '',
        tokenType:     tokenBundle.tokenType ?? 'Bearer',
        accessTokenExpiresAt:  accessExpiry,
        refreshTokenExpiresAt: refreshExpiry,
      });
      if (!upsertResult.ok) {
        log.error('lark.exchange.upsert_failed', { error: String(upsertResult.error) });
      }

      const session = await issueDesktopSession(deps, user.id, companyId, role, {
        authProvider:  'lark',
        larkTenantKey: tenantKey,
        larkOpenId:    tokenBundle.larkOpenId,
        larkUserId:    tokenBundle.larkUserId,
      });

      const departments = await deps.prisma.department.findMany({
        where: { companyId, memberships: { some: { userId: user.id } } },
        select: { id: true, name: true },
      });

      log.info('lark.exchange.success', { userId: user.id, email: user.email });

      res.json({
        success: true,
        data: {
          token: session.token,
          session: {
            ...session,
            authProvider: 'lark',
            email: user.email,
            name: user.name ?? email,
            larkTenantKey: tenantKey,
            larkOpenId:    tokenBundle.larkOpenId,
            larkUserId:    tokenBundle.larkUserId,
            departments,
          },
        },
        message: 'Desktop Lark session issued',
      });
    } catch (e) {
      log.error('lark.exchange.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  // ── Handoff exchange (no auth — code is credential) ──────────────────────

  router.post('/exchange', async (req: Request, res: Response) => {
    try {
      const { code } = req.body as { code?: string };
      if (!code) {
        res.status(400).json({ success: false, message: 'code is required' });
        return;
      }

      const handoff = await deps.prisma.desktopAuthHandoff.findUnique({ where: { code } });
      if (!handoff) {
        res.status(404).json({ success: false, message: 'Invalid handoff code' });
        return;
      }
      if (handoff.consumedAt) {
        res.status(409).json({ success: false, message: 'Handoff code already used' });
        return;
      }
      if (handoff.expiresAt.getTime() <= Date.now()) {
        res.status(410).json({ success: false, message: 'Handoff code has expired' });
        return;
      }

      await deps.prisma.desktopAuthHandoff.update({
        where: { id: handoff.id },
        data:  { consumedAt: new Date() },
      });

      const session = await issueDesktopSession(deps, handoff.userId, handoff.companyId, handoff.role, {
        authProvider: 'handoff',
      });

      const user = await deps.prisma.user.findUnique({ where: { id: handoff.userId } });

      res.json({
        success: true,
        data: {
          token: session.token,
          session: { ...session, authProvider: 'handoff', email: user?.email, name: user?.name },
        },
        message: 'Desktop session issued via handoff',
      });
    } catch (e) {
      log.error('exchange.handoff.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  // ── Protected routes (require member session) ────────────────────────────

  router.post('/handoff', memberAuth, async (_req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      const role      = (res.locals['aiRole'] as string) ?? 'MEMBER';

      const code = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);

      await deps.prisma.desktopAuthHandoff.create({
        data: { code, userId, companyId, role, expiresAt },
      });

      res.json({ success: true, data: { code, expiresAt: expiresAt.toISOString() } });
    } catch (e) {
      log.error('handoff.create.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/me', memberAuth, async (_req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;

      const user = await deps.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true },
      });
      const departments = await deps.prisma.department.findMany({
        where: { companyId, memberships: { some: { userId } } },
        select: { id: true, name: true },
      });
      const larkLink = await deps.prisma.larkUserAuthLink.findFirst({
        where: { userId, companyId, revokedAt: null },
        select: { larkOpenId: true, larkUserId: true, larkEmail: true, larkName: true, larkTenantKey: true },
      });
      const googleLink = await deps.prisma.googleUserAuthLink.findFirst({
        where: { userId, companyId, revokedAt: null },
        select: { googleEmail: true, googleName: true },
      });

      res.json({
        success: true,
        data: {
          userId, companyId,
          role: res.locals['aiRole'],
          email: user?.email,
          name:  user?.name,
          departments,
          lark:   larkLink ?? null,
          google: googleLink ?? null,
        },
      });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/departments', memberAuth, async (_req: Request, res: Response) => {
    const userId    = res.locals['userId'] as string;
    const companyId = res.locals['companyId'] as string;
    const departments = await deps.prisma.department.findMany({
      where: { companyId, memberships: { some: { userId } } },
      select: { id: true, name: true },
    });
    res.json({ success: true, data: departments });
  });

  router.get('/google/authorize-url', memberAuth, async (_req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;

      const state = signJwt(
        { kind: 'desktop_google_connect', nonce: randomBytes(16).toString('hex'), userId, companyId },
        deps.memberJwtSecret,
        600,
      );

      const redirectUri = `${deps.backendPublicUrl}/api/desktop/auth/google/callback`;
      const authorizeUrl = deps.googleOAuthService.getAuthorizeUrl({ state, redirectUri });

      res.json({ success: true, data: { authorizeUrl } });
    } catch (e) {
      log.error('google.authorize-url.error', { error: String(e) });
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.get('/google/callback', async (req: Request, res: Response) => {
    try {
      const { code, state, error: oauthError } = req.query;

      if (oauthError) {
        res.send('<html><body><h2>Google connection cancelled</h2><p>You can close this window.</p></body></html>');
        return;
      }
      if (!code || !state) {
        res.status(400).send('<html><body><h2>Missing code or state</h2></body></html>');
        return;
      }

      const payload = verifyJwt(String(state), deps.memberJwtSecret);
      if (!payload || payload.kind !== 'desktop_google_connect' || !payload.userId || !payload.companyId) {
        res.status(400).send('<html><body><h2>Invalid or expired state</h2></body></html>');
        return;
      }

      const redirectUri = `${deps.backendPublicUrl}/api/desktop/auth/google/callback`;
      const tokenBundle = await deps.googleOAuthService.exchangeAuthorizationCode(String(code), redirectUri);
      const userInfo = await deps.googleOAuthService.fetchUserInfo(tokenBundle.accessToken);

      const expiresAt = tokenBundle.expiresIn
        ? new Date(Date.now() + tokenBundle.expiresIn * 1000)
        : new Date(Date.now() + 3600 * 1000);

      const googleUpsertInput = {
        userId:     payload.userId,
        companyId:  payload.companyId,
        googleUserId: userInfo.sub,
        googleEmail:  userInfo.email ?? '',
        googleName:   userInfo.name ?? '',
        scope:        tokenBundle.scope ?? '',
        accessToken:  tokenBundle.accessToken,
        tokenType:    tokenBundle.tokenType ?? 'Bearer',
        accessTokenExpiresAt: expiresAt,
      };
      if (tokenBundle.refreshToken) (googleUpsertInput as Record<string, unknown>)['refreshToken'] = tokenBundle.refreshToken;
      const upsertResult = await deps.googleUserAuthLinkRepo.upsert(googleUpsertInput);
      if (!upsertResult.ok) {
        log.error('google.callback.upsert_failed', { error: String(upsertResult.error) });
      }

      log.info('google.callback.success', { userId: payload.userId });

      res.send(`<!DOCTYPE html><html><body>
<h2>Google connected successfully!</h2>
<p>You can close this window and return to Divo Desktop.</p>
<script>setTimeout(()=>window.close(),3000);</script>
</body></html>`);
    } catch (e) {
      log.error('google.callback.error', { error: String(e) });
      res.send(`<html><body><h2>Google connection failed</h2><p>${String(e)}</p></body></html>`);
    }
  });

  router.get('/google/status', memberAuth, async (_req: Request, res: Response) => {
    const userId    = res.locals['userId'] as string;
    const companyId = res.locals['companyId'] as string;
    const link = await deps.prisma.googleUserAuthLink.findFirst({
      where: { userId, companyId, revokedAt: null },
      select: { googleEmail: true, googleName: true, linkedAt: true, scope: true },
    });
    res.json({ success: true, data: { connected: !!link, ...(link ?? {}) } });
  });

  router.get('/usage', memberAuth, async (_req: Request, res: Response) => {
    const userId    = res.locals['userId'] as string;
    const companyId = res.locals['companyId'] as string;
    const executions = await deps.prisma.executionRun.count({ where: { companyId, userId } });
    const tokenUsage = await deps.prisma.aiTokenUsage.aggregate({
      where: { companyId, userId },
      _sum: { estimatedInputTokens: true, estimatedOutputTokens: true },
    });
    res.json({
      success: true,
      data: {
        totalExecutions:   executions,
        totalInputTokens:  tokenUsage._sum.estimatedInputTokens ?? 0,
        totalOutputTokens: tokenUsage._sum.estimatedOutputTokens ?? 0,
      },
    });
  });

  router.post('/logout', memberAuth, async (req: Request, res: Response) => {
    try {
      const token = req.headers['authorization']?.slice(7) ?? '';
      const jwtPayload = verifyJwt(token, deps.memberJwtSecret);
      if (jwtPayload?.sessionId) {
        await deps.prisma.memberSession.update({
          where: { sessionId: String(jwtPayload.sessionId) },
          data:  { revokedAt: new Date() },
        });
      }
      res.json({ success: true, message: 'Session revoked' });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/lark/unlink', memberAuth, async (_req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      await deps.prisma.larkUserAuthLink.updateMany({
        where: { userId, companyId, revokedAt: null },
        data:  { revokedAt: new Date() },
      });
      res.json({ success: true, message: 'Lark account unlinked' });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  router.post('/google/unlink', memberAuth, async (_req: Request, res: Response) => {
    try {
      const userId    = res.locals['userId'] as string;
      const companyId = res.locals['companyId'] as string;
      await deps.prisma.googleUserAuthLink.updateMany({
        where: { userId, companyId, revokedAt: null },
        data:  { revokedAt: new Date() },
      });
      res.json({ success: true, message: 'Google account unlinked' });
    } catch (e) {
      res.status(500).json({ success: false, message: String(e) });
    }
  });

  return router;
}
