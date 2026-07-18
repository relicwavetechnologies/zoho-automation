import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { PersonaLearningQueue } from './persona-learning.queue';
import type { PersonaLearningExtractor, PersonaLearningObservation } from './persona-learning.extractor';
import {
  PERSONA_LEARNING_PIPELINE_VERSION,
  personaLearningTraceContextSchema,
  personaLearningToolSummariesSchema,
  sanitizePersonaLearningContext,
  sanitizePersonaLearningToolSummaries,
  type PersonaLearningToolSummary,
  type PersonaLearningTraceContext,
} from './persona-learning.types';

export interface CaptureManagerRunInput {
  readonly executionRunId: string;
  readonly companyId: string;
  readonly managerId: string;
  readonly threadId?: string;
  readonly runSummary?: string;
  readonly context: PersonaLearningTraceContext;
  readonly tools: readonly PersonaLearningToolSummary[];
}

export interface PersonaLearningServiceDeps {
  readonly prisma: PrismaClient;
  readonly queue: PersonaLearningQueue;
  readonly extractor: PersonaLearningExtractor;
  readonly logger: Logger;
}

/**
 * P1–P3 manager learning. This service is the sole writer for evidence, jobs,
 * and shadow candidates. It deliberately never touches DepartmentAgentConfig,
 * Skill, SkillVersion, UserMemory*, or any runtime prompt.
 */
export class PersonaLearningService {
  private readonly log: Logger;

  constructor(private readonly deps: PersonaLearningServiceDeps) {
    this.log = deps.logger.child({ service: 'persona-learning' });
  }

  async captureCompletedManagerRun(input: CaptureManagerRunInput): Promise<void> {
    if (!input.threadId) {
      this.log.debug('persona-learning.capture.skipped', { executionRunId: input.executionRunId, reason: 'missing_thread' });
      return;
    }

    const thread = await this.deps.prisma.desktopThread.findFirst({
      where: {
        id: input.threadId,
        companyId: input.companyId,
        userId: input.managerId,
        channel: 'desktop',
      },
      select: { departmentId: true },
    });
    const membership = thread?.departmentId
      ? await this.deps.prisma.departmentMembership.findFirst({
        where: {
          departmentId: thread.departmentId,
          userId: input.managerId,
          status: 'active',
          role: { slug: 'MANAGER' },
          department: { companyId: input.companyId, status: 'active' },
        },
        select: { departmentId: true },
      })
      : null;

    // V1 learns only if the selected desktop thread belongs to a department
    // that this exact user currently manages. No manager role is inferred.
    if (!thread?.departmentId || !membership) {
      this.log.debug('persona-learning.capture.skipped', {
        executionRunId: input.executionRunId,
        reason: !thread?.departmentId ? 'thread_has_no_department' : 'not_department_manager',
      });
      return;
    }

    const context = sanitizePersonaLearningContext(personaLearningTraceContextSchema.parse(input.context));
    const tools = sanitizePersonaLearningToolSummaries(personaLearningToolSummariesSchema.parse(input.tools));
    const hasLearningContext = context.userMessages.length > 0 && Boolean(context.assistantResponse);
    const eligibilityReason = hasLearningContext
      ? 'completed_manager_desktop_run'
      : 'missing_manager_or_assistant_context';

    const existing = await this.deps.prisma.personaLearningEvidence.findUnique({
      where: { executionRunId: input.executionRunId },
      include: { jobs: { where: { pipelineVersion: PERSONA_LEARNING_PIPELINE_VERSION }, take: 1 } },
    });
    const evidenceAndJob = existing
      ? { ...existing, job: existing.jobs[0] ?? null }
      : await this.createEvidenceAndJob({
        ...input,
        departmentId: thread.departmentId,
        context,
        tools,
        hasLearningContext,
        eligibilityReason,
      });

    if (evidenceAndJob.job?.status === 'queued') {
      await this.enqueueDurableJob(evidenceAndJob.job.id);
    }
  }

