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
import { memberAuthRepository, MemberAuthRepository } from '../member-auth/member-auth.repository';
import { memberAuthService, MemberLoginResult, MemberSessionDTO } from '../member-auth/member-auth.service';
import { DesktopAuthRepository, desktopAuthRepository } from './desktop-auth.repository';

type DesktopLarkStatePayload = {
  kind: 'desktop_lark_login';
  nonce: string;
};

const DESKTOP_LARK_STATE_TTL_SECONDS = 10 * 60;
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

  async exchangeLarkAuthorizationCode(input: { code: string; state: string }): Promise<MemberLoginResult> {
    this.verifyDesktopLarkState(input.state);

    const tokenBundle = await larkOAuthService.exchangeAuthorizationCode(input.code);
    const userInfo = await larkOAuthService.fetchUserInfo(tokenBundle.accessToken);
    const email = normalizeEmail(userInfo.email);
    if (!email) {
      throw new HttpException(403, 'Your Lark account does not have an email address. Ask your admin to sync directory email first.');
    }

    const companyId = await larkTenantBindingRepository.resolveCompanyId(userInfo.tenantKey);
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
  </head>
  <body style="font-family: sans-serif; background: #0a0a0a; color: #e4e4e7; display: flex; min-height: 100vh; align-items: center; justify-content: center;">
    <div style="max-width: 520px; padding: 24px; border: 1px solid #27272a; border-radius: 12px; background: #111;">
      <h1 style="margin: 0 0 12px 0; font-size: 20px;">Returning to desktop…</h1>
      <p style="margin: 0 0 16px 0; color: #a1a1aa;">If the app does not open automatically, use the button below.</p>
      <a href="${safeTarget}" style="display: inline-block; padding: 10px 16px; border-radius: 8px; background: #f4f4f5; color: #09090b; text-decoration: none; font-weight: 600;">Open Cursorr Desktop</a>
      <script>window.location.replace(${JSON.stringify(target.toString())});</script>
    </div>
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
}

export const desktopAuthService = new DesktopAuthService();
