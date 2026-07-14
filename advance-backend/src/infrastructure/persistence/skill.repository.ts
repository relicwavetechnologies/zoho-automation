import type { PrismaClient } from '../../generated/prisma';
import { wrapInfra, type InfraError } from '../../shared/errors';
import type { Result } from '../../shared/result';
import { ok, err } from '../../shared/result';

export interface SkillRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly markdown: string;
  readonly toolIds: string[];
  readonly scope: string;
  readonly status: string;
  readonly tags: string[];
  readonly companyId: string;
  readonly departmentId: string | null;
  readonly revision: number;
}

export interface SkillRepoPort {
  list(input: {
    companyId: string;
    departmentId?: string;
    limit: number;
  }): Promise<Result<SkillRow[], InfraError>>;

  search(input: {
    companyId: string;
    departmentId?: string;
    query: string;
    limit: number;
  }): Promise<Result<SkillRow[], InfraError>>;

  findById(input: {
    companyId: string;
    departmentId?: string;
    skillId: string;
  }): Promise<Result<SkillRow | null, InfraError>>;

  registryRevision(companyId: string): Promise<Result<number, InfraError>>;
}

const SELECT = {
  id:           true,
  slug:         true,
  name:         true,
  summary:      true,
  markdown:     true,
  toolIds:      true,
  scope:        true,
  status:       true,
  tags:         true,
  companyId:    true,
  departmentId: true,
  revision:     true,
} as const;

function visibilityWhere(departmentId?: string) {
  const companyWideScopes = ['company', 'global'];
  return departmentId
    ? { OR: [{ scope: { in: companyWideScopes }, departmentId: null as string | null }, { scope: 'department', departmentId }] }
    : { scope: { in: companyWideScopes }, departmentId: null as string | null };
}

export class SkillRepository implements SkillRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async list(input: {
    companyId: string;
    departmentId?: string;
    limit: number;
  }): Promise<Result<SkillRow[], InfraError>> {
    try {
      const { companyId, departmentId, limit } = input;
      const rows = await this.db.skill.findMany({
        where: {
          companyId,
          status: 'active',
          AND: [visibilityWhere(departmentId)],
        },
        select:  SELECT,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        take:    limit,
      });

      return ok(rows);
    } catch (e) {
      return err(wrapInfra('prisma', 'skill.list', e));
    }
  }

  async search(input: {
    companyId: string;
    departmentId?: string;
    query: string;
    limit: number;
  }): Promise<Result<SkillRow[], InfraError>> {
    try {
      const { companyId, departmentId, query, limit } = input;

      const rows = await this.db.skill.findMany({
        where: {
          companyId,
          status: 'active',
          AND: [
            visibilityWhere(departmentId),
            {
              OR: [
                { name:     { contains: query, mode: 'insensitive' } },
                { slug:     { contains: query, mode: 'insensitive' } },
                { summary:  { contains: query, mode: 'insensitive' } },
                { markdown: { contains: query, mode: 'insensitive' } },
              ],
            },
          ],
        },
        select:  SELECT,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        take:    limit,
      });

      return ok(rows);
    } catch (e) {
      return err(wrapInfra('prisma', 'skill.search', e));
    }
  }

  async findById(input: {
    companyId: string;
    departmentId?: string;
    skillId: string;
  }): Promise<Result<SkillRow | null, InfraError>> {
    try {
      const { companyId, departmentId, skillId } = input;

      const row = await this.db.skill.findFirst({
        where: {
          companyId,
          status: 'active',
          AND: [
            visibilityWhere(departmentId),
            { OR: [{ id: skillId }, { slug: skillId }] },
          ],
        },
        select: SELECT,
      });

      return ok(row ?? null);
    } catch (e) {
      return err(wrapInfra('prisma', 'skill.findById', e));
    }
  }

  async registryRevision(companyId: string): Promise<Result<number, InfraError>> {
    try {
      const row = await this.db.skillRegistryRevision.findUnique({
        where: { companyId },
        select: { revision: true },
      });
      return ok(row?.revision ?? 1);
    } catch (e) {
      return err(wrapInfra('prisma', 'skill.registry_revision', e));
    }
  }
}
