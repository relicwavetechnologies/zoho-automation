import type { MemberSession, User, AdminMembership } from '../../generated/prisma';
import { BaseRepository } from '../../core/repository';
import { prisma } from '../../utils/prisma';

export class MemberAuthRepository extends BaseRepository {
  findUserByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } });
  }

  findUserByEmailInsensitive(email: string): Promise<User | null> {
    return prisma.user.findFirst({
      where: {
        email: {
          equals: email,
          mode: 'insensitive',
        },
      },
    });
  }

  findUserById(userId: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id: userId } });
  }

  findActiveMembership(userId: string, companyId?: string): Promise<AdminMembership | null> {
    return prisma.adminMembership.findFirst({
      where: {
        userId,
        isActive: true,
        ...(companyId ? { companyId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  createMemberSession(data: {
    userId: string;
    companyId: string;
    role: string;
    channel: string;
    authProvider?: string;
    larkTenantKey?: string;
    larkOpenId?: string;
    larkUserId?: string;
    expiresAt: Date;
  }): Promise<MemberSession> {
    return prisma.memberSession.create({ data });
  }

  findActiveSessionBySessionId(sessionId: string): Promise<MemberSession | null> {
    return prisma.memberSession.findUnique({ where: { sessionId } });
  }

  revokeSession(sessionId: string): Promise<MemberSession> {
    return prisma.memberSession.update({
      where: { sessionId },
      data: { revokedAt: new Date() },
    });
  }
}

export const memberAuthRepository = new MemberAuthRepository();
