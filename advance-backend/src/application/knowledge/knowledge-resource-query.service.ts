import { Prisma, type PrismaClient } from '../../generated/prisma';
import type { DepartmentRepoPort } from '../../infrastructure/persistence/department.repository';
import {
  knowledgeFileContentSchema,
  knowledgeMemoryContentSchema,
  knowledgeSkillContentSchema,
} from './knowledge-content-validator';

const MAX_CANDIDATES = 100;

export type ReadableKnowledgeKind = 'memory' | 'skill' | 'file';
export type ReadableKnowledgeScope = 'personal' | 'department' | 'company';

export interface KnowledgeResourceSummary {
  readonly resourceId: string;
  readonly kind: ReadableKnowledgeKind;
  readonly scope: ReadableKnowledgeScope;
  readonly logicalKey: string;
  readonly currentVersion: number;
  readonly title: string;
  readonly summary: string;
  readonly department?: { readonly name: string };
  readonly updatedAt: string;
}

export interface KnowledgeResourceDetail extends KnowledgeResourceSummary {
  readonly content: unknown;
}

export interface KnowledgeMemorySearchMatch {
  readonly resource: KnowledgeResourceDetail;
  readonly score: number;
  readonly coverage: number;
}

export interface CanonicalPersonalMemorySnapshotInput {
  readonly companyId: string;
  readonly userId: string;
  readonly limit: number;
  readonly maxFactChars: number;
  readonly maxTotalChars: number;
}

/**
 * Read model for exact knowledge updates and governed-file retrieval.
 *
 * Scope IDs are never accepted from Pi. Visibility is derived from the
 * authenticated user, company, and live department memberships on every call.
 * Postgres remains canonical; Hindsight is intentionally not used for version
 * discovery because semantic projections may be delayed.
 */
export class KnowledgeResourceQueryService {
  constructor(private readonly deps: {
    readonly prisma: PrismaClient;
    readonly departments: Pick<DepartmentRepoPort, 'listActiveMemberships'>;
  }) {}

