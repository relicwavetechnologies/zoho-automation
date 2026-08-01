import type { PrismaClient } from '../../generated/prisma';
import type { ResolvedManager } from './approval.types';

/**
 * Resolves the human who has to say yes.
 *
 * A Lark account used to be part of the definition of an approver: every lookup
 * here ended with "…and a connected Lark connection with an externalAccountId",
 * and returned null otherwise. That made Lark the authority rather than a way to
 * reach one — a department whose manager works in the desktop app had no
 * approver at all, so the gate answered `misconfigured` and every gated action
 * failed outright.
 *
 * Authority now comes from the org chart. `larkOpenId` is a delivery address:
 * present when the person can be reached by card, null when they cannot, and
 * never a reason to say there is nobody to ask.
 */
export class ApprovalResolverService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Resolve an authenticated internal user ID to a human-facing card label. */
  async resolveUserDisplayName(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    const name = user?.name?.trim();
    if (name) return name;
    const email = user?.email?.trim();
    return email || null;
  }

  /**
   * Priority:
   *   1. The active MANAGER of the department.
   *   2. An active company admin.
   *   3. A Lark admin identity, for companies whose admins exist only as a
   *      channel identity.
   *   4. null → there is genuinely nobody, and the caller must fail closed.
   */
  async resolveManager(
    departmentId: string,
    companyId:    string,
    options: {
      readonly excludeUserId?: string;
      /** Shared knowledge uses the department's actual manager, never an implicit admin substitution. */
      readonly allowCompanyAdminFallback?: boolean;
    } = {},
  ): Promise<ResolvedManager | null> {
    const deptManager = await this.prisma.departmentMembership.findFirst({
      where: {
        departmentId,
        status: 'active',
        ...(options.excludeUserId ? { userId: { not: options.excludeUserId } } : {}),
        role: {
          departmentId,
          slug: { in: ['MANAGER', 'manager'] },
        },
      },
      orderBy: { updatedAt: 'desc' },
      select: { userId: true, user: { select: { name: true, email: true } } },
    });

    if (deptManager) {
      return {
        userId:      deptManager.userId,
        larkOpenId:  await this.larkAddressFor(companyId, deptManager.userId),
        displayName: deptManager.user?.name ?? deptManager.user?.email ?? deptManager.userId,
      };
    }

    if (options.allowCompanyAdminFallback === false) return null;

    const admin = await this.resolveCompanyAdmin(companyId, options);
    if (admin) return admin;

    // Companies migrated from the Lark-only era can have an admin who exists as
    // a channel identity without an AdminMembership row.
    const adminIdentity = await this.prisma.channelIdentity.findFirst({
      where: {
        companyId,
        channel:    'lark',
        aiRole:     { contains: 'ADMIN' },
        larkOpenId: { not: null },
        ...(options.excludeUserId ? { userId: { not: options.excludeUserId } } : {}),
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

  /** Resolve the human owner of one governed connection. */
  async resolveConnectionOwner(connectionId: string, companyId: string): Promise<ResolvedManager | null> {
    const connection = await this.prisma.integrationConnection.findFirst({
      where: { id: connectionId, companyId, status: 'connected', revokedAt: null, ownerUserId: { not: null } },
      select: { ownerUserId: true, ownerUser: { select: { name: true, email: true } } },
    });
    if (!connection?.ownerUserId) return null;
    return {
      userId:      connection.ownerUserId,
      larkOpenId:  await this.larkAddressFor(companyId, connection.ownerUserId),
      displayName: connection.ownerUser?.name ?? connection.ownerUser?.email ?? connection.ownerUserId,
    };
  }

  /** Resolve one active company admin. */
  async resolveCompanyAdmin(
    companyId: string,
    options: { readonly excludeUserId?: string } = {},
  ): Promise<ResolvedManager | null> {
    const admins = await this.prisma.adminMembership.findMany({
      where: {
        companyId,
        isActive: true,
        role: { in: ['COMPANY_ADMIN', 'SUPER_ADMIN'] },
        ...(options.excludeUserId ? { userId: { not: options.excludeUserId } } : {}),
      },
      select: { userId: true, user: { select: { name: true, email: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    if (!admins.length) return null;

    // Prefer an admin Divo can actually reach by card, so a company that does
    // use Lark keeps the delivery it had before this became optional.
    for (const admin of admins) {
      const larkOpenId = await this.larkAddressFor(companyId, admin.userId);
      if (larkOpenId) {
        return {
          userId: admin.userId,
          larkOpenId,
          displayName: admin.user?.name ?? admin.user?.email ?? admin.userId,
        };
      }
    }

    const fallback = admins[0]!;
    return {
      userId:      fallback.userId,
      larkOpenId:  null,
      displayName: fallback.user?.name ?? fallback.user?.email ?? fallback.userId,
    };
  }

  /** The person's Lark card address, or null when there is no way to card them. */
  private async larkAddressFor(companyId: string, userId: string): Promise<string | null> {
    const connection = await this.prisma.integrationConnection.findFirst({
      where: {
        companyId,
        provider: 'lark',
        ownerUserId: userId,
        status: 'connected',
        revokedAt: null,
        externalAccountId: { not: null },
      },
      select: { externalAccountId: true },
      orderBy: { updatedAt: 'desc' },
    });
    return connection?.externalAccountId ?? null;
  }
}
