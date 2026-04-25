import type { PrismaClient } from '../../generated/prisma';
import type { ResolvedManager } from './approval.types';

/**
 * Resolves the approval manager for a given department.
 *
 * Priority:
 *   1. The user in the dept with role slug 'MANAGER', with a LarkUserAuthLink.
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
      const authLink = await this.prisma.larkUserAuthLink.findFirst({
        where: { userId: deptManager.userId },
        select: { larkOpenId: true },
      });
      if (authLink?.larkOpenId) {
        const user = await this.prisma.user.findUnique({
          where:  { id: deptManager.userId },
          select: { name: true },
        });
        return {
          userId:      deptManager.userId,
          larkOpenId:  authLink.larkOpenId,
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
      const authLink = await this.prisma.larkUserAuthLink.findFirst({
        where:  { larkOpenId: adminIdentity.larkOpenId },
        select: { userId: true },
      });
      if (authLink) {
        return {
          userId:      authLink.userId,
          larkOpenId:  adminIdentity.larkOpenId,
          displayName: adminIdentity.displayName ?? authLink.userId,
        };
      }
    }

    return null;
  }
}