  async list(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly kind?: ReadableKnowledgeKind;
    readonly scope?: ReadableKnowledgeScope;
    readonly query?: string;
    readonly limit: number;
  }): Promise<KnowledgeResourceSummary[]> {
    const rows = await this.readableRows(input, {
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
    });
    const query = normalizeSearch(input.query ?? '');
    return rows
      .map(toDetail)
      .filter((detail): detail is KnowledgeResourceDetail => detail !== null)
      .filter(detail => !query || searchableText(detail).includes(query))
      .slice(0, Math.max(1, Math.min(input.limit, 20)))
      .map(({ content: _content, ...summary }) => summary);
  }

  async get(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly resourceId: string;
  }): Promise<KnowledgeResourceDetail | null> {
    const rows = await this.readableRows(input, { id: input.resourceId });
    const row = rows[0];
    return row ? toDetail(row) : null;
  }

  /**
   * Resolves one exact personal-memory subject from canonical Postgres state.
   * The caller supplies no owner or scope selector: both are fixed by the
   * authenticated identity passed to this service.
   */
  async getPersonalMemoryByLogicalKey(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly logicalKey: string;
  }): Promise<KnowledgeResourceDetail | null> {
    const rows = await this.readableRows(input, {
      kind: 'memory',
      scope: 'personal',
      logicalKey: input.logicalKey,
    });
    const row = rows[0];
    const detail = row ? toDetail(row) : null;
    return detail?.kind === 'memory' && detail.scope === 'personal' ? detail : null;
  }

  /**
   * Hydrate semantic hits from canonical Postgres versions in one bounded read.
   * Visibility is recalculated here; a resource ID emitted by the semantic
   * index is never treated as authorization.
   */
  async getManyMemories(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly resourceIds: readonly string[];
  }): Promise<KnowledgeResourceDetail[]> {
    const resourceIds = [...new Set(input.resourceIds)].slice(0, 20);
    if (resourceIds.length === 0) return [];
    const rows = await this.readableRows(input, { ids: resourceIds, kind: 'memory' });
    return rows
      .map(toDetail)
      .filter((detail): detail is KnowledgeResourceDetail => detail?.kind === 'memory');
  }

  /**
   * Indexed canonical-memory search used both for degraded recall and for
   * resolving a model-proposed subject to its existing durable identity.
   * Authorization is repeated during hydration; an SQL hit is never authority.
   */
  async searchMemories(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly query: string;
    readonly scope?: 'personal';
    readonly limit: number;
  }): Promise<KnowledgeMemorySearchMatch[]> {
    const query = input.query.replaceAll('\u0000', '').normalize('NFKC').trim().slice(0, 500);
    if (!query) return [];
    const memberships = await this.deps.departments.listActiveMemberships(
      input.userId,
      input.companyId,
    );
    if (!memberships.ok) throw memberships.error;
    const departmentIds = memberships.value.map(membership => membership.departmentId);
    const departmentClause = departmentIds.length > 0
      ? Prisma.sql`("resource"."scope" = 'department' AND "resource"."departmentId" IN (${Prisma.join(departmentIds)}))`
      : Prisma.sql`FALSE`;
    const visibilityClause = input.scope === 'personal'
      ? Prisma.sql`"resource"."scope" = 'personal' AND "resource"."ownerUserId" = ${input.userId}`
      : Prisma.sql`(
          "resource"."scope" = 'company'
          OR ("resource"."scope" = 'personal' AND "resource"."ownerUserId" = ${input.userId})
          OR ${departmentClause}
        )`;
    const rows = await this.deps.prisma.$queryRaw<Array<{
      resourceId: string;
      score: number;
      coverage: number;
    }>>(Prisma.sql`
      WITH "input" AS (
        SELECT
          tsvector_to_array(to_tsvector('simple', ${query})) AS "terms",
          websearch_to_tsquery(
            'simple',
            array_to_string(tsvector_to_array(to_tsvector('simple', ${query})), ' OR ')
          ) AS "unionQuery"
      ),
      "ranked" AS (
        SELECT
          "resource"."id" AS "resourceId",
          "resource"."updatedAt" AS "updatedAt",
          cardinality("input"."terms") AS "termCount",
          (
            SELECT count(*)::int
            FROM unnest("input"."terms") AS "matched"("term")
            WHERE "version"."searchVector" @@ plainto_tsquery('simple', "matched"."term")
          ) AS "matchedTerms",
          ts_rank_cd(
            "version"."searchVector",
            "input"."unionQuery"
          )::float8 AS "rankScore"
        FROM "KnowledgeResource" AS "resource"
        JOIN "KnowledgeVersion" AS "version"
          ON "version"."resourceId" = "resource"."id"
         AND "version"."version" = "resource"."currentVersion"
        CROSS JOIN "input"
        WHERE cardinality("input"."terms") > 0
          AND "resource"."companyId" = ${input.companyId}
          AND "resource"."kind" = 'memory'
          AND "resource"."status" = 'active'
          AND "version"."searchVector" @@ "input"."unionQuery"
          AND ${visibilityClause}
      )
      SELECT
        "resourceId",
        ("matchedTerms"::float8 / "termCount"::float8) AS "coverage",
        (("matchedTerms"::float8 / "termCount"::float8) + "rankScore") AS "score"
      FROM "ranked"
      WHERE "matchedTerms" > 0
      ORDER BY "score" DESC, "updatedAt" DESC, "resourceId" ASC
      LIMIT ${Math.max(1, Math.min(input.limit, 40))}
    `);
    const resources = await this.getManyMemories({
      companyId: input.companyId,
      userId: input.userId,
      resourceIds: rows.map(row => row.resourceId),
    });
    const byId = new Map(resources.map(resource => [resource.resourceId, resource]));
    return rows.flatMap(row => {
      const resource = byId.get(row.resourceId);
      const score = Number(row.score);
      const coverage = Number(row.coverage);
      if (!resource || !Number.isFinite(score) || !Number.isFinite(coverage)) return [];
      return [{
        resource,
        score,
        coverage,
      }];
    });
  }

  private async readableRows(
    identity: { readonly companyId: string; readonly userId: string },
    where: {
      readonly id?: string;
      readonly ids?: readonly string[];
      readonly kind?: ReadableKnowledgeKind;
      readonly scope?: ReadableKnowledgeScope;
      readonly logicalKey?: string;
    },
  ): Promise<ResourceRow[]> {
    const memberships = await this.deps.departments.listActiveMemberships(
      identity.userId,
      identity.companyId,
    );
    if (!memberships.ok) throw memberships.error;
    const departmentIds = memberships.value.map(membership => membership.departmentId);
    const visibility: Prisma.KnowledgeResourceWhereInput[] = [
      { scope: 'personal', ownerUserId: identity.userId },
      { scope: 'company' },
      ...(departmentIds.length > 0
        ? [{ scope: 'department' as const, departmentId: { in: departmentIds } }]
        : []),
    ];
    return this.deps.prisma.knowledgeResource.findMany({
      where: {
        companyId: identity.companyId,
        status: 'active',
        OR: visibility,
        ...(where.id ? { id: where.id } : {}),
        ...(where.ids ? { id: { in: [...where.ids] } } : {}),
        ...(where.kind ? { kind: where.kind } : {}),
        ...(where.scope ? { scope: where.scope } : {}),
        ...(where.logicalKey ? { logicalKey: where.logicalKey } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: where.id ? 1 : where.ids ? Math.min(where.ids.length, 20) : MAX_CANDIDATES,
      include: {
        department: { select: { name: true } },
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { version: true, contentJson: true },
        },
      },
    });
  }
}

