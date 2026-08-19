import { readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import type { VideoUnderstanding } from '../video-understanding/video-understanding.types';
import { VideoUnderstandingService } from '../video-understanding/video-understanding.service';
import { ManagerTeachPersonaProcessor } from './manager-teach-persona.processor';
import type { ManagerTeachLearningPatch } from './manager-teach-persona.types';
import { ManagerTeachQueue } from './manager-teach.queue';

/**
 * How long an ingestion may go without writing progress before it is treated
 * as dead. Generous, because a long recording can spend minutes inside a
 * single step — but finite, because "forever" is what it used to be.
 */
const STALLED_INGESTION_AFTER_MS = 10 * 60_000;
/** Claims of the same session before Teach stops trying and says so. */
const MAX_INGESTION_ATTEMPTS = 4;

/**
 * Where reading the video sits on a Teach session's own progress bar.
 *
 * The floor is where the session already is once the recording has landed and
 * been claimed; the ceiling leaves the last few points for writing the evidence
 * out. Reading reports 0–100 of itself and this maps it in.
 */
const INGESTION_READING_FLOOR = 30;
const INGESTION_READING_CEILING = 95;

export type ManagerTeachSourceInput = 'recording' | 'upload';

export type ManagerTeachProcessingStep =
  | 'awaiting_upload'
  | 'recording_received'
  | 'selecting_evidence'
  | 'transcribing'
  | 'reading_screens'
  | 'reconstructing_workflow'
  | 'evidence_ready'
  | 'agent_reasoning'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface ManagerTeachEvidenceReceipt {
  readonly durationSeconds: number | null;
  readonly frameCount: number;
  readonly transcriptSegmentCount: number;
  readonly warningCount: number;
  readonly transcriptionProvider: string | null;
  readonly transcriptionModel: string | null;
  readonly ocrModels: readonly string[];
}

export interface ManagerTeachAppliedChangeView {
  readonly operation: 'create' | 'merge' | 'replace' | 'retire';
  readonly kind: string;
  readonly scopeKey: string;
  readonly ruleKey: string;
  readonly instruction: string | null;
  readonly confidence: number;
  readonly evidenceRefs: readonly string[];
}

export interface ManagerTeachAppliedSkillView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly revision: number;
  readonly outcome: 'created' | 'updated';
}

export interface ManagerTeachSessionView {
  readonly id: string;
  readonly departmentId: string;
  readonly source: ManagerTeachSourceInput;
  readonly status:
    | 'awaiting_upload'
    | 'queued'
    | 'ingesting'
    | 'evidence_ready'
    | 'agent_processing'
    | 'completed'
    // Historical rows created by the retired server-side synthesis flow.
    | 'ready_for_processing'
    | 'persona_processing'
    | 'persona_updated'
    | 'no_learning'
    | 'failed'
    | 'cancelled';
  readonly progress: number;
  readonly processingStep: ManagerTeachProcessingStep;
  readonly originalFileName: string | null;
  readonly mimeType: string | null;
  readonly fileSize: number | null;
  readonly lastError: string | null;
  readonly understanding: string | null;
  readonly appliedChanges: readonly ManagerTeachAppliedChangeView[];
  readonly appliedSkills: readonly ManagerTeachAppliedSkillView[];
  readonly evidence: ManagerTeachEvidenceReceipt | null;
  readonly modelProvider: string | null;
  readonly modelId: string | null;
  readonly parentSessionId: string | null;
  readonly managerCorrection: string | null;
  readonly appliedChangeCount: number;
  readonly personaRevision: number | null;
  readonly remainingUndos: number;
  readonly canCancel: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagerPersonaTreeView {
  readonly revision: number;
  readonly updatedAt: string;
  readonly nodes: readonly {
    readonly id: string;
    readonly kind: string;
    readonly scopeKey: string;
    readonly ruleKey: string;
    readonly instruction: string;
    readonly confidence: number;
    readonly learningSources: readonly {
      readonly source: 'teach' | 'conversation';
      readonly sourceId: string;
      readonly decision: string;
      readonly rationale: string;
      readonly evidenceRefs: readonly string[];
      readonly learnedAt: string;
    }[];
    readonly linkedSkills: readonly {
      readonly id: string;
      readonly slug: string;
      readonly name: string;
      readonly summary: string;
      readonly revision: number;
      readonly toolIds: readonly string[];
    }[];
  }[];
}

export class ManagerTeachError extends Error {
  constructor(
    readonly code:
      | 'not_manager'
      | 'session_not_found'
      | 'invalid_state'
      | 'invalid_video'
      | 'video_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'ManagerTeachError';
  }
}

export interface ManagerTeachServiceDeps {
  readonly prisma: PrismaClient;
  readonly queue: ManagerTeachQueue;
  readonly logger: Logger;
  readonly understanding: VideoUnderstandingService;
  readonly personaProcessor: ManagerTeachPersonaProcessor;
  readonly maxVideoBytes: number;
  readonly rawRetentionHours: number;
  readonly uploadDir: string;
}

const evidenceReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string().optional(),
  source: z.object({
    teachSessionId: z.string(),
    companyId: z.string(),
    departmentId: z.string(),
    managerId: z.string(),
    kind: z.enum(['recording', 'upload']),
    originalFileName: z.string().nullable().optional(),
  }).passthrough(),
  video: z.object({ durationSeconds: z.number().nonnegative().optional() }).passthrough(),
  frames: z.array(z.object({
    ocr: z.object({ provider: z.string().optional(), model: z.string().optional() }).passthrough(),
  }).passthrough()),
  transcript: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    segments: z.array(z.object({
      start: z.number().nonnegative(),
      end: z.number().nonnegative(),
      text: z.string(),
    }).passthrough()),
    text: z.string().optional(),
  }).passthrough(),
  warnings: z.array(z.string()),
}).passthrough();

