import { HttpException } from '../../core/http-exception';
import { BaseService } from '../../core/service';
import { memberAuthService, MemberLoginResult } from '../member-auth/member-auth.service';
import { DesktopAuthRepository, desktopAuthRepository } from './desktop-auth.repository';

export class DesktopAuthService extends BaseService {
  constructor(private readonly repository: DesktopAuthRepository = desktopAuthRepository) {
    super();
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

    // Mark as consumed
    await this.repository.consumeHandoff(handoff.id);

    // Issue a desktop session
    return memberAuthService.issueDesktopSession(handoff.userId, handoff.companyId, handoff.role);
  }
}

export const desktopAuthService = new DesktopAuthService();
