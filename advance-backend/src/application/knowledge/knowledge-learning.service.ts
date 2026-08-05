import { z } from 'zod';
import { Prisma, type PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { isSafePublishedMemoryFact } from './knowledge-fact-safety';
import type { PersonalMemoryCommandService } from './personal-memory-command.service';
import { KnowledgeMutationError } from './knowledge-mutation.errors';
import type {
  KnowledgeLearningExtractor,
  KnowledgeLearningObservation,
} from './knowledge-learning.extractor';
import type { KnowledgeLearningQueuePort } from './knowledge-learning.queue';
import {
  SHOPIFY_ERASURE_LOCK_NAMESPACE,
  shopifyErasureLockKey,
} from '../shopify/shopify-erasure-fence';

export const KNOWLEDGE_LEARNING_PIPELINE_VERSION = 1;
const MAX_USER_MESSAGES = 12;
const MAX_USER_MESSAGE_CHARS = 4_000;
const MAX_ASSISTANT_CHARS = 6_000;
const MAX_RECENT_JOBS = 30;
const PROCESSING_LEASE_MS = 5 * 60_000;

const memoryContentSchema = z.object({
  facts: z.array(z.string().trim().min(1).max(500)).min(1).max(100),
}).strict();

const storedOutcomesSchema = z.object({
  schemaVersion: z.literal(1),
  observations: z.array(z.object({
    operation: z.enum(['create', 'update', 'delete']),
    subject: z.string().optional(),
    logicalKey: z.string(),
    facts: z.array(z.string()),
    confidence: z.number(),
    evidenceStrength: z.enum(['explicit', 'strong_context', 'weak']),
    rationale: z.string(),
  }).strict()).max(5),
  results: z.array(z.unknown()),
}).strict();

export interface CaptureKnowledgeLearningInput {
  readonly sourceId: string;
  readonly companyId: string;
  readonly userId: string;
  readonly companyRole: string;
  readonly channel: 'desktop' | 'lark';
  readonly userMessages: readonly string[];
  readonly assistantText?: string;
}

export interface KnowledgeLearningOptions {
  readonly immediateConfidence: number;
  readonly repeatedConfidence: number;
  readonly repeatedEvidenceCount: number;
}

export interface KnowledgeLearningDecision {
  readonly eligible: boolean;
  readonly reason: 'explicit' | 'strong_context' | 'repeated' | 'insufficient_evidence';
}

/**
 * Evaluates model evidence without inspecting user wording. Thresholds are
 * deployment policy; the model provides semantic classification and stable
 * keys, while this deterministic gate prevents one weak inference from being
 * promoted into durable memory.
 */
export function evaluateKnowledgeLearningObservation(input: {
  readonly observation: KnowledgeLearningObservation;
  readonly userMessageCount: number;
  readonly priorMatchingObservations: number;
  readonly options: KnowledgeLearningOptions;
}): KnowledgeLearningDecision {
  const { observation, options } = input;
  if (
    observation.evidenceStrength === 'explicit'
    && observation.confidence >= options.immediateConfidence
  ) {
    return { eligible: true, reason: 'explicit' };
  }
  if (
    observation.evidenceStrength === 'strong_context'
    && input.userMessageCount >= 2
    && observation.confidence >= options.immediateConfidence
  ) {
    return { eligible: true, reason: 'strong_context' };
  }
  if (
    observation.operation !== 'delete'
    && observation.confidence >= options.repeatedConfidence
    && input.priorMatchingObservations + 1 >= options.repeatedEvidenceCount
  ) {
    return { eligible: true, reason: 'repeated' };
  }
  return { eligible: false, reason: 'insufficient_evidence' };
}

/**
 * Durable, personal-only learning pipeline. It cannot write Hindsight or a
 * knowledge table directly: every accepted observation passes live RBAC,
 * KnowledgePolicy, optimistic versioning, and the transactional outbox.
 */
export class KnowledgeLearningService {
  private readonly log: Logger;

  constructor(private readonly deps: {
    readonly prisma: PrismaClient;
    readonly queue: KnowledgeLearningQueuePort;
    readonly extractor: KnowledgeLearningExtractor;
    readonly personalMemoryCommands: PersonalMemoryCommandService;
    readonly logger: Logger;
    readonly options: KnowledgeLearningOptions;
  }) {
    this.log = deps.logger.child({ service: 'knowledge-learning' });
  }

  async captureCompletedTurn(input: CaptureKnowledgeLearningInput): Promise<void> {
    const sourceId = input.sourceId.trim().slice(0, 500);
    const userMessages = input.userMessages
      .map(message => sanitizeText(message, MAX_USER_MESSAGE_CHARS))
      .filter(Boolean)
      .slice(-MAX_USER_MESSAGES);
    if (!sourceId || userMessages.length === 0) return;

    const lockKey = shopifyErasureLockKey(input.companyId, sourceId);
    const job = await this.deps.prisma.$transaction(async tx => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtext(${SHOPIFY_ERASURE_LOCK_NAMESPACE}),
          hashtext(${lockKey})
        )::text AS lock_result
      `;
      const erased = await tx.shopifyRunErasureFence.findUnique({
        where: { companyId_sourceId: { companyId: input.companyId, sourceId } },
        select: { id: true },
      });
      if (erased) return null;
      return tx.knowledgeLearningJob.upsert({
        where: {
          companyId_userId_sourceId_pipelineVersion: {
            companyId: input.companyId,
            userId: input.userId,
            sourceId,
            pipelineVersion: KNOWLEDGE_LEARNING_PIPELINE_VERSION,
          },
        },
        create: {
          companyId: input.companyId,
          userId: input.userId,
          sourceId,
          channel: input.channel,
          companyRole: input.companyRole,
          userMessages,
          ...(input.assistantText
            ? { assistantText: sanitizeText(input.assistantText, MAX_ASSISTANT_CHARS) }
            : {}),
          pipelineVersion: KNOWLEDGE_LEARNING_PIPELINE_VERSION,
          status: 'queued',
        },
        update: {},
        select: { id: true, status: true },
      });
    });
    if (job?.status === 'queued') await this.enqueueSafely(job.id);
  }

  async reconcileQueuedJobs(limit = 100): Promise<void> {
    const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
    const jobs = await this.deps.prisma.knowledgeLearningJob.findMany({
      where: {
        pipelineVersion: KNOWLEDGE_LEARNING_PIPELINE_VERSION,
        OR: [
          { status: 'queued' },
          { status: 'processing', lockedAt: { lt: staleBefore } },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    await Promise.all(jobs.map(job => this.enqueueSafely(job.id)));
  }

  async process(jobId: string): Promise<void> {
    const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
    const claimed = await this.deps.prisma.knowledgeLearningJob.updateMany({
      where: {
        id: jobId,
        pipelineVersion: KNOWLEDGE_LEARNING_PIPELINE_VERSION,
        OR: [
          { status: 'queued' },
          { status: 'processing', lockedAt: { lt: staleBefore } },
        ],
      },
      data: {
        status: 'processing',
        lockedAt: new Date(),
        attempts: { increment: 1 },
        lastError: null,
      },
    });
    if (claimed.count !== 1) return;

    const job = await this.deps.prisma.knowledgeLearningJob.findUnique({ where: { id: jobId } });
    if (!job) return;

    try {
      const [resources, recentJobs] = await Promise.all([
        this.deps.prisma.knowledgeResource.findMany({
          where: {
            companyId: job.companyId,
            ownerUserId: job.userId,
            kind: 'memory',
            scope: 'personal',
            status: 'active',
          },
          orderBy: { updatedAt: 'desc' },
          take: 100,
          include: {
            versions: { orderBy: { version: 'desc' }, take: 1 },
          },
        }),
        this.deps.prisma.knowledgeLearningJob.findMany({
          where: {
            companyId: job.companyId,
            userId: job.userId,
            id: { not: job.id },
            pipelineVersion: KNOWLEDGE_LEARNING_PIPELINE_VERSION,
            status: { in: ['completed', 'no_learning'] },
            outcomesJson: { not: Prisma.DbNull },
          },
          orderBy: { createdAt: 'desc' },
          take: MAX_RECENT_JOBS,
          select: { outcomesJson: true },
        }),
      ]);

      const existing = resources.flatMap(resource => {
        const version = resource.versions[0];
        if (!version) return [];
        const content = memoryContentSchema.safeParse(version.contentJson);
        return content.success ? [{
          resourceId: resource.id,
          logicalKey: resource.logicalKey,
          version: resource.currentVersion,
          facts: content.data.facts,
        }] : [];
      });
      const recentObservations = recentJobs.flatMap(row => {
        const parsed = storedOutcomesSchema.safeParse(row.outcomesJson);
        return parsed.success
          ? parsed.data.observations.map(item => ({
              ...item,
              subject: item.subject ?? item.logicalKey,
            }))
          : [];
      });
      const userMessages = z.array(z.string()).parse(job.userMessages);
      const extraction = await this.deps.extractor.extract({
        sourceId: job.sourceId,
        channel: job.channel === 'lark' ? 'lark' : 'desktop',
        userMessages,
        ...(job.assistantText ? { assistantText: job.assistantText } : {}),
        existing,
        recentObservations,
      });

      const results: Prisma.InputJsonValue[] = [];
      for (const observation of extraction.observations) {
        const priorMatchingObservations = recentObservations.filter(
          prior => prior.logicalKey === observation.logicalKey,
        ).length;
        const decision = evaluateKnowledgeLearningObservation({
          observation,
          userMessageCount: userMessages.length,
          priorMatchingObservations,
          options: this.deps.options,
        });
        if (!decision.eligible) {
          results.push({ logicalKey: observation.logicalKey, status: 'observed', reason: decision.reason });
          continue;
        }

        const facts = normalizeFacts(observation.facts);
        if (
          observation.operation !== 'delete'
          && (facts.length === 0 || facts.some(fact => !isSafePublishedMemoryFact(fact)))
        ) {
          results.push({ logicalKey: observation.logicalKey, status: 'rejected', reason: 'unsafe_content' });
          continue;
        }
        try {
          const applied = await this.deps.personalMemoryCommands.execute({
            companyId: job.companyId,
            userId: job.userId,
            companyRole: job.companyRole,
            channel: job.channel === 'lark' ? 'lark' : 'desktop',
            command: observation.operation === 'delete'
              ? {
                  action: 'delete',
                  subject: observation.subject,
                  logicalKey: observation.logicalKey,
                }
              : {
                  action: 'set',
                  subject: observation.subject,
                  logicalKey: observation.logicalKey,
                  facts,
                },
            sourceType: 'automatic_learning',
            sourceRef: job.sourceId,
            requireExisting: observation.operation !== 'create',
            evidence: {
              learningJobId: job.id,
              evidenceStrength: observation.evidenceStrength,
              confidence: observation.confidence,
              rationale: observation.rationale,
              promotionReason: decision.reason,
            },
          });
          results.push({
            logicalKey: applied.logicalKey,
            status: applied.action === 'unchanged' ? 'unchanged' : 'applied',
            action: applied.action,
            resourceId: applied.resourceId,
            version: applied.version,
            projection: applied.projection,
          });
        } catch (cause) {
          if (!(cause instanceof KnowledgeMutationError)) throw cause;
          results.push({
            logicalKey: observation.logicalKey,
            status: 'rejected',
            reason: learningRejectionReason(cause),
          });
        }
      }

      await this.deps.prisma.knowledgeLearningJob.update({
        where: { id: job.id },
        data: {
          status: extraction.observations.length > 0 ? 'completed' : 'no_learning',
          lockedAt: null,
          processedAt: new Date(),
          modelProvider: this.deps.extractor.provider,
          modelId: this.deps.extractor.modelId,
          outcomesJson: { schemaVersion: 1, observations: extraction.observations, results },
          lastError: null,
        },
      });
    } catch (cause) {
      await this.deps.prisma.knowledgeLearningJob.updateMany({
        where: { id: job.id, status: 'processing' },
        data: { status: 'queued', lockedAt: null, lastError: errorMessage(cause).slice(0, 2_000) },
      });
      throw cause;
    }
  }

  async markJobFailed(jobId: string, cause: unknown): Promise<void> {
    await this.deps.prisma.knowledgeLearningJob.updateMany({
      where: { id: jobId, status: { in: ['queued', 'processing'] } },
      data: {
        status: 'failed',
        lockedAt: null,
        lastError: errorMessage(cause).slice(0, 2_000),
      },
    });
  }

  private async enqueueSafely(jobId: string): Promise<void> {
    try {
      await this.deps.queue.enqueue({ knowledgeLearningJobId: jobId });
    } catch (cause) {
      // The database row is durable; reconciliation retries queue delivery.
      this.log.warn('knowledge-learning.enqueue_failed', { jobId, error: errorMessage(cause) });
    }
  }
}

function sanitizeText(value: string, maxChars: number): string {
  return value.replaceAll('\u0000', '').trim().slice(0, maxChars);
}

function normalizeFacts(facts: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of facts) {
    const fact = sanitizeText(raw, 500);
    const key = fact.toLocaleLowerCase().replace(/\s+/g, ' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  return result.slice(0, 100);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function learningRejectionReason(error: KnowledgeMutationError): string {
  if (error.code === 'permission_denied') return 'rbac_denied';
  if (error.code === 'not_found') return 'resource_missing';
  if (error.code === 'conflict') return 'ambiguous_subject';
  if (error.code === 'policy_invalid' || error.code === 'policy_missing') {
    return 'policy_rejected';
  }
  return 'mutation_rejected';
}
