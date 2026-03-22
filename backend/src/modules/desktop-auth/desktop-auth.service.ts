import crypto from 'crypto';
import jwt from 'jsonwebtoken';

import config from '../../config';
import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import { hashPassword } from '../../utils/bcrypt';
import { channelIdentityRepository } from '../../company/channels/channel-identity.repository';
import { larkOAuthService } from '../../company/channels/lark/lark-oauth.service';
import { larkTenantBindingRepository } from '../../company/channels/lark/lark-tenant-binding.repository';
import { larkUserAuthLinkRepository } from '../../company/channels/lark/lark-user-auth-link.repository';
import { larkWorkspaceConfigRepository } from '../../company/channels/lark/lark-workspace-config.repository';
import { googleOAuthService } from '../../company/channels/google/google-oauth.service';
import { googleUserAuthLinkRepository } from '../../company/channels/google/google-user-auth-link.repository';
import { memberAuthRepository, MemberAuthRepository } from '../member-auth/member-auth.repository';
import { memberAuthService, MemberLoginResult, MemberSessionDTO } from '../member-auth/member-auth.service';
import { DesktopAuthRepository, desktopAuthRepository } from './desktop-auth.repository';

type DesktopLarkStatePayload = {
  kind: 'desktop_lark_login';
  nonce: string;
};

type DesktopGoogleStatePayload = {
  kind: 'desktop_google_connect';
  nonce: string;
  userId: string;
  companyId: string;
};

const DESKTOP_LARK_STATE_TTL_SECONDS = 10 * 60;
const DESKTOP_GOOGLE_STATE_TTL_SECONDS = 10 * 60;
const DESKTOP_PROTOCOL_SCHEME = 'cursorr';

const normalizeEmail = (value?: string): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
};

const buildExpiry = (seconds?: number): Date | undefined => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return new Date(Date.now() + seconds * 1000);
};

export class DesktopAuthService extends BaseService {
  constructor(
    private readonly repository: DesktopAuthRepository = desktopAuthRepository,
    private readonly members: MemberAuthRepository = memberAuthRepository,
  ) {
    super();
  }

  async createLarkAuthorizeUrl(): Promise<{ authorizeUrl: string; redirectUri: string }> {
    if (!larkOAuthService.isConfigured('desktop')) {
      throw new HttpException(400, 'Lark OAuth is not configured for desktop sign-in.');
    }

    const state = jwt.sign(
      {
        kind: 'desktop_lark_login',
        nonce: crypto.randomBytes(16).toString('hex'),
      } satisfies DesktopLarkStatePayload,
      config.JWT_SECRET,
      { expiresIn: `${DESKTOP_LARK_STATE_TTL_SECONDS}s` },
    );

    const redirectUri = larkOAuthService.getRedirectUri('desktop');
    return {
      authorizeUrl: larkOAuthService.getAuthorizeUrl({ state, redirectUri }),
      redirectUri,
    };
  }

  async createGoogleAuthorizeUrl(session: MemberSessionDTO): Promise<{ authorizeUrl: string; redirectUri: string; scopes: string[] }> {
    if (!googleOAuthService.isConfigured()) {
      throw new HttpException(400, 'Google OAuth is not configured for desktop connections.');
    }

    const state = jwt.sign(
      {
        kind: 'desktop_google_connect',
        nonce: crypto.randomBytes(16).toString('hex'),
        userId: session.userId,
        companyId: session.companyId,
      } satisfies DesktopGoogleStatePayload,
      config.JWT_SECRET,
      { expiresIn: `${DESKTOP_GOOGLE_STATE_TTL_SECONDS}s` },
    );

    const redirectUri = googleOAuthService.getRedirectUri();
    return {
      authorizeUrl: googleOAuthService.getAuthorizeUrl({ state, redirectUri }),
      redirectUri,
      scopes: googleOAuthService.getScopes(),
    };
  }

  async getGoogleStatus(session: MemberSessionDTO): Promise<{
    configured: boolean;
    connected: boolean;
    email?: string;
    name?: string;
    scopes?: string[];
    updatedAt?: string;
  }> {
    const configured = googleOAuthService.isConfigured();
    const link = await googleUserAuthLinkRepository.findActiveByUser(session.userId, session.companyId);
    return {
      configured,
      connected: Boolean(link),
      email: link?.googleEmail,
      name: link?.googleName,
      scopes: link?.scopes,
      updatedAt: link?.updatedAt?.toISOString(),
    };
  }

