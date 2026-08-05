import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import type { MemoryService } from './semantic-memory.port';
import { unknownSkillToolIds } from '../skills/skill-tool-validation';
import { larkSkillEnglishOnlyError } from '../skills/lark-skill-language-policy';
import { recordSkillRegistryMutation } from '../skills/skill-registry-versioning';
import {
  knowledgeFileContentSchema,
  knowledgeMemoryContentSchema,
  knowledgeSkillContentSchema,
} from './knowledge-content-validator';
import type { KnowledgeDocumentIndexService } from './knowledge-document-index.service';
import type { KnowledgeFileAssetRepository, KnowledgeFileService } from './knowledge-file.service';

export interface KnowledgeProjectionOptions {
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly processingLeaseMs: number;
}

const DEFAULT_OPTIONS: KnowledgeProjectionOptions = {
  batchSize: 20,
  maxAttempts: 10,
  retryBaseMs: 1_000,
  processingLeaseMs: 5 * 60_000,
};

/**
 * Projects authoritative Postgres versions into query-optimized stores.
 * Projection is idempotent and retryable; policy and approval never live here.
 */
export class KnowledgeProjectionService {
  private readonly log: Logger;
  private readonly options: KnowledgeProjectionOptions;

  constructor(private readonly deps: {
    readonly prisma: PrismaClient;
    readonly memory: MemoryService | null;
    readonly documents?: KnowledgeDocumentIndexService;
    readonly fileAssets?: Pick<KnowledgeFileAssetRepository, 'getForAccess'>;
    readonly files?: Pick<KnowledgeFileService, 'purgeResource'>;
    readonly logger: Logger;
    readonly options?: Partial<KnowledgeProjectionOptions>;
  }) {
    this.log = deps.logger.child({ service: 'knowledge-projection' });
    this.options = { ...DEFAULT_OPTIONS, ...deps.options };
  }

