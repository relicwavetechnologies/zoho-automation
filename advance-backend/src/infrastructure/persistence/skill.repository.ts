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
  readonly scope: string;
  readonly status: string;
  readonly tags: string[];
  readonly companyId: string;
  readonly departmentId: string | null;
}

export interface SkillRepoPort {
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
}

const SELECT = {
  id:           true,
  slug:         true,
  name:         true,
  summary:      true,
  markdown:     true,
  scope:        true,
  status:       true,
  tags:         true,
  companyId:    true,
  departmentId: true,
} as const;

export class SkillRepository implements SkillRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async search(input: {
    companyId: string;
    departmentId?: string;
    query: string;
    limit: number;
  }): Promise<Result<SkillRow[], InfraError>> {
    try {
      const { companyId, departmentId, query, limit } = input;

      // Scope: company-wide skills (no dept) OR skills belonging to this department
      const deptFilter = departmentId
        ? { OR: [{ departmentId: null as string | null }, { departmentId }] }
        : { departmentId: null as string | null };

      const rows = await this.db.skill.findMany({
        where: {
          companyId,
          status: 'active',
          ...deptFilter,
          OR: [
            { name:     { contains: query, mode: 'insensitive' } },
            { slug:     { contains: query, mode: 'insensitive' } },
            { summary:  { contains: query, mode: 'insensitive' } },
            { markdown: { contains: query, mode: 'insensitive' } },
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

      const deptFilter = departmentId
        ? { OR: [{ departmentId: null as string | null }, { departmentId }] }
        : { departmentId: null as string | null };

      const row = await this.db.skill.findFirst({
        where: {
          companyId,
          status: 'active',
          ...deptFilter,
          OR: [{ id: skillId }, { slug: skillId }],
        },
        select: SELECT,
      });

      return ok(row ?? null);
    } catch (e) {
      return err(wrapInfra('prisma', 'skill.findById', e));
    }
  }
}
