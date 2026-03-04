import { BaseRepository } from '../../core/repository';
import { prisma } from '../../utils/prisma';

export class CompanyAdminRepository extends BaseRepository {
  listMembers(companyId: string) {
    return prisma.adminMembership.findMany({
      where: {
        companyId,
        isActive: true,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  createInvite(input: {
    companyId: string;
    email: string;
    role: string;
    token: string;
    invitedBy: string;
    expiresAt: Date;
  }) {
    return prisma.companyInvite.create({
      data: {
        companyId: input.companyId,
        email: input.email,
        role: input.role,
        token: input.token,
        invitedBy: input.invitedBy,
        expiresAt: input.expiresAt,
        status: 'pending',
      },
    });
  }

  listInvites(companyId: string) {
    return prisma.companyInvite.findMany({
      where: {
        companyId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  findInvite(inviteId: string) {
    return prisma.companyInvite.findUnique({
      where: {
        id: inviteId,
      },
    });
  }

  cancelInvite(inviteId: string) {
    return prisma.companyInvite.update({
      where: {
        id: inviteId,
      },
      data: {
        status: 'cancelled',
      },
    });
  }

  findCompany(companyId: string) {
    return prisma.company.findUnique({ where: { id: companyId } });
  }
}

export const companyAdminRepository = new CompanyAdminRepository();