  async projectMutation(mutationId: string): Promise<void> {
    const eventIds = await this.deps.prisma.knowledgeOutbox.findMany({
      where: {
        mutationId,
        status: { in: ['pending', 'failed'] },
        availableAt: { lte: new Date() },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    for (const event of eventIds) {
      const claim = await this.claimOne(event.id);
      if (claim) await this.projectClaimed(claim);
    }
  }

  async drain(): Promise<number> {
    const claims = await this.claimBatch();
    // One poisoned projection must not prevent unrelated outbox rows from
    // completing. Each failure has already been made durable by
    // projectClaimed before allSettled observes it.
    await Promise.allSettled(claims.map(claim => this.projectClaimed(claim)));
    return claims.length;
  }

  private async claimOne(id: string): Promise<ProjectionClaim | null> {
    return this.deps.prisma.$transaction(async tx => {
      const staleBefore = new Date(Date.now() - this.options.processingLeaseMs);
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT outbox."id"
        FROM "KnowledgeOutbox" AS outbox
        JOIN "KnowledgeMutation" AS mutation ON mutation."id" = outbox."mutationId"
        WHERE outbox."id" = ${id}
          AND mutation."resourceId" IS NOT NULL
          AND outbox."attempts" < ${this.options.maxAttempts}
          AND outbox."availableAt" <= NOW()
          AND (
            outbox."status" IN ('pending', 'failed')
            OR (outbox."status" = 'processing' AND outbox."lockedAt" < ${staleBefore})
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "KnowledgeOutbox" AS earlier_outbox
            JOIN "KnowledgeMutation" AS earlier_mutation
              ON earlier_mutation."id" = earlier_outbox."mutationId"
            WHERE earlier_mutation."resourceId" = mutation."resourceId"
              AND earlier_outbox."status" IN ('pending', 'processing', 'failed')
              AND (
                earlier_outbox."createdAt" < outbox."createdAt"
                OR (
                  earlier_outbox."createdAt" = outbox."createdAt"
                  AND earlier_outbox."id" < outbox."id"
                )
              )
          )
        FOR UPDATE
      `;
      if (rows.length === 0) return null;
      const leaseToken = randomUUID();
      const updated = await tx.knowledgeOutbox.updateMany({
        where: {
          id,
          OR: [
            { status: { in: ['pending', 'failed'] as const } },
            { status: 'processing', lockedAt: { lt: staleBefore } },
          ],
        },
        data: { status: 'processing', attempts: { increment: 1 }, lockedAt: new Date(), leaseToken },
      });
      return updated.count === 1 ? { id, leaseToken } : null;
    });
  }

  private async claimBatch(): Promise<ProjectionClaim[]> {
    return this.deps.prisma.$transaction(async tx => {
      const staleBefore = new Date(Date.now() - this.options.processingLeaseMs);
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT outbox."id"
        FROM "KnowledgeOutbox" AS outbox
        JOIN "KnowledgeMutation" AS mutation ON mutation."id" = outbox."mutationId"
        WHERE mutation."resourceId" IS NOT NULL
          AND outbox."attempts" < ${this.options.maxAttempts}
          AND outbox."availableAt" <= NOW()
          AND (
            outbox."status" IN ('pending', 'failed')
            OR (outbox."status" = 'processing' AND outbox."lockedAt" < ${staleBefore})
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "KnowledgeOutbox" AS earlier_outbox
            JOIN "KnowledgeMutation" AS earlier_mutation
              ON earlier_mutation."id" = earlier_outbox."mutationId"
            WHERE earlier_mutation."resourceId" = mutation."resourceId"
              AND earlier_outbox."status" IN ('pending', 'processing', 'failed')
              AND (
                earlier_outbox."createdAt" < outbox."createdAt"
                OR (
                  earlier_outbox."createdAt" = outbox."createdAt"
                  AND earlier_outbox."id" < outbox."id"
                )
              )
          )
        ORDER BY outbox."createdAt" ASC, outbox."id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${this.options.batchSize}
      `;
      if (rows.length === 0) return [];
      const claims: ProjectionClaim[] = [];
      for (const row of rows) {
        const leaseToken = randomUUID();
        const updated = await tx.knowledgeOutbox.updateMany({
          where: {
            id: row.id,
            OR: [
              { status: { in: ['pending', 'failed'] as const } },
              { status: 'processing', lockedAt: { lt: staleBefore } },
            ],
          },
          data: {
            status: 'processing',
            attempts: { increment: 1 },
            lockedAt: new Date(),
            leaseToken,
          },
        });
        if (updated.count === 1) claims.push({ id: row.id, leaseToken });
      }
      return claims;
    });
  }

  private async projectClaimed(claim: ProjectionClaim): Promise<void> {
    const { id: eventId, leaseToken } = claim;
    try {
      const event = await this.deps.prisma.knowledgeOutbox.findUnique({
        where: { id: eventId },
        include: {
          mutation: {
            include: {
              resource: true,
              appliedVersion: true,
            },
          },
        },
      });
      if (!event || event.status !== 'processing' || event.leaseToken !== leaseToken) return;
      const { mutation } = event;
      if (!mutation.resource) throw new Error('Projection mutation has no resource.');

      // The relation loaded above is a snapshot. Re-read the authority immediately
      // before any side effect so an older update cannot overwrite the current
      // semantic projection, and a delete cannot be resurrected by a slow worker.
      if (!(await this.isCurrentProjection(mutation.resource.id, mutation.appliedVersion?.version, event.eventType))) {
        await this.completeClaim(claim);
        return;
      }

      if (mutation.kind === 'memory') {
        await this.projectMemory(event.eventType, mutation);
      } else if (mutation.kind === 'skill') {
        await this.projectSkill(event.eventType, mutation);
      } else {
        await this.projectFile(event.eventType, mutation);
      }

      const completed = await this.deps.prisma.knowledgeOutbox.updateMany({
        where: { id: event.id, status: 'processing', leaseToken },
        data: {
          status: 'completed',
          completedAt: new Date(),
          lockedAt: null,
          leaseToken: null,
          lastError: null,
        },
      });
      if (completed.count !== 1) throw new Error('Projection lease was lost before completion.');
    } catch (cause) {
      await this.recordFailure(eventId, leaseToken, cause);
      // Direct callers need to know that the query projection is not ready;
      // otherwise a successfully committed mutation could be falsely reported
      // as immediately recallable.
      throw cause;
    }
  }

  private async completeClaim(claim: ProjectionClaim): Promise<void> {
    await this.deps.prisma.knowledgeOutbox.updateMany({
      where: { id: claim.id, status: 'processing', leaseToken: claim.leaseToken },
      data: { status: 'completed', completedAt: new Date(), lockedAt: null, leaseToken: null, lastError: null },
    });
  }

  private async isCurrentProjection(resourceId: string, version: number | undefined, eventType: string): Promise<boolean> {
    const resource = await this.deps.prisma.knowledgeResource.findUnique({
      where: { id: resourceId },
      select: { status: true, currentVersion: true },
    });
    if (!resource) return false;
    if (eventType === 'knowledge.resource.deleted') return resource.status === 'deleted';
    return resource.status === 'active' && version !== undefined && resource.currentVersion === version;
  }

  private async projectMemory(
    eventType: string,
    mutation: ProjectionMutation,
  ): Promise<void> {
    if (!this.deps.memory) throw new Error('Hindsight projection is unavailable.');
    const resource = mutation.resource!;
    const userId = resource.ownerUserId ?? mutation.requesterId;
    const scopeParams = {
      resourceId: resource.id,
      scope: resource.scope,
      userId,
      companyId: resource.companyId,
      ...(resource.departmentId ? { departmentId: resource.departmentId } : {}),
    } as const;

    if (eventType === 'knowledge.resource.deleted') {
      const current = await this.deps.prisma.knowledgeVersion.findUnique({
        where: {
          resourceId_version: {
            resourceId: resource.id,
            version: resource.currentVersion,
          },
        },
      });
      const facts = knowledgeMemoryContentSchema.parse(current?.contentJson).facts;
      await this.deps.memory.removeProjectedResource({
        ...scopeParams,
        factCount: facts.length,
      });
      return;
    }

    const version = mutation.appliedVersion;
    if (!version) throw new Error('Memory projection is missing its applied version.');
    const facts = knowledgeMemoryContentSchema.parse(version.contentJson).facts;
    const previous = version.version > 1
      ? await this.deps.prisma.knowledgeVersion.findUnique({
          where: {
            resourceId_version: {
              resourceId: resource.id,
              version: version.version - 1,
            },
          },
        })
      : null;
    const previousFactCount = previous
      ? knowledgeMemoryContentSchema.parse(previous.contentJson).facts.length
      : 0;
    await this.deps.memory.projectExplicitResource({
      ...scopeParams,
      facts,
      previousFactCount,
    });
  }

  private async projectSkill(
    eventType: string,
    mutation: ProjectionMutation,
  ): Promise<void> {
    const resource = mutation.resource!;
    const existing = await this.deps.prisma.skill.findUnique({
      where: { knowledgeResourceId: resource.id },
      include: {
        accessGrants: {
          select: { granteeType: true, granteeId: true },
        },
      },
    });
    if (eventType === 'knowledge.resource.deleted') {
      if (!existing || existing.status === 'archived') return;
      await this.deps.prisma.$transaction(async tx => {
        const archived = await tx.skill.update({
          where: { id: existing.id },
          data: {
            status: 'archived',
            revision: { increment: 1 },
            updatedBy: mutation.requesterId,
          },
        });
        await recordSkillRegistryMutation(tx, archived, 'archive');
      });
      return;
    }

    if (!mutation.appliedVersion) throw new Error('Skill projection is missing its applied version.');
    const content = knowledgeSkillContentSchema.parse(mutation.appliedVersion.contentJson);
    const unknown = unknownSkillToolIds(content.toolIds);
    if (unknown.length > 0) throw new Error(`Unknown projected skill tools: ${unknown.join(', ')}`);
    const languageError = larkSkillEnglishOnlyError(content);
    if (languageError) throw new Error(languageError);

    const projectedStatus = resource.status === 'active' ? 'active' : 'draft';
    if (existing && skillProjectionMatches(existing, content, projectedStatus, resource)) {
      // A worker may crash after the atomic Skill/grant/registry transaction
      // but before completing its outbox row. Retrying that event must not
      // manufacture another skill revision or registry revision.
      return;
    }

    const collision = await this.deps.prisma.skill.findFirst({
      where: {
        companyId: resource.companyId,
        scope: resource.scope,
        departmentId: resource.departmentId,
        slug: content.slug,
        status: { not: 'archived' },
        NOT: { knowledgeResourceId: resource.id },
      },
      select: { id: true },
    });
    if (collision) throw new Error('A different skill already owns this slug in the target scope.');

    await this.deps.prisma.$transaction(async tx => {
      const skill = existing
        ? await tx.skill.update({
            where: { id: existing.id },
            data: {
              scope: resource.scope,
              departmentId: resource.departmentId,
              name: content.name,
              slug: content.slug,
              summary: content.summary,
              markdown: content.markdown,
              toolIds: content.toolIds,
              tags: content.tags,
              status: projectedStatus,
              revision: { increment: 1 },
              updatedBy: mutation.requesterId,
            },
          })
        : await tx.skill.create({
            data: {
              knowledgeResourceId: resource.id,
              companyId: resource.companyId,
              departmentId: resource.departmentId,
              scope: resource.scope,
              name: content.name,
              slug: content.slug,
              summary: content.summary,
              markdown: content.markdown,
              toolIds: content.toolIds,
              tags: content.tags,
              status: projectedStatus,
              createdBy: mutation.requesterId,
              updatedBy: mutation.requesterId,
            },
          });

      await tx.skillAccessGrant.deleteMany({ where: { skillId: skill.id } });
      if (resource.scope === 'personal' && resource.ownerUserId) {
        await tx.skillAccessGrant.create({
          data: {
            companyId: resource.companyId,
            skillId: skill.id,
            granteeType: 'user',
            granteeId: resource.ownerUserId,
            grantedBy: mutation.requesterId,
          },
        });
      } else if (resource.scope === 'department' && resource.departmentId) {
        await tx.skillAccessGrant.create({
          data: {
            companyId: resource.companyId,
            skillId: skill.id,
            granteeType: 'department',
            granteeId: resource.departmentId,
            grantedBy: mutation.requesterId,
          },
        });
      } else if (resource.scope === 'company') {
        await tx.skillAccessGrant.create({
          data: {
            companyId: resource.companyId,
            skillId: skill.id,
            granteeType: 'company',
            granteeId: resource.companyId,
            grantedBy: mutation.requesterId,
          },
        });
      }
      await recordSkillRegistryMutation(tx, skill);
    });
  }

  private async projectFile(eventType: string, mutation: ProjectionMutation): Promise<void> {
    if (!this.deps.documents || !this.deps.fileAssets || !this.deps.files) {
      throw new Error('Governed document projection is unavailable.');
    }
    const resource = mutation.resource!;
    if (eventType === 'knowledge.resource.deleted') {
      await this.deps.documents.removeResource(resource.id);
      await this.deps.files.purgeResource({
        companyId: resource.companyId,
        resourceId: resource.id,
      });
      return;
    }
    if (!mutation.appliedVersion) throw new Error('File projection is missing its applied version.');
    const content = knowledgeFileContentSchema.parse(mutation.appliedVersion.contentJson);
    const file = await this.deps.fileAssets.getForAccess({
      assetId: content.assetId,
      companyId: resource.companyId,
    });
    if (!file) throw new Error('The approved governed-file asset is missing.');
    await this.deps.documents.index({
      resource: {
        id: resource.id,
        companyId: resource.companyId,
        scope: resource.scope,
        ownerUserId: resource.ownerUserId,
        departmentId: resource.departmentId,
      },
      version: mutation.appliedVersion.version,
      file,
    });
  }

  private async recordFailure(eventId: string, leaseToken: string, cause: unknown): Promise<void> {
    const row = await this.deps.prisma.knowledgeOutbox.findUnique({
      where: { id: eventId },
      select: { attempts: true },
    });
    if (!row) return;
    const terminal = row.attempts >= this.options.maxAttempts;
    const delay = Math.min(
      this.options.retryBaseMs * (2 ** Math.max(row.attempts - 1, 0)),
      15 * 60_000,
    );
    await this.deps.prisma.knowledgeOutbox.updateMany({
      where: { id: eventId, status: 'processing', leaseToken },
      data: {
        status: terminal ? 'failed' : 'pending',
        availableAt: new Date(Date.now() + delay),
        lockedAt: null,
        leaseToken: null,
        lastError: safeError(cause),
      },
    });
    this.log.warn('knowledge.projection.failed', {
      eventId,
      attempts: row.attempts,
      terminal,
      error: safeError(cause),
    });
  }
}

type ProjectionMutation = Prisma.KnowledgeMutationGetPayload<{
  include: { resource: true; appliedVersion: true };
}>;

interface ProjectionClaim {
  readonly id: string;
  readonly leaseToken: string;
}

interface ProjectedSkillGrant {
  readonly granteeType: 'user' | 'department' | 'company';
  readonly granteeId: string;
}

function projectedSkillGrant(
  resource: NonNullable<ProjectionMutation['resource']>,
): ProjectedSkillGrant | null {
  if (resource.scope === 'personal' && resource.ownerUserId) {
    return { granteeType: 'user', granteeId: resource.ownerUserId };
  }
  if (resource.scope === 'department' && resource.departmentId) {
    return { granteeType: 'department', granteeId: resource.departmentId };
  }
  if (resource.scope === 'company') {
    return { granteeType: 'company', granteeId: resource.companyId };
  }
  return null;
}

function skillProjectionMatches(
  existing: {
    readonly scope: string;
    readonly departmentId: string | null;
    readonly name: string;
    readonly slug: string;
    readonly summary: string;
    readonly markdown: string;
    readonly toolIds: readonly string[];
    readonly tags: readonly string[];
    readonly status: string;
    readonly accessGrants: readonly { readonly granteeType: string; readonly granteeId: string }[];
  },
  content: {
    readonly name: string;
    readonly slug: string;
    readonly summary: string;
    readonly markdown: string;
    readonly toolIds: readonly string[];
    readonly tags: readonly string[];
  },
  status: string,
  resource: NonNullable<ProjectionMutation['resource']>,
): boolean {
  const expectedGrant = projectedSkillGrant(resource);
  const grantsMatch = expectedGrant
    ? existing.accessGrants.length === 1
      && existing.accessGrants[0]?.granteeType === expectedGrant.granteeType
      && existing.accessGrants[0]?.granteeId === expectedGrant.granteeId
    : existing.accessGrants.length === 0;
  return grantsMatch
    && existing.scope === resource.scope
    && existing.departmentId === resource.departmentId
    && existing.name === content.name
    && existing.slug === content.slug
    && existing.summary === content.summary
    && existing.markdown === content.markdown
    && arraysEqual(existing.toolIds, content.toolIds)
    && arraysEqual(existing.tags, content.tags)
    && existing.status === status;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function safeError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.slice(0, 2_000);
}
