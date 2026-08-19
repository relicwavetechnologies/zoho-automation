import type { Prisma, PrismaClient } from '../../generated/prisma';
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
  readonly aliases?: string[];
  readonly companyId: string;
  readonly departmentId: string | null;
  readonly revision: number;
  /** Present when the repository loaded the router graph with the catalogue row. */
  readonly routeTargetIds?: readonly string[];
}

export interface SkillRepoPort {
  list(input: {
    companyId: string;
    departmentId?: string;
    additionalDepartmentSkillIds?: readonly string[];
    tag?: string;
    limit?: number;
  }): Promise<Result<SkillRow[], InfraError>>;

  search(input: {
    companyId: string;
    departmentId?: string;
    additionalGrantedSkillIds?: readonly string[];
    query: string;
    limit?: number;
    abortSignal?: AbortSignal;
  }): Promise<Result<SkillRow[], InfraError>>;

  findById(input: {
    companyId: string;
    departmentId?: string;
    additionalDepartmentSkillIds?: readonly string[];
    skillId: string;
    abortSignal?: AbortSignal;
  }): Promise<Result<SkillRow | null, InfraError>>;

  listRouteTargets(input: {
    companyId: string;
    departmentId?: string;
    additionalDepartmentSkillIds?: readonly string[];
    routerSkillId: string;
    abortSignal?: AbortSignal;
  }): Promise<Result<SkillRow[], InfraError>>;

  registryRevision(
    companyId: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<number, InfraError>>;
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
  aliases:      { select: { alias: true } },
} as const;

function listSelect(
  companyId: string,
  departmentId?: string,
  additionalDepartmentSkillIds: readonly string[] = [],
): Prisma.SkillSelect {
  return {
    ...SELECT,
    outgoingRoutes: {
      where: {
        targetSkill: {
          companyId,
          status: 'active',
          AND: [visibilityWhere(departmentId, additionalDepartmentSkillIds)],
        },
      },
      // The complete catalogue already contains each target body. Repeating
      // markdown and aliases once per route roughly doubles the native query
      // payload; ids are enough for the application layer to join the graph.
      select: { targetSkillId: true },
      orderBy: [{ sortOrder: 'asc' }, { targetSkill: { sortOrder: 'asc' } }],
    },
  };
}

function visibilityWhere(
  departmentId?: string,
  additionalDepartmentSkillIds: readonly string[] = [],
): Prisma.SkillWhereInput {
  const visibleScopes: Prisma.SkillWhereInput[] = [
    { scope: 'company', departmentId: null as string | null },
    ...(departmentId ? [{ scope: 'department', departmentId }] : []),
    ...(additionalDepartmentSkillIds.length > 0
      ? [{ scope: { in: ['personal', 'department'] }, id: { in: [...additionalDepartmentSkillIds] } }]
      : []),
  ];
  return visibleScopes.length === 1 ? visibleScopes[0]! : { OR: visibleScopes };
}

export class SkillRepository implements SkillRepoPort {
  constructor(private readonly db: PrismaClient) {}

  async list(input: {
    companyId: string;
    departmentId?: string;
    additionalDepartmentSkillIds?: readonly string[];
    tag?: string;
    limit: number;
  }): Promise<Result<SkillRow[], InfraError>> {
    try {
      const { companyId, departmentId, additionalDepartmentSkillIds, tag, limit } = input;
      const rows = await this.db.skill.findMany({
        where: {
          companyId,
          status: 'active',
          AND: [visibilityWhere(departmentId, additionalDepartmentSkillIds)],
          ...(tag ? { tags: { has: tag } } : {}),
        },
        select:  listSelect(companyId, departmentId, additionalDepartmentSkillIds),
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        ...(limit === undefined ? {} : { take: limit }),
      });

      return ok(rows.map(toSkillRow));
    } catch (e) {
      return err(wrapInfra('prisma', 'skill.list', e));
    }
  }

  async search(input: {
    companyId: string;
    departmentId?: string;
    additionalGrantedSkillIds?: readonly string[];
    query: string;
    limit: number;
    abortSignal?: AbortSignal;
  }): Promise<Result<SkillRow[], InfraError>> {
    try {
      input.abortSignal?.throwIfAborted();
      const { companyId, departmentId, additionalGrantedSkillIds, query, limit } = input;
      const terms = searchTerms(query);

      if (terms.length === 0) return ok([]);

      const rows = await this.db.skill.findMany({
        where: {
          companyId,
          status: 'active',
          AND: [
            visibilityWhere(departmentId, additionalGrantedSkillIds),
            { OR: terms.flatMap((term) => searchableFieldsFor(term)) },
          ],
        },
        select:  SELECT,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        take:    limit,
      });
      input.abortSignal?.throwIfAborted();

      return ok(rows.map(toSkillRow));
    } catch (e) {
      return err(wrapInfra('prisma', 'skill.search', e));
    }
  }

