import { BaseRepository } from '../../core/repository';
import { prisma } from '../../utils/prisma';

export class RbacRepository extends BaseRepository {
  findPermission(role: string, action: string) {
    return prisma.rbacPermission.findUnique({
      where: {
        role_action: { role, action },
      },
    });
  }

  upsertPermission(input: { role: string; action: string; allowed: boolean; updatedBy: string }) {
    return prisma.rbacPermission.upsert({
      where: {
        role_action: {
          role: input.role,
          action: input.action,
        },
      },
      create: {
        role: input.role,
        action: input.action,
        allowed: input.allowed,
        updatedBy: input.updatedBy,
      },
      update: {
        allowed: input.allowed,
        updatedBy: input.updatedBy,
      },
    });
  }

  listPermissions() {
    return prisma.rbacPermission.findMany();
  }

  listAssignments(companyId?: string) {
    return prisma.adminMembership.findMany({
      where: {
        isActive: true,
        ...(companyId ? { companyId } : {}),
      },
      include: {
        user: {
          select: {
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

  findCompany(companyId: string) {
    return prisma.company.findUnique({ where: { id: companyId } });
  }

  findUser(userId: string) {
    return prisma.user.findUnique({ where: { id: userId } });
  }

  createAssignment(input: { userId: string; companyId: string; role: string }) {
    return prisma.adminMembership.create({
      data: {
        userId: input.userId,
        companyId: input.companyId,
        role: input.role,
        isActive: true,
      },
    });
  }

  findAssignmentById(assignmentId: string) {
    return prisma.adminMembership.findUnique({
      where: { id: assignmentId },
    });
  }

  revokeAssignment(assignmentId: string) {
    return prisma.adminMembership.update({
      where: { id: assignmentId },
      data: {
        isActive: false,
      },
    });
  }
}

export const rbacRepository = new RbacRepository();
