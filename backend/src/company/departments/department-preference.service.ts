import { prisma } from '../../utils/prisma';
import { cacheRedisConnection } from '../queue/runtime/redis.connection';
import type { UserDepartmentSummary } from './department.service';

const PREFERENCE_TTL_SECONDS = 7 * 24 * 60 * 60;

const cacheKeyFor = (companyId: string, userId: string): string =>
  `user-dept:${companyId}:${userId}`;

export type ResolvedDepartmentPreference =
  | { departmentId: string; reason: 'persisted' | 'auto_selected' }
  | { departmentId: null; reason: 'needs_selection' | 'no_memberships' };

class DepartmentPreferenceService {
  private getClient() {
    return cacheRedisConnection.getClient();
  }

  async getActiveDepartmentId(companyId: string, userId: string): Promise<string | null> {
    const cacheKey = cacheKeyFor(companyId, userId);
    const cached = await this.getClient().get(cacheKey);
    if (cached && cached.trim()) {
      return cached.trim();
    }

    const row = await prisma.userDepartmentPreference.findUnique({
      where: { companyId_userId: { companyId, userId } },
      select: { activeDepartmentId: true },
    });
    const departmentId = row?.activeDepartmentId?.trim() || null;
    if (departmentId) {
      await this.getClient().set(cacheKey, departmentId, 'EX', PREFERENCE_TTL_SECONDS);
    }
    return departmentId;
  }

  async setActiveDepartmentId(
    companyId: string,
    userId: string,
    departmentId: string,
  ): Promise<void> {
    const normalizedDepartmentId = departmentId.trim();
    const cacheKey = cacheKeyFor(companyId, userId);
    await this.getClient().set(cacheKey, normalizedDepartmentId, 'EX', PREFERENCE_TTL_SECONDS);
    await prisma.userDepartmentPreference.upsert({
      where: { companyId_userId: { companyId, userId } },
      update: { activeDepartmentId: normalizedDepartmentId },
      create: {
        companyId,
        userId,
        activeDepartmentId: normalizedDepartmentId,
      },
    });
  }

  async clearActiveDepartmentId(companyId: string, userId: string): Promise<void> {
    const cacheKey = cacheKeyFor(companyId, userId);
    await this.getClient().del(cacheKey);
    await prisma.userDepartmentPreference.upsert({
      where: { companyId_userId: { companyId, userId } },
      update: { activeDepartmentId: null },
      create: {
        companyId,
        userId,
        activeDepartmentId: null,
      },
    });
  }

  async resolveForRuntime(
    companyId: string,
    userId: string,
    memberships: UserDepartmentSummary[],
  ): Promise<ResolvedDepartmentPreference> {
    const persistedDepartmentId = await this.getActiveDepartmentId(companyId, userId);
    if (persistedDepartmentId) {
      const persistedMembership = memberships.find((membership) => membership.id === persistedDepartmentId);
      if (persistedMembership) {
        return {
          departmentId: persistedMembership.id,
          reason: 'persisted',
        };
      }
      await this.clearActiveDepartmentId(companyId, userId);
    }

    if (memberships.length === 0) {
      return { departmentId: null, reason: 'no_memberships' };
    }

    if (memberships.length === 1) {
      await this.setActiveDepartmentId(companyId, userId, memberships[0]!.id);
      return {
        departmentId: memberships[0]!.id,
        reason: 'auto_selected',
      };
    }

    return { departmentId: null, reason: 'needs_selection' };
  }
}

export const departmentPreferenceService = new DepartmentPreferenceService();