  async findById(input: {
    companyId: string;
    departmentId?: string;
    additionalDepartmentSkillIds?: readonly string[];
    skillId: string;
    abortSignal?: AbortSignal;
  }): Promise<Result<SkillRow | null, InfraError>> {
    try {
      input.abortSignal?.throwIfAborted();
      const { companyId, departmentId, additionalDepartmentSkillIds, skillId } = input;

      const row = await this.db.skill.findFirst({
        where: {
          companyId,
          status: 'active',
          AND: [
            visibilityWhere(departmentId, additionalDepartmentSkillIds),
            { OR: [{ id: skillId }, { slug: skillId }] },
          ],
        },
        select: SELECT,
      });
      input.abortSignal?.throwIfAborted();

      return ok(row ? toSkillRow(row) : null);
    } catch (e) {
      return err(wrapInfra('prisma', 'skill.findById', e));
    }
  }

  async listRouteTargets(input: {
    companyId: string;
    departmentId?: string;
    additionalDepartmentSkillIds?: readonly string[];
    routerSkillId: string;
    abortSignal?: AbortSignal;
  }): Promise<Result<SkillRow[], InfraError>> {
    try {
      input.abortSignal?.throwIfAborted();
      const rows = await this.db.skillRoute.findMany({
        where: {
          routerSkillId: input.routerSkillId,
          routerSkill: {
            companyId: input.companyId,
            status: 'active',
          },
          targetSkill: {
            companyId: input.companyId,
            status: 'active',
            AND: [
              visibilityWhere(input.departmentId, input.additionalDepartmentSkillIds),
            ],
          },
        },
        select: {
          targetSkill: { select: SELECT },
        },
        orderBy: [{ sortOrder: 'asc' }, { targetSkill: { sortOrder: 'asc' } }],
      });
      input.abortSignal?.throwIfAborted();
      return ok(rows.map(row => toSkillRow(row.targetSkill)));
    } catch (e) {
      return err(wrapInfra('prisma', 'skill.list_route_targets', e));
    }
  }

  async registryRevision(
    companyId: string,
    abortSignal?: AbortSignal,
  ): Promise<Result<number, InfraError>> {
    try {
      abortSignal?.throwIfAborted();
      const row = await this.db.skillRegistryRevision.findUnique({
        where: { companyId },
        select: { revision: true },
      });
      abortSignal?.throwIfAborted();
      return ok(row?.revision ?? 1);
    } catch (e) {
      return err(wrapInfra('prisma', 'skill.registry_revision', e));
    }
  }
}

function toSkillRow(row: Record<string, any>): SkillRow {
  const { aliases, outgoingRoutes, ...fields } = row;
  const routeTargetIds = Array.isArray(outgoingRoutes)
    ? outgoingRoutes.flatMap((route: unknown) => {
        if (!route || typeof route !== 'object') return [];
        const targetSkillId = (route as { targetSkillId?: unknown }).targetSkillId;
        return typeof targetSkillId === 'string' ? [targetSkillId] : [];
      })
    : undefined;
  return {
    ...fields,
    aliases: Array.isArray(aliases)
      ? aliases.flatMap((item: unknown) => {
          if (typeof item === 'string') return [item];
          if (item && typeof item === 'object' && typeof (item as { alias?: unknown }).alias === 'string') {
            return [(item as { alias: string }).alias];
          }
          return [];
        })
      : [],
    ...(routeTargetIds !== undefined ? { routeTargetIds } : {}),
  } as unknown as SkillRow;
}

const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'for', 'from', 'in', 'into', 'my', 'of', 'on', 'please',
  'return', 'the', 'then', 'to', 'using', 'with',
]);

/**
 * Convert a natural-language task into reusable catalogue terms. Repository
 * filtering is deliberately broad (any meaningful term); application-layer
 * scoring remains the single ranking authority.
 */
export function searchTerms(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9._-]+/)
      .map((term) => term.trim())
      .filter((term) => term.length > 1 && !SEARCH_STOP_WORDS.has(term)),
  )].slice(0, 20);
}

function searchableFieldsFor(term: string) {
  return [
    { name:     { contains: term, mode: 'insensitive' as const } },
    { slug:     { contains: term, mode: 'insensitive' as const } },
    { summary:  { contains: term, mode: 'insensitive' as const } },
    { markdown: { contains: term, mode: 'insensitive' as const } },
    { tags:     { has: term } },
    { toolIds:  { has: term } },
    { aliases:  { some: { alias: { contains: term, mode: 'insensitive' as const } } } },
  ];
}