/**
 * Read the Desktop boot snapshot from canonical Postgres state.
 *
 * This deliberately does not use the semantic-memory port. Boot context is
 * identity-bound configuration, not a best-effort search result: only active
 * personal resources owned by this user, with a matching current version and
 * validated memory content, may cross this boundary.
 */
export async function getCanonicalPersonalMemorySnapshot(
  prisma: PrismaClient,
  input: CanonicalPersonalMemorySnapshotInput,
): Promise<string[]> {
  const limit = Math.max(1, Math.min(input.limit, 100));
  const maxFactChars = Math.max(1, Math.min(input.maxFactChars, 500));
  const maxTotalChars = Math.max(1, Math.min(input.maxTotalChars, 10_000));
  const rows = await prisma.knowledgeResource.findMany({
    where: {
      companyId: input.companyId,
      ownerUserId: input.userId,
      scope: 'personal',
      kind: 'memory',
      status: 'active',
    },
    orderBy: { updatedAt: 'desc' },
    take: MAX_CANDIDATES,
    include: {
      department: { select: { name: true } },
      versions: {
        orderBy: { version: 'desc' },
        take: 1,
        select: { version: true, contentJson: true },
      },
    },
  });

  const seen = new Set<string>();
  const facts: string[] = [];
  let totalChars = 0;
  for (const row of rows) {
    const detail = toDetail(row);
    if (!detail || detail.kind !== 'memory') continue;
    const content = knowledgeMemoryContentSchema.safeParse(detail.content);
    if (!content.success) continue;
    for (const rawFact of content.data.facts) {
      const fact = rawFact.trim();
      const key = normalizeSearch(fact);
      if (
        !key
        || seen.has(key)
        || fact.length > maxFactChars
        || facts.length >= limit
        || totalChars + fact.length > maxTotalChars
      ) continue;
      seen.add(key);
      facts.push(fact);
      totalChars += fact.length;
    }
    if (facts.length >= limit || totalChars >= maxTotalChars) break;
  }
  return facts;
}

type ResourceRow = Prisma.KnowledgeResourceGetPayload<{
  include: {
    department: { select: { name: true } };
    versions: {
      orderBy: { version: 'desc' };
      take: 1;
      select: { version: true; contentJson: true };
    };
  };
}>;

function toDetail(row: ResourceRow): KnowledgeResourceDetail | null {
  const version = row.versions[0];
  if (!version || version.version !== row.currentVersion) return null;
  const common = {
    resourceId: row.id,
    kind: row.kind,
    scope: row.scope,
    logicalKey: row.logicalKey,
    currentVersion: row.currentVersion,
    ...(row.department ? { department: { name: row.department.name } } : {}),
    updatedAt: row.updatedAt.toISOString(),
  } as const;

  if (row.kind === 'memory') {
    const content = knowledgeMemoryContentSchema.safeParse(version.contentJson);
    if (!content.success) return null;
    return {
      ...common,
      title: row.logicalKey,
      summary: `${content.data.facts.length} durable fact${content.data.facts.length === 1 ? '' : 's'}`,
      content: content.data,
    };
  }
  if (row.kind === 'skill') {
    const content = knowledgeSkillContentSchema.safeParse(version.contentJson);
    if (!content.success) return null;
    return {
      ...common,
      title: content.data.name,
      summary: content.data.summary,
      content: content.data,
    };
  }
  const content = knowledgeFileContentSchema.safeParse(version.contentJson);
  if (!content.success) return null;
  return {
    ...common,
    title: content.data.fileName,
    summary: `${content.data.mimeType}, ${content.data.sizeBytes} bytes`,
    content: content.data,
  };
}

function searchableText(resource: KnowledgeResourceDetail): string {
  const content = resource.content;
  const extra = resource.kind === 'memory'
    ? knowledgeMemoryContentSchema.parse(content).facts.join(' ')
    : resource.kind === 'skill'
      ? (() => {
          const skill = knowledgeSkillContentSchema.parse(content);
          return [skill.name, skill.slug, skill.summary, ...skill.tags].join(' ');
        })()
      : (() => {
          const file = knowledgeFileContentSchema.parse(content);
          return `${file.fileName} ${file.mimeType}`;
        })();
  return normalizeSearch(`${resource.logicalKey} ${resource.title} ${resource.summary} ${extra}`);
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}
