import type { PrismaClient } from '../../generated/prisma';
import type { ResolvedManager } from './approval.types';

/**
 * Resolves the approval manager for a given department.
 *
 * Priority:
 *   1. The user in the dept with role slug 'MANAGER', with a Divo Lark connection.
 *   2. A company-level admin (ChannelIdentity.aiRole contains 'ADMIN') with a larkOpenId.
 *   3. null → caller must fail-closed.
 */
export class ApprovalResolverService {
  constructor(private readonly prisma: PrismaClient) {}

  async resolveManager(
    departmentId: string,
    companyId:    string,
  ): Promise<ResolvedManager | null> {
    // 1. Find MANAGER-role membership in dept
    const deptManager = await this.prisma.departmentMembership.findFirst({
      where: {
        departmentId,
        status: 'active',
        role: {
          departmentId,
          slug: { in: ['MANAGER', 'manager'] },
        },
      },
      orderBy: { updatedAt: 'desc' },
      select: { userId: true },
    });

    if (deptManager) {
      const connection = await this.prisma.integrationConnection.findFirst({
        where: {
          companyId,
          provider: 'lark',
          ownerUserId: deptManager.userId,
          status: 'connected',
          revokedAt: null,
        },
        select: { externalAccountId: true },
        orderBy: { updatedAt: 'desc' },
      });
      if (connection?.externalAccountId) {
        const user = await this.prisma.user.findUnique({
          where:  { id: deptManager.userId },
          select: { name: true },
        });
        return {
          userId:      deptManager.userId,
          larkOpenId:  connection.externalAccountId,
          displayName: user?.name ?? deptManager.userId,
        };
      }
    }

    // 2. Fallback: any user in the company with an admin aiRole and a Lark open_id
    const adminIdentity = await this.prisma.channelIdentity.findFirst({
      where: {
        companyId,
        channel:    'lark',
        aiRole:     { contains: 'ADMIN' },
        larkOpenId: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
      select: { larkOpenId: true, displayName: true },
    });

    if (adminIdentity?.larkOpenId) {
      const connection = await this.prisma.integrationConnection.findFirst({
        where: {
          companyId,
          provider: 'lark',
          externalAccountId: adminIdentity.larkOpenId,
          ownerUserId: { not: null },
          status: 'connected',
          revokedAt: null,
        },
        select: { ownerUserId: true },
      });
      if (connection?.ownerUserId) {
        return {
          userId:      connection.ownerUserId,
          larkOpenId:  adminIdentity.larkOpenId,
          displayName: adminIdentity.displayName ?? connection.ownerUserId,
        };
      }
    }

    return null;
  }

  /** Resolve the human owner of one governed connection to their Lark identity. */
  async resolveConnectionOwner(connectionId: string, companyId: string): Promise<ResolvedManager | null> {
    const connection = await this.prisma.integrationConnection.findFirst({
      where: { id: connectionId, companyId, status: 'connected', revokedAt: null, ownerUserId: { not: null } },
      select: { ownerUserId: true, ownerUser: { select: { name: true } } },
    });
    if (!connection?.ownerUserId) return null;
    const larkConnection = await this.prisma.integrationConnection.findFirst({
      where: {
        companyId,
        provider: 'lark',
        ownerUserId: connection.ownerUserId,
        status: 'connected',
        revokedAt: null,
        externalAccountId: { not: null },
      },
      select: { externalAccountId: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!larkConnection?.externalAccountId) return null;
    return {
      userId: connection.ownerUserId,
      larkOpenId: larkConnection.externalAccountId,
      displayName: connection.ownerUser?.name ?? connection.ownerUserId,
    };
  }

  /** Resolve one active company admin with a Divo-managed Lark identity. */
  async resolveCompanyAdmin(companyId: string): Promise<ResolvedManager | null> {
    const admins = await this.prisma.adminMembership.findMany({
      where: { companyId, isActive: true, role: { in: ['COMPANY_ADMIN', 'SUPER_ADMIN'] } },
      select: { userId: true, user: { select: { name: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    for (const admin of admins) {
      const larkConnection = await this.prisma.integrationConnection.findFirst({
        where: {
          companyId,
          provider: 'lark',
          ownerUserId: admin.userId,
          status: 'connected',
          revokedAt: null,
          externalAccountId: { not: null },
        },
        select: { externalAccountId: true },
        orderBy: { updatedAt: 'desc' },
      });
      if (larkConnection?.externalAccountId) {
        return {
          userId: admin.userId,
          larkOpenId: larkConnection.externalAccountId,
          displayName: admin.user?.name ?? admin.userId,
        };
      }
    }
    return null;
  }
}