  private async resolveCompanyIdForLarkDesktopLogin(tenantKey: string): Promise<{
    companyId: string | null;
    shouldBackfillBinding: boolean;
  }> {
    const boundCompanyId = await larkTenantBindingRepository.resolveCompanyId(tenantKey);
    if (boundCompanyId) {
      return {
        companyId: boundCompanyId,
        shouldBackfillBinding: false,
      };
    }

    if (config.LARK_TENANT_BINDING_ENFORCED) {
      return {
        companyId: null,
        shouldBackfillBinding: false,
      };
    }

    const configuredCompanyIds = await larkWorkspaceConfigRepository.listConfiguredCompanyIds();
    if (configuredCompanyIds.length === 1) {
      return {
        companyId: configuredCompanyIds[0],
        shouldBackfillBinding: true,
      };
    }

    return {
      companyId: null,
      shouldBackfillBinding: false,
    };
  }

  async exchangeLarkAuthorizationCode(input: { code: string; state: string }): Promise<MemberLoginResult> {
    this.verifyDesktopLarkState(input.state);

    const tokenBundle = await larkOAuthService.exchangeAuthorizationCode(input.code);
    const userInfo = await larkOAuthService.fetchUserInfo(tokenBundle.accessToken);
    const email = normalizeEmail(userInfo.email);
    if (!email) {
      throw new HttpException(403, 'Your Lark account does not have an email address. Ask your admin to sync directory email first.');
    }

    const {
      companyId,
      shouldBackfillBinding,
    } = await this.resolveCompanyIdForLarkDesktopLogin(userInfo.tenantKey);
    if (!companyId) {
      throw new HttpException(403, 'This Lark workspace is not connected to a company in the app.');
    }

    const externalUserId = userInfo.openId?.trim() || userInfo.userId?.trim();
    const syncedIdentity = await channelIdentityRepository.findLarkIdentityForProvisioning({
      companyId,
      externalUserId: externalUserId || undefined,
      larkOpenId: userInfo.openId,
      larkUserId: userInfo.userId,
      email,
    });
    const provisionedRole =
      typeof syncedIdentity?.aiRole === 'string' && syncedIdentity.aiRole.trim().length > 0
        ? syncedIdentity.aiRole.trim()
        : 'MEMBER';

    let user = await this.members.findUserByEmailInsensitive(email);
    if (!user) {
      user = await this.members.createUser({
        email,
        name: userInfo.name,
        password: await hashPassword(crypto.randomUUID()),
      });
    }

    const membership = await this.members.ensureActiveMembership(user.id, companyId, provisionedRole);

    if (shouldBackfillBinding) {
      await larkTenantBindingRepository.upsert({
        companyId,
        larkTenantKey: userInfo.tenantKey,
        createdBy: user.id,
        isActive: true,
      });
    }

    await larkUserAuthLinkRepository.upsert({
      userId: user.id,
      companyId,
      larkTenantKey: userInfo.tenantKey,
      larkOpenId: userInfo.openId,
      larkUserId: userInfo.userId,
      larkEmail: email,
      larkName: userInfo.name,
      accessToken: tokenBundle.accessToken,
      refreshToken: tokenBundle.refreshToken,
      tokenType: tokenBundle.tokenType,
      accessTokenExpiresAt: buildExpiry(tokenBundle.expiresIn),
      refreshTokenExpiresAt: buildExpiry(tokenBundle.refreshExpiresIn),
      tokenMetadata: {
        source: 'desktop_oauth',
      },
    });

    if (externalUserId) {
      await channelIdentityRepository.upsert({
        channel: 'lark',
        externalUserId,
        externalTenantId: userInfo.tenantKey,
        companyId,
        displayName: userInfo.name,
        email,
        larkOpenId: userInfo.openId,
        larkUserId: userInfo.userId,
        aiRole: membership.role,
      });
    }

    return memberAuthService.issueDesktopSession(user.id, companyId, membership.role, {
      authProvider: 'lark',
      larkTenantKey: userInfo.tenantKey,
      larkOpenId: userInfo.openId,
      larkUserId: userInfo.userId,
    });
  }

