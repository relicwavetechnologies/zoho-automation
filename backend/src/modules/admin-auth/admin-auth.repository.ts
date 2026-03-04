import type { AdminMembership, AdminSession, User } from '../../generated/prisma';

import { BaseRepository } from '../../core/repository';
import { prisma } from '../../utils/prisma';

export class AdminAuthRepository extends BaseRepository {
  countActiveSuperAdmins(): Promise<number> {
    return prisma.adminMembership.count({
      where: {
        role: 'SUPER_ADMIN',
        isActive: true,
      },
    });
  }

  findUserByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({
      where: { email },
    });
  }

  findUserById(userId: string): Promise<User | null> {
    return prisma.user.findUnique({
      where: { id: userId },
    });
  }

  findCompanyById(companyId: string) {
    return prisma.company.findUnique({
      where: { id: companyId },
    });
  }

  createCompany(name: string) {
    return prisma.company.create({
      data: { name },
    });
  }

  createCompanyAdminSignup(data: {
    email: string;
    password: string;
    name?: string;
    companyName: string;
  }): Promise<{
    user: User;
    company: { id: string; name: string };
  }> {
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: data.email,
          password: data.password,
          name: data.name,
        },
      });

      const company = await tx.company.create({
        data: { name: data.companyName },
        select: { id: true, name: true },
      });

      await tx.adminMembership.create({
        data: {
          userId: user.id,
          companyId: company.id,
          role: 'COMPANY_ADMIN',
          isActive: true,
        },
      });

      return { user, company };
    });
  }

  findInviteByToken(inviteToken: string) {
    return prisma.companyInvite.findUnique({
      where: { token: inviteToken },
    });
  }

  createUser(data: { email: string; password: string; name?: string }): Promise<User> {
    return prisma.user.create({ data });
  }

  updateUserPasswordAndName(userId: string, data: { password: string; name?: string }): Promise<User> {
    return prisma.user.update({
      where: { id: userId },
      data: {
        password: data.password,
        ...(data.name ? { name: data.name } : {}),
      },
    });
  }

  createAdminMembership(data: {
    userId: string;
    role: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
    companyId?: string;
  }): Promise<AdminMembership> {
    return prisma.adminMembership.create({
      data: {
        userId: data.userId,
        role: data.role,
        companyId: data.companyId,
      },
    });
  }

  upsertMembership(userId: string, companyId: string, role: string): Promise<AdminMembership> {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.adminMembership.findFirst({
        where: { userId, companyId, role },
        orderBy: { createdAt: 'desc' },
      });

      if (existing) {
        return tx.adminMembership.update({
          where: { id: existing.id },
          data: { isActive: true },
        });
      }

      return tx.adminMembership.create({
        data: {
          userId,
          companyId,
          role,
          isActive: true,
        },
      });
    });
  }

  upsertCompanyAdminMembership(userId: string, companyId: string): Promise<AdminMembership> {
    return this.upsertMembership(userId, companyId, 'COMPANY_ADMIN');
  }

  findActiveMembership(input: {
    userId: string;
    role: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
    companyId?: string;
  }): Promise<AdminMembership | null> {
    return prisma.adminMembership.findFirst({
      where: {
        userId: input.userId,
        role: input.role,
        companyId: input.companyId,
        isActive: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  createAdminSession(data: {
    userId: string;
    role: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
    companyId?: string;
    expiresAt: Date;
  }): Promise<AdminSession> {
    return prisma.adminSession.create({
      data: {
        userId: data.userId,
        role: data.role,
        companyId: data.companyId,
        expiresAt: data.expiresAt,
      },
    });
  }

  findActiveSessionBySessionId(sessionId: string): Promise<AdminSession | null> {
    return prisma.adminSession.findUnique({
      where: {
        sessionId,
      },
    });
  }

  revokeSession(sessionId: string): Promise<AdminSession> {
    return prisma.adminSession.update({
      where: {
        sessionId,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }

  acceptInvite(inviteId: string) {
    return prisma.companyInvite.update({
      where: { id: inviteId },
      data: {
        status: 'accepted',
        acceptedAt: new Date(),
      },
    });
  }
}

export const adminAuthRepository = new AdminAuthRepository();
