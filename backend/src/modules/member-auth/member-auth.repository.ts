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

  createUser(data: { email: string; password: string; name?: string }): Promise<User> {
    return prisma.user.create({
      data: {
        email: data.email,
        password: data.password,
        ...(data.name ? { name: data.name } : {}),
      },
    });
  }

  async ensureActiveMembership(userId: string, companyId: string, role: string): Promise<AdminMembership> {
    const activeMembership = await this.findActiveMembership(userId, companyId);
    if (activeMembership) {
      return activeMembership;
    }

    const latestMembership = await prisma.adminMembership.findFirst({
      where: { userId, companyId },
      orderBy: { createdAt: 'desc' },
    });

    if (latestMembership) {
      return prisma.adminMembership.update({
        where: { id: latestMembership.id },
        data: {
          isActive: true,
          role: latestMembership.role || role,
        },
      });
    }

    return prisma.adminMembership.create({
      data: {
        userId,
        companyId,
        role,
        isActive: true,
      },
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

  async getTokenUsageForMonth(userId: string, companyId: string, monthStart: Date, monthEnd: Date): Promise<number> {
    const result = await prisma.aiTokenUsage.aggregate({
      where: {
        userId,
        companyId,
        createdAt: {
          gte: monthStart,
          lt: monthEnd,
        },
      },
      _sum: {
        actualInputTokens: true,
        actualOutputTokens: true,
      },
    });
    
    return (result._sum.actualInputTokens || 0) + (result._sum.actualOutputTokens || 0);
  }

  async getMemberTokenPolicy(userId: string, companyId: string) {
    return prisma.memberTokenPolicy.findUnique({
      where: { userId },
    });
  }
}

export const memberAuthRepository = new MemberAuthRepository();
