import { rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { ManagerTeachMediaProcessor } from './manager-teach-media.processor';
import { ManagerTeachPersonaProcessor } from './manager-teach-persona.processor';
import { ManagerTeachQueue, type ManagerTeachQueueStage } from './manager-teach.queue';

export type ManagerTeachSourceInput = 'recording' | 'upload';

export interface ManagerTeachSessionView {
  readonly id: string;
  readonly departmentId: string;
  readonly source: ManagerTeachSourceInput;
  readonly status:
    | 'awaiting_upload'
    | 'queued'
    | 'ingesting'
    | 'ready_for_processing'
    | 'persona_processing'
    | 'persona_updated'
    | 'no_learning'
    | 'failed'
    | 'cancelled';
  readonly progress: number;
  readonly originalFileName: string | null;
  readonly mimeType: string | null;
  readonly fileSize: number | null;
  readonly lastError: string | null;
  readonly understanding: string | null;
  readonly appliedChangeCount: number;
  readonly personaRevision: number | null;
  readonly remainingUndos: number;
  readonly canCancel: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
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
  readonly mediaProcessor: ManagerTeachMediaProcessor;
  readonly personaProcessor: ManagerTeachPersonaProcessor;
  readonly maxVideoBytes: number;
  readonly rawRetentionHours: number;
}

/**
 * Authoritative explicit-Teach job service. Media ingestion and persona
 * synthesis are separate durable stages; only the synthesis processor writes.
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
      include: { personaMutation: true },
    });
    if (!session) throw new ManagerTeachError('session_not_found', 'Teach session was not found');
    const remainingUndos = session.personaMutation?.treeId
      ? await this.deps.prisma.managerPersonaRevision.count({ where: { treeId: session.personaMutation.treeId } })
      : 0;
    return toSessionView(session, session.personaMutation, remainingUndos);
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

    await this.enqueueDurableSession(session.id, 'ingest');
    return toSessionView(session);
  }

  async cancelSession(input: { companyId: string; managerId: string; sessionId: string }): Promise<ManagerTeachSessionView> {
    const session = await this.deps.prisma.managerTeachSession.findFirst({
      where: { id: input.sessionId, companyId: input.companyId, managerId: input.managerId },
    });
    if (!session) throw new ManagerTeachError('session_not_found', 'Teach session was not found');
    if (session.status === 'cancelled') return toSessionView(session);
    if (['persona_processing', 'persona_updated', 'no_learning', 'failed'].includes(session.status)) {
      throw new ManagerTeachError('invalid_state', 'This Teach session can no longer be cancelled');
    }

    const cancelled = await this.deps.prisma.managerTeachSession.updateMany({
      where: {
        id: session.id,
        status: { in: ['awaiting_upload', 'queued', 'ingesting', 'ready_for_processing'] },
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
      where: { status: { in: ['queued', 'ready_for_processing'] }, cancelRequestedAt: null },
      select: { id: true, status: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    await Promise.all(sessions.map(session => this.enqueueDurableSession(
      session.id,
      session.status === 'queued' ? 'ingest' : 'synthesize',
    )));
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
      const result = await this.deps.mediaProcessor.process({
        teachSessionId: session.id,
        companyId: session.companyId,
        departmentId: session.departmentId,
        managerId: session.managerId,
        source: session.source,
        originalFileName: session.originalFileName,
        videoPath: artifact.storageKey,
        evidenceDir: join(dirname(artifact.storageKey), 'evidence'),
        assertActive: () => this.assertIngestionActive(sessionId),
        onProgress: async progress => {
          if (progress < 95 && progress - lastProgress < 3) return;
          lastProgress = progress;
          await this.updateIngestionProgress(sessionId, progress);
        },
      });

      const expiresAt = new Date(Date.now() + this.deps.rawRetentionHours * 3_600_000);
      const persisted = await this.deps.prisma.$transaction(async tx => {
        const completed = await tx.managerTeachSession.updateMany({
          where: { id: sessionId, status: 'ingesting', cancelRequestedAt: null },
          data: {
            status: 'ready_for_processing',
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
      await this.enqueueDurableSession(sessionId, 'synthesize');
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
      await this.deps.prisma.managerTeachSession.updateMany({
        where: { id: sessionId, status: 'ingesting', cancelRequestedAt: null },
        data: { status: 'queued', progress: 25, lastError: message },
      });
      throw error;
    }
  }

  async processPersonaSynthesis(
    sessionId: string,
  ): Promise<'persona_updated' | 'no_learning' | 'ignored'> {
    const result = await this.deps.personaProcessor.process(sessionId);
    if (!result) return 'ignored';
    await this.cleanupSessionArtifacts(sessionId).catch(error => {
      this.log.warn('manager-teach.cleanup_after_persona_failed', { sessionId, error: String(error) });
    });
    return result.status;
  }

  async markFailed(sessionId: string, stage: ManagerTeachQueueStage, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
    await this.deps.prisma.managerTeachSession.updateMany({
      where: {
        id: sessionId,
        status: {
          in: stage === 'ingest'
            ? ['queued', 'ingesting']
            : ['ready_for_processing', 'persona_processing'],
        },
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

  private async enqueueDurableSession(teachSessionId: string, stage: ManagerTeachQueueStage): Promise<void> {
    try {
      const queueJobId = await this.deps.queue.enqueue({ teachSessionId, stage });
      await this.deps.prisma.managerTeachSession.updateMany({
        where: {
          id: teachSessionId,
          status: stage === 'ingest' ? 'queued' : 'ready_for_processing',
        },
        data: { queueJobId },
      });
    } catch (error) {
      this.log.warn('manager-teach.queue.enqueue_failed', { teachSessionId, stage, error: String(error) });
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

  private async cleanupSessionArtifacts(sessionId: string): Promise<void> {
    const artifacts = await this.deps.prisma.managerTeachArtifact.findMany({
      where: { sessionId, status: 'available' },
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
  createdAt: Date;
  updatedAt: Date;
}, mutation?: {
  understanding: string;
  appliedChangeCount: number;
  appliedRevision: number | null;
  baseRevision: number | null;
} | null, remainingUndos = 0): ManagerTeachSessionView {
  return {
    id: session.id,
    departmentId: session.departmentId,
    source: session.source,
    status: session.status,
    progress: Math.max(0, Math.min(100, session.progress)),
    originalFileName: session.originalFileName,
    mimeType: session.mimeType,
    fileSize: session.fileSize,
    lastError: session.lastError,
    understanding: mutation?.understanding ?? null,
    appliedChangeCount: mutation?.appliedChangeCount ?? 0,
    personaRevision: mutation?.appliedRevision ?? mutation?.baseRevision ?? null,
    remainingUndos,
    canCancel: ['awaiting_upload', 'queued', 'ingesting', 'ready_for_processing'].includes(session.status),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}
