import jwt from 'jsonwebtoken';
import crypto from 'crypto';

import config from '../../config';
import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import { comparePassword } from '../../utils/bcrypt';
import { MemberAuthRepository, memberAuthRepository } from './member-auth.repository';
import { channelIdentityRepository } from '../../company/channels/channel-identity.repository';

const MEMBER_SESSION_TTL_MINUTES = config.ADMIN_SESSION_TTL_MINUTES; // reuse same TTL
const HANDOFF_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface MemberSessionDTO {
  userId: string;
  companyId: string;
  role: string;
  aiRole?: string;
  sessionId: string;
  expiresAt: string;
  authProvider: 'password' | 'handoff' | 'lark';
  name?: string;
  email: string;
  larkTenantKey?: string;
  larkOpenId?: string;
  larkUserId?: string;
}

export interface MemberLoginResult {
  token: string;
  session: MemberSessionDTO;
}

export class MemberAuthService extends BaseService {
  constructor(private readonly repository: MemberAuthRepository = memberAuthRepository) {
    super();
  }

  /** Login a member with email + password, returning a session. */
  async loginMember(email: string, password: string, companyId?: string): Promise<MemberLoginResult> {
    const user = await this.repository.findUserByEmail(email);
    if (!user) throw new HttpException(401, 'Invalid credentials');

    const valid = await comparePassword(password, user.password);
    if (!valid) throw new HttpException(401, 'Invalid credentials');

    // Find any active membership for this user
    const membership = await this.repository.findActiveMembership(user.id, companyId);
    if (!membership) throw new HttpException(403, 'No active workspace membership found');
    if (!membership.companyId) throw new HttpException(403, 'Membership missing company scope');

    return this.issueSession(user.id, membership.companyId, membership.role, 'web', user.name ?? undefined, user.email);
  }

  /** Issue a desktop-channel session (called after handoff exchange). */
  async issueDesktopSession(
    userId: string,
    companyId: string,
    role: string,
    options?: {
      authProvider?: 'password' | 'handoff' | 'lark';
      larkTenantKey?: string;
      larkOpenId?: string;
      larkUserId?: string;
    },
  ): Promise<MemberLoginResult> {
    const user = await this.repository.findUserById(userId);
    if (!user) throw new HttpException(404, 'User not found');
    return this.issueSession(
      userId,
      companyId,
      role,
      'desktop',
      user.name ?? undefined,
      user.email,
      options,
    );
  }

  /** Resolve a member session from a sessionId. */
  async resolveMemberSession(sessionId: string): Promise<MemberSessionDTO | null> {
    const session = await this.repository.findActiveSessionBySessionId(sessionId);
    if (!session || session.revokedAt) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;

    const user = await this.repository.findUserById(session.userId);
    const membership = await this.repository.findActiveMembership(session.userId, session.companyId);
    const effectiveRole = membership?.role ?? session.role;
    const linkedIdentity = await channelIdentityRepository.findLarkIdentityForProvisioning({
      companyId: session.companyId,
      larkOpenId: session.larkOpenId ?? undefined,
      larkUserId: session.larkUserId ?? undefined,
      email: user?.email ?? undefined,
    });
    const effectiveAiRole =
      typeof linkedIdentity?.aiRole === 'string' && linkedIdentity.aiRole.trim().length > 0
        ? linkedIdentity.aiRole.trim()
        : effectiveRole;
    return {
      userId: session.userId,
      companyId: session.companyId,
      role: effectiveRole,
      aiRole: effectiveAiRole,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt.toISOString(),
      authProvider: (session.authProvider as 'password' | 'handoff' | 'lark') ?? 'password',
      name: user?.name ?? undefined,
      email: user?.email ?? '',
      larkTenantKey: session.larkTenantKey ?? undefined,
      larkOpenId: session.larkOpenId ?? undefined,
      larkUserId: session.larkUserId ?? undefined,
    };
  }

  /** Revoke a member session. */
  async logout(sessionId: string): Promise<void> {
    await this.repository.revokeSession(sessionId);
  }

  /** Generate a short-lived handoff code for desktop auth. */
  generateHandoffCode(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  get handoffTTLMs(): number {
    return HANDOFF_CODE_TTL_MS;
  }

  private async issueSession(
    userId: string,
    companyId: string,
    role: string,
    channel: string,
    name?: string,
    email?: string,
    options?: {
      authProvider?: 'password' | 'handoff' | 'lark';
      larkTenantKey?: string;
      larkOpenId?: string;
      larkUserId?: string;
    },
  ): Promise<MemberLoginResult> {
    const expiresAt = new Date(Date.now() + MEMBER_SESSION_TTL_MINUTES * 60 * 1000);
    const session = await this.repository.createMemberSession({
      userId,
      companyId,
      role,
      channel,
      authProvider: options?.authProvider,
      larkTenantKey: options?.larkTenantKey,
      larkOpenId: options?.larkOpenId,
      larkUserId: options?.larkUserId,
      expiresAt,
    });

    const sessionDto: MemberSessionDTO = {
      userId: session.userId,
      companyId: session.companyId,
      role: session.role,
      aiRole: session.role,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt.toISOString(),
      authProvider: (session.authProvider as 'password' | 'handoff' | 'lark') ?? 'password',
      name,
      email: email ?? '',
      larkTenantKey: session.larkTenantKey ?? undefined,
      larkOpenId: session.larkOpenId ?? undefined,
      larkUserId: session.larkUserId ?? undefined,
    };

    const token = jwt.sign(
      {
        userId: session.userId,
        sessionId: session.sessionId,
        role: session.role,
        companyId: session.companyId,
        channel,
      },
      config.JWT_SECRET,
      { expiresIn: `${MEMBER_SESSION_TTL_MINUTES}m` },
    );

    return { token, session: sessionDto };
  }
}

export const memberAuthService = new MemberAuthService();