  async reconcileQueuedJobs(limit = 100): Promise<void> {
    const queued = await this.deps.prisma.personaLearningJob.findMany({
      where: { status: 'queued' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    await Promise.all(queued.map(job => this.enqueueDurableJob(job.id)));
  }

  async processShadowExtraction(jobId: string): Promise<void> {
    const job = await this.deps.prisma.personaLearningJob.findUnique({
      where: { id: jobId },
      include: { evidence: true },
    });
    if (!job || job.status === 'shadow_complete' || job.status === 'no_learning') return;

    await this.deps.prisma.personaLearningJob.update({
      where: { id: job.id },
      data: {
        status: 'processing',
        attempts: { increment: 1 },
        lastError: null,
      },
    });

    try {
      const context = personaLearningTraceContextSchema.parse(job.evidence.contextJson);
      const tools = readToolSummaries(job.evidence.toolSummaryJson);
      const existingCandidateClaims = await this.deps.prisma.personaLearningCandidate.findMany({
        where: {
          companyId: job.evidence.companyId,
          managerId: job.evidence.managerId,
          departmentId: job.evidence.departmentId,
          status: 'shadow',
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { claim: true },
      });
      const extraction = await this.deps.extractor.extract({
        companyId: job.evidence.companyId,
        departmentId: job.evidence.departmentId,
        managerId: job.evidence.managerId,
        evidenceId: job.evidence.id,
        context,
        tools,
        runSummary: job.evidence.runSummary,
        existingCandidateClaims: existingCandidateClaims.map(candidate => candidate.claim),
      });

      await this.deps.prisma.$transaction(async tx => {
        for (const [ordinal, observation] of extraction.observations.entries()) {
          await tx.personaLearningCandidate.upsert({
            where: { jobId_ordinal: { jobId: job.id, ordinal } },
            create: candidateCreateData(job, observation, ordinal),
            update: candidateUpdateData(observation),
          });
        }
        await tx.personaLearningJob.update({
          where: { id: job.id },
          data: {
            status: extraction.observations.length > 0 ? 'shadow_complete' : 'no_learning',
            modelProvider: this.deps.extractor.provider,
            modelId: this.deps.extractor.modelId,
            processedAt: new Date(),
            lastError: null,
          },
        });
      });

      this.log.info('persona-learning.shadow.complete', {
        jobId: job.id,
        evidenceId: job.evidence.id,
        candidates: extraction.observations.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
      await this.deps.prisma.personaLearningJob.update({
        where: { id: job.id },
        data: { status: 'queued', lastError: message },
      });
      throw error;
    }
  }

  async markJobFailed(jobId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
    await this.deps.prisma.personaLearningJob.updateMany({
      where: { id: jobId, status: { in: ['queued', 'processing'] } },
      data: { status: 'failed', lastError: message },
    });
  }

  private async createEvidenceAndJob(input: CaptureManagerRunInput & {
    departmentId: string;
    context: PersonaLearningTraceContext;
    tools: readonly PersonaLearningToolSummary[];
    hasLearningContext: boolean;
    eligibilityReason: string;
  }) {
    try {
      return await this.deps.prisma.$transaction(async tx => {
        const evidence = await tx.personaLearningEvidence.create({
          data: {
            companyId: input.companyId,
            managerId: input.managerId,
            departmentId: input.departmentId,
            executionRunId: input.executionRunId,
            threadId: input.threadId!,
            status: input.hasLearningContext ? 'eligible' : 'skipped',
            eligibilityReason: input.eligibilityReason,
            contextJson: input.context,
            toolSummaryJson: JSON.parse(JSON.stringify(input.tools)),
            ...(input.runSummary ? { runSummary: input.runSummary.slice(0, 2_000) } : {}),
          },
        });
        const job = input.hasLearningContext
          ? await tx.personaLearningJob.create({
            data: {
              evidenceId: evidence.id,
              pipelineVersion: PERSONA_LEARNING_PIPELINE_VERSION,
              idempotencyKey: `${evidence.id}:v${PERSONA_LEARNING_PIPELINE_VERSION}`,
              status: 'queued',
            },
          })
          : null;
        return { ...evidence, job };
      });
    } catch (error) {
      // Concurrent trace-batch retries can both observe no evidence. The
      // unique executionRunId makes the stored evidence immutable and shared.
      if ((error as { code?: string }).code !== 'P2002') throw error;
      const existing = await this.deps.prisma.personaLearningEvidence.findUnique({
        where: { executionRunId: input.executionRunId },
        include: { jobs: { where: { pipelineVersion: PERSONA_LEARNING_PIPELINE_VERSION }, take: 1 } },
      });
      if (!existing) throw error;
      return { ...existing, job: existing.jobs[0] ?? null };
    }
  }

  private async enqueueDurableJob(personaLearningJobId: string): Promise<void> {
    try {
      const queueJobId = await this.deps.queue.enqueue({ personaLearningJobId });
      await this.deps.prisma.personaLearningJob.updateMany({
        where: { id: personaLearningJobId, status: 'queued' },
        data: { ...(queueJobId ? { queueJobId } : {}) },
      });
    } catch (error) {
      // The DB job stays queued and the worker reconciles it later. Capturing a
      // desktop trace must never fail just because Redis is temporarily down.
      this.log.warn('persona-learning.queue.enqueue_failed', {
        personaLearningJobId,
        error: String(error),
      });
    }
  }
}

function candidateCreateData(
  job: {
    id: string;
    evidence: { companyId: string; managerId: string; departmentId: string; id: string };
  },
  observation: PersonaLearningObservation,
  ordinal: number,
) {
  return {
    companyId: job.evidence.companyId,
    managerId: job.evidence.managerId,
    departmentId: job.evidence.departmentId,
    evidenceId: job.evidence.id,
    jobId: job.id,
    ordinal,
    kind: observation.kind,
    scopeKey: observation.scopeKey,
    ruleKey: observation.ruleKey,
    claim: observation.claim,
    rationale: observation.rationale,
    evidenceStrength: observation.evidenceStrength,
    status: 'shadow' as const,
  };
}

function candidateUpdateData(observation: PersonaLearningObservation) {
  return {
    kind: observation.kind,
    scopeKey: observation.scopeKey,
    ruleKey: observation.ruleKey,
    claim: observation.claim,
    rationale: observation.rationale,
    evidenceStrength: observation.evidenceStrength,
  };
}

function readToolSummaries(value: unknown): PersonaLearningToolSummary[] {
  const parsed = personaLearningToolSummariesSchema.safeParse(value);
  return parsed.success ? sanitizePersonaLearningToolSummaries(parsed.data) : [];
}