  async exchangeGoogleAuthorizationCode(input: { code: string; state: string }): Promise<{
    linked: true;
    email?: string;
    name?: string;
  }> {
    const payload = this.verifyDesktopGoogleState(input.state);
    const redirectUri = googleOAuthService.getRedirectUri();
    const tokenBundle = await googleOAuthService.exchangeAuthorizationCode(input.code, redirectUri);
    const userInfo = await googleOAuthService.fetchUserInfo(tokenBundle.accessToken);

    await googleUserAuthLinkRepository.upsert({
      userId: payload.userId,
      companyId: payload.companyId,
      googleUserId: userInfo.sub,
      googleEmail: userInfo.email,
      googleName: userInfo.name,
      scope: tokenBundle.scope,
      accessToken: tokenBundle.accessToken,
      refreshToken: tokenBundle.refreshToken,
      tokenType: tokenBundle.tokenType,
      accessTokenExpiresAt: buildExpiry(tokenBundle.expiresIn),
    });

    return {
      linked: true,
      email: userInfo.email,
      name: userInfo.name,
    };
  }

  renderLarkCallbackHtml(input: { code?: string; state?: string; error?: string }): string {
    const target = new URL(`${DESKTOP_PROTOCOL_SCHEME}://auth/callback`);
    if (input.code) {
      target.searchParams.set('code', input.code);
    }
    if (input.state) {
      target.searchParams.set('state', input.state);
    }
    if (input.error) {
      target.searchParams.set('error', input.error);
    }

    const safeTarget = target.toString().replace(/"/g, '&quot;');
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Lark Desktop Sign-In</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#05070b;color:#f4f4f5;min-height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden;">
    <div style="position:fixed;inset:0;background:
      radial-gradient(circle at 20% 20%, rgba(59,130,246,0.14), transparent 28%),
      radial-gradient(circle at 80% 30%, rgba(16,185,129,0.10), transparent 24%),
      linear-gradient(180deg, #07090d 0%, #05070b 100%);"></div>
    <div style="position:fixed;inset:0;opacity:0.14;background-image:radial-gradient(rgba(255,255,255,0.22) 0.75px, transparent 0.75px);background-size:24px 24px;"></div>
    <main style="position:relative;z-index:1;width:min(560px,calc(100vw - 40px));padding:32px 32px 28px;border:1px solid rgba(255,255,255,0.09);border-radius:28px;background:rgba(10,12,18,0.86);box-shadow:0 30px 120px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.05);backdrop-filter:blur(18px);">
      <div style="display:inline-flex;align-items:center;gap:10px;margin-bottom:18px;padding:7px 12px;border-radius:999px;border:1px solid rgba(59,130,246,0.26);background:rgba(59,130,246,0.10);font-size:11px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#60a5fa;">Desktop Handoff</div>
      <h1 style="margin:0 0 12px 0;font-size:28px;line-height:1.05;font-weight:800;letter-spacing:-0.04em;">Returning to desktop…</h1>
      <p style="margin:0 0 26px 0;max-width:420px;font-size:16px;line-height:1.6;color:rgba(228,228,231,0.68);">Your Lark sign-in finished successfully. If the desktop app does not open on its own, use the handoff button below.</p>
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
        <a href="${safeTarget}" style="display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 18px;border-radius:14px;background:linear-gradient(180deg,#3b82f6 0%,#2563eb 100%);color:#eff6ff;text-decoration:none;font-size:13px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;box-shadow:0 10px 30px rgba(37,99,235,0.28);">Open Divo Desktop</a>
        <span style="font-size:12px;line-height:1.5;color:rgba(161,161,170,0.72);">If your browser blocks the custom protocol, approve the prompt and retry.</span>
      </div>
      <script>window.location.replace(${JSON.stringify(target.toString())});</script>
    </main>
  </body>
</html>`;
  }

  renderGoogleCallbackHtml(input: { success: boolean; message: string }): string {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Google Workspace Connected</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#05070b;color:#f4f4f5;min-height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden;">
    <div style="position:fixed;inset:0;background:
      radial-gradient(circle at 18% 22%, rgba(59,130,246,0.14), transparent 28%),
      radial-gradient(circle at 78% 26%, rgba(16,185,129,0.10), transparent 24%),
      linear-gradient(180deg, #07090d 0%, #05070b 100%);"></div>
    <div style="position:fixed;inset:0;opacity:0.14;background-image:radial-gradient(rgba(255,255,255,0.22) 0.75px, transparent 0.75px);background-size:24px 24px;"></div>
    <main style="position:relative;z-index:1;width:min(560px,calc(100vw - 40px));padding:32px 32px 28px;border:1px solid rgba(255,255,255,0.09);border-radius:28px;background:rgba(10,12,18,0.86);box-shadow:0 30px 120px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.05);backdrop-filter:blur(18px);">
      <div style="display:inline-flex;align-items:center;gap:10px;margin-bottom:18px;padding:7px 12px;border-radius:999px;border:1px solid ${input.success ? 'rgba(16,185,129,0.24)' : 'rgba(239,68,68,0.22)'};background:${input.success ? 'rgba(16,185,129,0.10)' : 'rgba(239,68,68,0.10)'};font-size:11px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:${input.success ? '#34d399' : '#f87171'};">${input.success ? 'Connection Complete' : 'Connection Failed'}</div>
      <h1 style="margin:0 0 12px 0;font-size:28px;line-height:1.05;font-weight:800;letter-spacing:-0.04em;">${input.success ? 'Google connected' : 'Google connection failed'}</h1>
      <p style="margin:0 0 16px 0;max-width:430px;font-size:16px;line-height:1.6;color:rgba(228,228,231,0.68);">${input.message}</p>
      <p style="margin:0;font-size:12px;line-height:1.6;color:rgba(161,161,170,0.72);">You can return to the desktop app and continue from the integrations screen.</p>
    </main>
  </body>
</html>`;
  }

  async unlinkLark(session: MemberSessionDTO): Promise<{ unlinked: true }> {
    await larkUserAuthLinkRepository.revokeByUser(session.userId, session.companyId);
    if (session.sessionId) {
      await memberAuthService.logout(session.sessionId);
    }
    return { unlinked: true };
  }

  async unlinkGoogle(session: MemberSessionDTO): Promise<{ unlinked: true }> {
    await googleUserAuthLinkRepository.revokeByUser(session.userId, session.companyId);
    return { unlinked: true };
  }

  /** Create a handoff code for a logged-in member to pass to the desktop app. */
  async createHandoff(userId: string, companyId: string, role: string): Promise<{ code: string; expiresAt: string }> {
    const code = memberAuthService.generateHandoffCode();
    const expiresAt = new Date(Date.now() + memberAuthService.handoffTTLMs);

    await this.repository.createHandoff({ code, userId, companyId, role, expiresAt });

    return { code, expiresAt: expiresAt.toISOString() };
  }

  /** Exchange a handoff code for a desktop session token. */
  async exchangeHandoff(code: string): Promise<MemberLoginResult> {
    const handoff = await this.repository.findHandoffByCode(code);

    if (!handoff) {
      throw new HttpException(404, 'Invalid handoff code');
    }

    if (handoff.consumedAt) {
      throw new HttpException(409, 'Handoff code already used');
    }

    if (handoff.expiresAt.getTime() <= Date.now()) {
      throw new HttpException(410, 'Handoff code has expired');
    }

    await this.repository.consumeHandoff(handoff.id);

    return memberAuthService.issueDesktopSession(handoff.userId, handoff.companyId, handoff.role, {
      authProvider: 'handoff',
    });
  }

  private verifyDesktopLarkState(state: string): DesktopLarkStatePayload {
    try {
      const decoded = jwt.verify(state, config.JWT_SECRET) as DesktopLarkStatePayload;
      if (decoded.kind !== 'desktop_lark_login' || !decoded.nonce) {
        throw new Error('invalid_state_kind');
      }
      return decoded;
    } catch {
      throw new HttpException(400, 'Invalid or expired desktop Lark login state.');
    }
  }

  private verifyDesktopGoogleState(state: string): DesktopGoogleStatePayload {
    try {
      const decoded = jwt.verify(state, config.JWT_SECRET) as DesktopGoogleStatePayload;
      if (decoded.kind !== 'desktop_google_connect') {
        throw new Error('Invalid Google OAuth state payload');
      }
      return decoded;
    } catch (error) {
      throw new HttpException(400, (error as Error).message || 'Invalid Google OAuth state');
    }
  }
}

export const desktopAuthService = new DesktopAuthService();