/**
 * Authoritative explicit-Teach service. Media ingestion stops at durable
 * evidence; an authenticated Pi Teach session requests one atomic governed
 * persona-and-skill learning write.
 */
export class ManagerTeachService {
  private readonly log: Logger;

  constructor(private readonly deps: ManagerTeachServiceDeps) {
    this.log = deps.logger.child({ service: 'manager-teach' });
  }

  async createSession(input: {
    companyId: string;
    managerId: string;
    departmentId: string;
    source: ManagerTeachSourceInput;
    originalFileName?: string;
    mimeType?: string;
    fileSize?: number;
  }): Promise<ManagerTeachSessionView> {
    await this.assertManager(input);
    if (input.fileSize !== undefined && input.fileSize > this.deps.maxVideoBytes) {
      throw new ManagerTeachError('video_too_large', 'The recording exceeds the configured upload limit');
    }
    if (input.mimeType && !isSupportedVideoMime(input.mimeType)) {
      throw new ManagerTeachError('invalid_video', 'Teach accepts MP4, MOV or WebM recordings');
    }

    const session = await this.deps.prisma.managerTeachSession.create({
      data: {
        companyId: input.companyId,
        managerId: input.managerId,
        departmentId: input.departmentId,
        source: input.source,
        ...(input.originalFileName ? { originalFileName: input.originalFileName.slice(0, 255) } : {}),
        ...(input.mimeType ? { mimeType: normalizeVideoMime(input.mimeType) } : {}),
        ...(input.fileSize !== undefined ? { fileSize: input.fileSize } : {}),
      },
    });
    return toSessionView(session);
  }

  async getSession(input: { companyId: string; managerId: string; sessionId: string }): Promise<ManagerTeachSessionView> {
    const session = await this.deps.prisma.managerTeachSession.findFirst({
      where: { id: input.sessionId, companyId: input.companyId, managerId: input.managerId },
      include: {
        personaMutation: true,
        artifacts: { where: { kind: 'evidence_manifest', status: 'available' }, take: 1 },
      },
    });
    if (!session) throw new ManagerTeachError('session_not_found', 'Teach session was not found');
    const remainingUndos = session.personaMutation?.treeId
      ? await this.deps.prisma.managerPersonaRevision.count({ where: { treeId: session.personaMutation.treeId } })
      : 0;
    const evidence = await readEvidenceReceipt(session.artifacts[0]?.storageKey);
    return toSessionView(session, session.personaMutation, remainingUndos, evidence);
  }

  async listRecentLearnings(input: {
    companyId: string;
    managerId: string;
    departmentId: string;
    limit: number;
  }): Promise<ManagerTeachSessionView[]> {
    await this.assertManager(input);
    const sessions = await this.deps.prisma.managerTeachSession.findMany({
      where: {
        companyId: input.companyId,
        managerId: input.managerId,
        departmentId: input.departmentId,
        status: { in: ['completed', 'persona_updated', 'no_learning'] },
      },
      include: {
        personaMutation: true,
        artifacts: { where: { kind: 'evidence_manifest', status: 'available' }, take: 1 },
      },
      orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.max(1, Math.min(50, input.limit)),
    });
    return Promise.all(sessions.map(async session => toSessionView(
      session,
      session.personaMutation,
      0,
      await readEvidenceReceipt(session.artifacts[0]?.storageKey),
    )));
  }

