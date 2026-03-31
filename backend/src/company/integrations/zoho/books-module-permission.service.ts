import { cacheRedisConnection } from '../../queue/runtime/redis.connection';
import { prisma } from '../../../utils/prisma';
import type { DepartmentZohoReadScope } from '../../departments/department.service';
import type { ZohoBooksModule } from './zoho-books.client';
import {
  BooksModulePermissionRepository,
  booksModulePermissionRepository,
} from './books-module-permission.repository';

const BOOKS_MODULE_PERMISSION_TTL_SECONDS = 60 * 5;
const ALL_BOOKS_MODULES: ZohoBooksModule[] = [
  'contacts',
  'estimates',
  'invoices',
  'creditnotes',
  'salesorders',
  'customerpayments',
  'bills',
  'purchaseorders',
  'vendorpayments',
  'bankaccounts',
  'banktransactions',
];

const cacheKeyFor = (companyId: string, departmentRoleId: string): string =>
  `books-module:${companyId}:${departmentRoleId}`;

type CachedRow = {
  module: string;
  enabled: boolean;
  scopeOverride: string | null;
};

const normalizeScope = (
  value: string | null | undefined,
  fallback: DepartmentZohoReadScope,
): DepartmentZohoReadScope =>
  value === 'show_all' ? 'show_all' : value === 'personalized' ? 'personalized' : fallback;

export class BooksModulePermissionService {
  constructor(
    private readonly repo: BooksModulePermissionRepository = booksModulePermissionRepository,
  ) {}

  private async loadRows(companyId: string, departmentRoleId: string): Promise<CachedRow[]> {
    const redis = cacheRedisConnection.getClient();
    const cacheKey = cacheKeyFor(companyId, departmentRoleId);
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.filter((entry): entry is CachedRow => {
            return typeof entry === 'object' && entry !== null;
          });
        }
      } catch {
        // ignore corrupt cache
      }
    }
    const rows = await this.repo.getForRole(companyId, departmentRoleId);
    const normalized = rows.map((row) => ({
      module: row.module,
      enabled: row.enabled,
      scopeOverride: row.scopeOverride,
    }));
    await redis.set(cacheKey, JSON.stringify(normalized), 'EX', BOOKS_MODULE_PERMISSION_TTL_SECONDS);
    return normalized;
  }

  async resolveModuleAccess(
    companyId: string,
    departmentRoleId: string | undefined,
    module: ZohoBooksModule,
    roleDefaultScope: DepartmentZohoReadScope | undefined,
  ): Promise<{ enabled: boolean; scopeMode: 'personalized' | 'show_all' }> {
    const effectiveDefaultScope = roleDefaultScope ?? 'personalized';
    if (!departmentRoleId) {
      return {
        enabled: true,
        scopeMode: effectiveDefaultScope,
      };
    }
    const rows = await this.loadRows(companyId, departmentRoleId);
    const row = rows.find((entry) => entry.module === module);
    if (!row) {
      return {
        enabled: true,
        scopeMode: effectiveDefaultScope,
      };
    }
    return {
      enabled: row.enabled,
      scopeMode: normalizeScope(row.scopeOverride, effectiveDefaultScope),
    };
  }

  async getMatrix(companyId: string) {
    const [roles, rows] = await Promise.all([
      prisma.departmentRole.findMany({
        where: {
          department: {
            companyId,
          },
        },
        include: {
          department: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: [{ department: { name: 'asc' } }, { name: 'asc' }],
      }),
      this.repo.getForCompany(companyId),
    ]);
    const rowMap = new Map(
      rows.map((row) => [`${row.departmentRoleId}:${row.module}`, row] as const),
    );

    return roles.map((role) => ({
      departmentRoleId: role.id,
      departmentId: role.departmentId,
      departmentName: role.department.name,
      roleName: role.name,
      roleSlug: role.slug,
      roleDefaultScope: normalizeScope(role.zohoReadScope, 'personalized'),
      modules: Object.fromEntries(
        ALL_BOOKS_MODULES.map((module) => {
          const row = rowMap.get(`${role.id}:${module}`);
          const effectiveScope = normalizeScope(row?.scopeOverride ?? null, normalizeScope(role.zohoReadScope, 'personalized'));
          return [
            module,
            {
              enabled: row?.enabled ?? true,
              scopeOverride: row?.scopeOverride ?? null,
              effectiveScope,
            },
          ];
        }),
      ),
    }));
  }

  async updateModulePermission(
    companyId: string,
    departmentRoleId: string,
    module: ZohoBooksModule,
    enabled: boolean,
    scopeOverride: 'personalized' | 'show_all' | null | undefined,
    actorId?: string,
  ) {
    const result = await this.repo.upsert(
      companyId,
      departmentRoleId,
      module,
      enabled,
      scopeOverride,
      actorId,
    );
    await this.invalidateRole(companyId, departmentRoleId);
    return result;
  }

  async invalidateRole(companyId: string, departmentRoleId: string): Promise<void> {
    await cacheRedisConnection.getClient().del(cacheKeyFor(companyId, departmentRoleId));
  }
}

export const booksModulePermissionService = new BooksModulePermissionService();