  async getPersonaTree(input: {
    companyId: string;
    managerId: string;
    departmentId: string;
  }): Promise<ManagerPersonaTreeView | null> {
    await this.assertManager(input);
    const tree = await this.deps.prisma.managerPersonaTree.findUnique({
      where: { companyId_managerId_departmentId: input },
      select: {
        revision: true,
        updatedAt: true,
        nodes: {
          where: { status: 'active' },
          orderBy: [{ scopeKey: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            kind: true,
            scopeKey: true,
            ruleKey: true,
            instruction: true,
            confidence: true,
            learningProvenance: {
              orderBy: { createdAt: 'desc' },
              take: 3,
              select: {
                teachSessionId: true,
                decision: true,
                rationale: true,
                evidenceRefs: true,
                createdAt: true,
              },
            },
            candidates: {
              orderBy: { promotedAt: 'desc' },
              take: 3,
              select: {
                rationale: true,
                promotedAt: true,
                evidence: { select: { id: true, executionRunId: true, capturedAt: true } },
              },
            },
            skillLinks: {
              where: { skill: { status: 'active' } },
              select: {
                skill: { select: { id: true, slug: true, name: true, summary: true, revision: true, toolIds: true } },
              },
            },
          },
        },
      },
    });
    if (!tree) return null;
    return {
      revision: tree.revision,
      updatedAt: tree.updatedAt.toISOString(),
      nodes: tree.nodes.map(node => ({
        id: node.id,
        kind: node.kind,
        scopeKey: node.scopeKey,
        ruleKey: node.ruleKey,
        instruction: node.instruction,
        confidence: node.confidence,
        learningSources: [
          ...node.learningProvenance.map(source => ({
            source: 'teach' as const,
            sourceId: source.teachSessionId,
            decision: source.decision,
            rationale: source.rationale,
            evidenceRefs: source.evidenceRefs,
            learnedAt: source.createdAt.toISOString(),
          })),
          ...node.candidates.map(candidate => ({
            source: 'conversation' as const,
            sourceId: candidate.evidence.executionRunId,
            decision: 'promote',
            rationale: candidate.rationale,
            evidenceRefs: [candidate.evidence.id],
            learnedAt: (candidate.promotedAt ?? candidate.evidence.capturedAt).toISOString(),
          })),
        ].sort((left, right) => right.learnedAt.localeCompare(left.learnedAt)).slice(0, 3),
        linkedSkills: node.skillLinks.map(link => link.skill),
      })),
    };
  }

  async getAgentContext(input: {
    companyId: string;
    managerId: string;
    departmentId: string;
    sessionId: string;
  }) {
    return this.deps.personaProcessor.getContext(input);
  }

  async applyAgentLearning(input: {
    companyId: string;
    managerId: string;
    departmentId: string;
    sessionId: string;
    mutationKey: string;
    patch: ManagerTeachLearningPatch;
  }) {
    const result = await this.deps.personaProcessor.apply(input);
    await this.cleanupSessionRawVideo(input.sessionId).catch(error => {
      this.log.warn('manager-teach.cleanup_after_agent_failed', {
        sessionId: input.sessionId,
        error: String(error),
      });
    });
    return result;
  }

  async prepareUpload(input: { companyId: string; managerId: string; sessionId: string }) {
    const session = await this.deps.prisma.managerTeachSession.findFirst({
      where: { id: input.sessionId, companyId: input.companyId, managerId: input.managerId },
      include: { artifacts: { where: { kind: 'raw_video', status: 'available' }, take: 1 } },
    });
    if (!session) throw new ManagerTeachError('session_not_found', 'Teach session was not found');
    if (session.status !== 'awaiting_upload' || session.artifacts.length > 0) {
      throw new ManagerTeachError('invalid_state', 'This Teach session is not waiting for a recording');
    }
    return {
      sessionId: session.id,
      departmentId: session.departmentId,
      mimeType: session.mimeType,
      expectedSize: session.fileSize,
    };
  }

  async completeUpload(input: {
    companyId: string;
    managerId: string;
    sessionId: string;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<ManagerTeachSessionView> {
    if (!isSupportedVideoMime(input.mimeType)) {
      throw new ManagerTeachError('invalid_video', 'Teach accepts MP4, MOV or WebM recordings');
    }
    if (input.sizeBytes <= 0) throw new ManagerTeachError('invalid_video', 'The recording is empty');
    if (input.sizeBytes > this.deps.maxVideoBytes) {
      throw new ManagerTeachError('video_too_large', 'The recording exceeds the configured upload limit');
    }

    const expiresAt = new Date(Date.now() + this.deps.rawRetentionHours * 3_600_000);
    const session = await this.deps.prisma.$transaction(async tx => {
      const current = await tx.managerTeachSession.findFirst({
        where: { id: input.sessionId, companyId: input.companyId, managerId: input.managerId },
      });
      if (!current) throw new ManagerTeachError('session_not_found', 'Teach session was not found');
      if (current.status !== 'awaiting_upload') {
        throw new ManagerTeachError('invalid_state', 'This Teach session is no longer accepting a recording');
      }

      await tx.managerTeachArtifact.create({
        data: {
          sessionId: current.id,
          kind: 'raw_video',
          storageKey: input.storageKey,
          mimeType: normalizeVideoMime(input.mimeType),
          sizeBytes: input.sizeBytes,
          expiresAt,
        },
      });
      return tx.managerTeachSession.update({
        where: { id: current.id },
        data: {
          status: 'queued',
          progress: 25,
          mimeType: normalizeVideoMime(input.mimeType),
          fileSize: input.sizeBytes,
          lastError: null,
        },
      });
    });

    await this.enqueueDurableSession(session.id);
    return toSessionView(session);
  }

  async cancelSession(input: { companyId: string; managerId: string; sessionId: string }): Promise<ManagerTeachSessionView> {
    const session = await this.deps.prisma.managerTeachSession.findFirst({
      where: { id: input.sessionId, companyId: input.companyId, managerId: input.managerId },
    });
    if (!session) throw new ManagerTeachError('session_not_found', 'Teach session was not found');
    if (session.status === 'cancelled') return toSessionView(session);
    if (['agent_processing', 'completed', 'persona_processing', 'persona_updated', 'no_learning', 'failed'].includes(session.status)) {
      throw new ManagerTeachError('invalid_state', 'This Teach session can no longer be cancelled');
    }

    const cancelled = await this.deps.prisma.managerTeachSession.updateMany({
      where: {
        id: session.id,
        status: { in: ['awaiting_upload', 'queued', 'ingesting', 'evidence_ready', 'ready_for_processing'] },
        cancelRequestedAt: null,
      },
      data: {
        status: 'cancelled',
        cancelRequestedAt: new Date(),
        lastError: null,
      },
    });
    if (cancelled.count === 0) {
      throw new ManagerTeachError('invalid_state', 'This Teach session changed while cancellation was running');
    }
    const artifacts = await this.deps.prisma.managerTeachArtifact.findMany({
      where: { sessionId: session.id, status: 'available' },
      select: { id: true, storageKey: true, kind: true },
    });
    await Promise.all(artifacts.map(artifact => this.deleteArtifact(
      artifact.id,
      artifact.storageKey,
      artifact.kind,
    )));
    const current = await this.deps.prisma.managerTeachSession.findUnique({ where: { id: session.id } });
    if (!current) throw new ManagerTeachError('session_not_found', 'Teach session was not found');
    return toSessionView(current);
  }

  async reconcileQueuedSessions(limit = 100): Promise<void> {
    const sessions = await this.deps.prisma.managerTeachSession.findMany({
      where: { status: 'queued', cancelRequestedAt: null },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    await Promise.all(sessions.map(session => this.enqueueDurableSession(session.id)));
  }

  /**
   * Rescue sessions whose worker disappeared mid-ingestion.
   *
   * `processIngestion` returns a session to `queued` when it throws, so
   * ordinary failures already recover. A *stalled* job never reaches that
   * catch — the process died or the BullMQ lock expired, so nothing in this
   * process ever rejects. The row was simply left in `ingesting` forever:
   * never retried, never failed, and shown to the manager as "Divo is
   * watching your recording" for as long as they cared to look.
   *
   * Staleness is judged on `updatedAt`, which every progress write bumps, so
   * a genuinely slow recording that is still making headway is never
   * disturbed — only one that has stopped moving entirely.
   */
  async recoverStalledIngestions(options?: {
    staleAfterMs?: number;
    maxAttempts?: number;
    limit?: number;
  }): Promise<{ requeued: number; failed: number }> {
    const staleAfterMs = options?.staleAfterMs ?? STALLED_INGESTION_AFTER_MS;
    const maxAttempts = options?.maxAttempts ?? MAX_INGESTION_ATTEMPTS;
    const cutoff = new Date(Date.now() - staleAfterMs);

    const stranded = await this.deps.prisma.managerTeachSession.findMany({
      where: {
        status: 'ingesting',
        cancelRequestedAt: null,
        updatedAt: { lt: cutoff },
      },
      select: { id: true, attempts: true },
      orderBy: { updatedAt: 'asc' },
      take: options?.limit ?? 25,
    });

    let requeued = 0;
    let failed = 0;
    for (const session of stranded) {
      if (session.attempts >= maxAttempts) {
        // Out of road. Failing is honest here, and the manager still has the
        // recording locally to send again.
        await this.markFailed(
          session.id,
          new Error('Teach ingestion stopped responding and ran out of retries'),
        );
        failed += 1;
        continue;
      }

      const released = await this.deps.prisma.managerTeachSession.updateMany({
        where: { id: session.id, status: 'ingesting', cancelRequestedAt: null },
        data: {
          status: 'queued',
          progress: 25,
          lastError: 'Ingestion stopped responding and was restarted automatically',
        },
      });
      if (released.count === 0) continue;
      await this.enqueueDurableSession(session.id);
      requeued += 1;
    }

    if (requeued > 0 || failed > 0) {
      this.log.warn('manager-teach.ingestion.stalled_recovered', { requeued, failed });
    }
    return { requeued, failed };
  }

  /**
   * Put a session back in the queue on the manager's say-so.
   *
   * The automatic sweep deliberately waits ten minutes before deciding an
   * ingestion is dead, because cutting a slow-but-working job short would be
   * worse. That is a long time to sit watching a progress bar that stopped, so
   * the manager gets to say "it is stuck, try again" immediately. Attempts are
   * still counted, so this cannot be used to loop forever.
   */
  async resumeIngestion(input: {
    sessionId: string;
    companyId: string;
    managerId: string;
  }): Promise<ManagerTeachSessionView> {
    const session = await this.deps.prisma.managerTeachSession.findFirst({
      where: { id: input.sessionId, companyId: input.companyId, managerId: input.managerId },
    });
    if (!session) throw new ManagerTeachError('session_not_found', 'Teach session was not found');
    if (session.cancelRequestedAt) {
      throw new ManagerTeachError('invalid_state', 'This Teach session was cancelled');
    }
    if (!['queued', 'ingesting', 'failed'].includes(session.status)) {
      throw new ManagerTeachError(
        'invalid_state',
        'This Teach session is not waiting to be processed',
      );
    }

    await this.deps.prisma.managerTeachSession.updateMany({
      where: { id: session.id, cancelRequestedAt: null },
      data: {
        status: 'queued',
        progress: 25,
        failedAt: null,
        lastError: null,
        // Reset so a manager retrying by hand is not immediately cut off by
        // the automatic attempt ceiling that stranded them in the first place.
        attempts: 0,
      },
    });
    await this.enqueueDurableSession(session.id);
    this.log.info('manager-teach.ingestion.resumed', { sessionId: session.id });

    const current = await this.deps.prisma.managerTeachSession.findUnique({
      where: { id: session.id },
    });
    if (!current) throw new ManagerTeachError('session_not_found', 'Teach session was not found');
    return toSessionView(current);
  }

  async processIngestion(sessionId: string): Promise<void> {
    const claimed = await this.deps.prisma.managerTeachSession.updateMany({
      // BullMQ retries a stalled job after a worker crash. Re-claiming the
      // durable in-progress state lets that retry restart safely.
      where: { id: sessionId, status: { in: ['queued', 'ingesting'] }, cancelRequestedAt: null },
      data: {
        status: 'ingesting',
        progress: 30,
        attempts: { increment: 1 },
        startedAt: new Date(),
        lastError: null,
      },
    });
    if (claimed.count === 0) return;

    try {
      const session = await this.deps.prisma.managerTeachSession.findUnique({
        where: { id: sessionId },
        include: { artifacts: { where: { kind: 'raw_video', status: 'available' }, take: 1 } },
      });
      const artifact = session?.artifacts[0];
      if (!session || !artifact) throw new Error('Teach recording artifact is missing');
      const metadata = await stat(artifact.storageKey);
      if (!metadata.isFile() || metadata.size !== artifact.sizeBytes) {
        throw new Error('Teach recording artifact failed integrity validation');
      }

      let lastProgress = 30;
      const evidenceDir = join(dirname(artifact.storageKey), 'evidence');
      const understanding = await this.deps.understanding.understand({
        videoPath: artifact.storageKey,
        workDir: evidenceDir,
        assertActive: () => this.assertIngestionActive(sessionId),
        // Reading reports its own completeness; a Teach session's bar runs from
        // 30 to 95 across it, and doing the arithmetic here is what lets the
        // same reading drive a differently-shaped bar for a chat attachment.
        onProgress: async percent => {
          const progress = INGESTION_READING_FLOOR
            + Math.floor((percent / 100) * (INGESTION_READING_CEILING - INGESTION_READING_FLOOR));
          if (progress < INGESTION_READING_CEILING && progress - lastProgress < 3) return;
          lastProgress = progress;
          await this.updateIngestionProgress(sessionId, progress);
        },
      });
      const result = await this.writeEvidenceManifest(session, evidenceDir, understanding);

      const expiresAt = new Date(Date.now() + this.deps.rawRetentionHours * 3_600_000);
      const persisted = await this.deps.prisma.$transaction(async tx => {
        const completed = await tx.managerTeachSession.updateMany({
          where: { id: sessionId, status: 'ingesting', cancelRequestedAt: null },
          data: {
            status: 'evidence_ready',
            progress: 75,
            completedAt: null,
            lastError: null,
          },
        });
        if (completed.count === 0) return false;
        await tx.managerTeachArtifact.upsert({
          where: { sessionId_kind: { sessionId, kind: 'evidence_manifest' } },
          create: {
            sessionId,
            kind: 'evidence_manifest',
            storageKey: result.manifestPath,
            mimeType: 'application/json',
            sizeBytes: result.sizeBytes,
            expiresAt,
          },
          update: {
            status: 'available',
            storageKey: result.manifestPath,
            mimeType: 'application/json',
            sizeBytes: result.sizeBytes,
            expiresAt,
            deletedAt: null,
          },
        });
        return true;
      });
      if (!persisted) {
        await rm(dirname(result.manifestPath), { recursive: true, force: true });
        return;
      }
      this.log.info('manager-teach.ingestion.ready', {
        sessionId,
        sizeBytes: artifact.sizeBytes,
        frames: result.frameCount,
        warnings: result.warningCount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
      await this.deps.prisma.managerTeachSession.updateMany({
        where: { id: sessionId, status: 'ingesting', cancelRequestedAt: null },
        data: { status: 'queued', progress: 25, lastError: message },
      });
      throw error;
    }
  }

  /**
   * The reading, written down as this session's evidence.
   *
   * Teach owns this file rather than the reader, because the `source` block is
   * the only part of it the reader could not have produced: who recorded this,
   * for which department, under which session. Written to a temporary name and
   * renamed, so a crash halfway through leaves no half-file for the agent to
   * parse as evidence.
   */
  private async writeEvidenceManifest(
    session: { id: string; companyId: string; departmentId: string; managerId: string;
      source: ManagerTeachSourceInput; originalFileName: string | null },
    evidenceDir: string,
    understanding: VideoUnderstanding,
  ): Promise<{ manifestPath: string; sizeBytes: number; frameCount: number; warningCount: number }> {
    const manifest = {
      schemaVersion: 1 as const,
      createdAt: new Date().toISOString(),
      source: {
        teachSessionId: session.id,
        companyId: session.companyId,
        departmentId: session.departmentId,
        managerId: session.managerId,
        kind: session.source,
        originalFileName: session.originalFileName,
      },
      video: understanding.video,
      extraction: understanding.extraction,
      // `ocr` on disk, `reading` in the reader. The manifest is a stored format
      // that older sessions and the persona processor's schema already speak,
      // so the rename stops at this boundary rather than migrating files.
      frames: understanding.frames.map(frame => ({
        sequence: frame.sequence,
        path: frame.path,
        bytes: frame.bytes,
        ocr: frame.reading,
      })),
      transcript: understanding.transcript,
      warnings: understanding.warnings,
    };

    const manifestPath = join(evidenceDir, 'evidence-manifest.json');
    const temporaryPath = `${manifestPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, manifestPath);
    const metadata = await stat(manifestPath);
    return {
      manifestPath,
      sizeBytes: metadata.size,
      frameCount: manifest.frames.length,
      warningCount: manifest.warnings.length,
    };
  }

  async markFailed(sessionId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
    await this.deps.prisma.managerTeachSession.updateMany({
      where: {
        id: sessionId,
        status: { in: ['queued', 'ingesting'] },
      },
      data: { status: 'failed', failedAt: new Date(), lastError: message },
    });
  }

  async cleanupExpiredArtifacts(limit = 100): Promise<number> {
    const artifacts = await this.deps.prisma.managerTeachArtifact.findMany({
      where: { status: 'available', expiresAt: { lte: new Date() } },
      select: { id: true, storageKey: true, kind: true },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
    await Promise.all(artifacts.map(artifact => this.deleteArtifact(
      artifact.id,
      artifact.storageKey,
      artifact.kind,
    )));
    return artifacts.length;
  }

  private async enqueueDurableSession(teachSessionId: string): Promise<void> {
    try {
      const queueJobId = await this.deps.queue.enqueue({ teachSessionId });
      await this.deps.prisma.managerTeachSession.updateMany({
        where: {
          id: teachSessionId,
          status: 'queued',
        },
        data: { queueJobId },
      });
    } catch (error) {
      this.log.warn('manager-teach.queue.enqueue_failed', { teachSessionId, error: String(error) });
    }
  }

  private async updateIngestionProgress(sessionId: string, progress: number): Promise<void> {
    const mappedProgress = 30 + Math.round(((Math.max(30, Math.min(95, progress)) - 30) / 65) * 40);
    await this.deps.prisma.managerTeachSession.updateMany({
      where: { id: sessionId, status: 'ingesting', cancelRequestedAt: null },
      data: { progress: mappedProgress },
    });
  }

  private async assertIngestionActive(sessionId: string): Promise<void> {
    const active = await this.deps.prisma.managerTeachSession.findFirst({
      where: { id: sessionId, status: 'ingesting', cancelRequestedAt: null },
      select: { id: true },
    });
    if (!active) throw new Error('Teach ingestion is no longer active');
  }

  private async cleanupSessionRawVideo(sessionId: string): Promise<void> {
    const artifacts = await this.deps.prisma.managerTeachArtifact.findMany({
      where: { sessionId, status: 'available', kind: 'raw_video' },
      select: { id: true, storageKey: true, kind: true },
    });
    for (const artifact of artifacts) {
      await this.deleteArtifact(artifact.id, artifact.storageKey, artifact.kind);
    }
  }

  private async deleteArtifact(
    id: string,
    storageKey: string,
    kind: 'raw_video' | 'evidence_manifest',
  ): Promise<void> {
    if (kind === 'evidence_manifest') {
      await rm(dirname(storageKey), { recursive: true, force: true });
    } else {
      await unlink(storageKey).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    await this.deps.prisma.managerTeachArtifact.updateMany({
      where: { id, status: 'available' },
      data: { status: 'deleted', deletedAt: new Date() },
    });
  }

  private async assertManager(input: { companyId: string; managerId: string; departmentId: string }) {
    const membership = await this.deps.prisma.departmentMembership.findFirst({
      where: {
        departmentId: input.departmentId,
        userId: input.managerId,
        status: 'active',
        role: { slug: 'MANAGER' },
        department: { companyId: input.companyId, status: 'active' },
      },
      select: { id: true },
    });
    if (!membership) {
      throw new ManagerTeachError('not_manager', 'Only an active department manager can use Teach');
    }
  }
}

function normalizeVideoMime(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase().split(';')[0] ?? '';
  return normalized === 'video/quicktime' ? 'video/quicktime' : normalized;
}

export function isSupportedVideoMime(mimeType: string): boolean {
  return ['video/mp4', 'video/quicktime', 'video/webm'].includes(normalizeVideoMime(mimeType));
}

function toSessionView(session: {
  id: string;
  departmentId: string;
  source: ManagerTeachSourceInput;
  status: ManagerTeachSessionView['status'];
  progress: number;
  originalFileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  lastError: string | null;
  parentSessionId?: string | null;
  managerCorrection?: string | null;
  createdAt: Date;
  updatedAt: Date;
}, mutation?: {
  understanding: string;
  appliedChangeCount: number;
  appliedRevision: number | null;
  baseRevision: number | null;
  patchJson?: unknown;
  modelProvider?: string;
  modelId?: string;
} | null, remainingUndos = 0, evidence: ManagerTeachEvidenceReceipt | null = null): ManagerTeachSessionView {
  return {
    id: session.id,
    departmentId: session.departmentId,
    source: session.source,
    status: session.status,
    progress: Math.max(0, Math.min(100, session.progress)),
    processingStep: processingStepFor(session.status, session.progress),
    originalFileName: session.originalFileName,
    mimeType: session.mimeType,
    fileSize: session.fileSize,
    lastError: session.lastError,
    understanding: mutation?.understanding ?? null,
    appliedChanges: mutation ? appliedChangesFromPatch(mutation.patchJson) : [],
    appliedSkills: mutation ? appliedSkillsFromPatch(mutation.patchJson) : [],
    evidence,
    modelProvider: mutation?.modelProvider ?? null,
    modelId: mutation?.modelId ?? null,
    parentSessionId: session.parentSessionId ?? null,
    managerCorrection: session.managerCorrection ?? null,
    appliedChangeCount: mutation?.appliedChangeCount ?? 0,
    personaRevision: mutation?.appliedRevision ?? mutation?.baseRevision ?? null,
    remainingUndos,
    canCancel: ['awaiting_upload', 'queued', 'ingesting', 'evidence_ready', 'ready_for_processing'].includes(session.status),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function processingStepFor(
  status: ManagerTeachSessionView['status'],
  progress: number,
): ManagerTeachProcessingStep {
  if (status === 'awaiting_upload') return 'awaiting_upload';
  if (status === 'queued') return 'recording_received';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'completed' || status === 'persona_updated' || status === 'no_learning') return 'complete';
  if (status === 'evidence_ready') return 'evidence_ready';
  if (status === 'agent_processing') return 'agent_reasoning';
  if (status === 'ready_for_processing') return 'reconstructing_workflow';
  if (status === 'ingesting') {
    if (progress < 45) return 'selecting_evidence';
    if (progress < 55) return 'transcribing';
    return 'reading_screens';
  }
  return 'agent_reasoning';
}

function appliedChangesFromPatch(value: unknown): ManagerTeachAppliedChangeView[] {
  if (!value || typeof value !== 'object') return [];
  const changes = (value as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return [];
  return changes.flatMap(change => {
    if (!change || typeof change !== 'object') return [];
    const item = change as Record<string, unknown>;
    const storedOperation = item.operation;
    // `add` was the pre-canonicalization name for `create`. Keep historical
    // Teach receipts readable without accepting it in new write requests.
    const operation = storedOperation === 'add' ? 'create' : storedOperation;
    const target = operation === 'create' ? item : item.target;
    if (!['create', 'merge', 'replace', 'retire'].includes(String(operation)) || !target || typeof target !== 'object') return [];
    const typedTarget = target as Record<string, unknown>;
    if (![typedTarget.kind, typedTarget.scopeKey, typedTarget.ruleKey].every(value => typeof value === 'string')) return [];
    return [{
      operation: operation as ManagerTeachAppliedChangeView['operation'],
      kind: typedTarget.kind as string,
      scopeKey: typedTarget.scopeKey as string,
      ruleKey: typedTarget.ruleKey as string,
      instruction: typeof item.instruction === 'string' ? item.instruction : null,
      confidence: typeof item.confidence === 'number' ? item.confidence : 0,
      evidenceRefs: Array.isArray(item.evidenceRefs)
        ? item.evidenceRefs.filter((ref): ref is string => typeof ref === 'string')
        : [],
    }];
  });
}

function appliedSkillsFromPatch(value: unknown): ManagerTeachAppliedSkillView[] {
  if (!value || typeof value !== 'object') return [];
  const skills = (value as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return [];
  return skills.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const skill = item as Record<string, unknown>;
    if (
      typeof skill.id !== 'string'
      || typeof skill.slug !== 'string'
      || typeof skill.name !== 'string'
      || typeof skill.revision !== 'number'
      || !['created', 'updated'].includes(String(skill.outcome))
    ) return [];
    return [{
      id: skill.id,
      slug: skill.slug,
      name: skill.name,
      revision: skill.revision,
      outcome: skill.outcome as ManagerTeachAppliedSkillView['outcome'],
    }];
  });
}

async function readEvidenceReceipt(storageKey?: string): Promise<ManagerTeachEvidenceReceipt | null> {
  if (!storageKey) return null;
  try {
    const parsed = evidenceReceiptSchema.parse(JSON.parse(await readFile(storageKey, 'utf8')) as unknown);
    const ocrModels = [...new Set(parsed.frames.map(frame => frame.ocr.model).filter((model): model is string => Boolean(model)))];
    return {
      durationSeconds: parsed.video.durationSeconds ?? null,
      frameCount: parsed.frames.length,
      transcriptSegmentCount: parsed.transcript.segments.length,
      warningCount: parsed.warnings.length,
      transcriptionProvider: parsed.transcript.provider ?? null,
      transcriptionModel: parsed.transcript.model ?? null,
      ocrModels,
    };
  } catch {
    return null;
  }
}
