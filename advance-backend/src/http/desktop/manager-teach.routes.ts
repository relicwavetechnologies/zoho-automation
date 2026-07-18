import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma';
import type { Logger } from '../../shared/logger';
import { ManagerTeachError, ManagerTeachService, isSupportedVideoMime } from '../../application/persona-learning/manager-teach.service';
import { ManagerPersonaRevisionError, ManagerPersonaRevisionService } from '../../application/persona-learning/manager-persona-revision.service';
import { createMemberAuthMiddleware } from '../middleware/member-auth.middleware';

const createSessionSchema = z.object({
  departmentId: z.string().trim().min(1),
  source: z.enum(['recording', 'upload']),
  originalFileName: z.string().trim().min(1).max(255).optional(),
  mimeType: z.string().trim().min(1).max(100).optional(),
  fileSize: z.number().int().positive().max(2_147_483_647).optional(),
}).strict();

const refineSessionSchema = z.object({
  correction: z.string().trim().min(1).max(2_000),
}).strict();

export function createManagerTeachRoutes(deps: {
  prisma: PrismaClient;
  memberJwtSecret: string;
  logger: Logger;
  service: ManagerTeachService;
  revisions: ManagerPersonaRevisionService;
  uploadDir: string;
  maxVideoBytes: number;
}) {
  const router = Router();
  router.use(createMemberAuthMiddleware({
    prisma: deps.prisma,
    jwtSecret: deps.memberJwtSecret,
    logger: deps.logger,
  }));

  router.post('/sessions', async (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    try {
      const session = await deps.service.createSession({
        companyId: res.locals.companyId as string,
        managerId: res.locals.userId as string,
        departmentId: parsed.data.departmentId,
        source: parsed.data.source,
        ...(parsed.data.originalFileName !== undefined ? { originalFileName: parsed.data.originalFileName } : {}),
        ...(parsed.data.mimeType !== undefined ? { mimeType: parsed.data.mimeType } : {}),
        ...(parsed.data.fileSize !== undefined ? { fileSize: parsed.data.fileSize } : {}),
      });
      res.status(201).json({ data: session });
    } catch (error) {
      respondError(res, error);
    }
  });

  router.get('/sessions/:sessionId', async (req, res) => {
    try {
      const session = await deps.service.getSession({
        companyId: res.locals.companyId as string,
        managerId: res.locals.userId as string,
        sessionId: req.params.sessionId!,
      });
      res.json({ data: session });
    } catch (error) {
      respondError(res, error);
    }
  });

  router.post('/sessions/:sessionId/refinements', async (req, res) => {
    const parsed = refineSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_request', details: parsed.error.flatten() });
      return;
    }
    try {
      const session = await deps.service.createRefinement({
        companyId: res.locals.companyId as string,
        managerId: res.locals.userId as string,
        sessionId: req.params.sessionId!,
        correction: parsed.data.correction,
      });
      res.status(202).json({ data: session });
    } catch (error) {
      respondError(res, error);
    }
  });

  router.put('/sessions/:sessionId/video', async (req, res) => {
    const companyId = res.locals.companyId as string;
    const managerId = res.locals.userId as string;
    const sessionId = req.params.sessionId!;
    const mimeType = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const declaredLength = Number(req.headers['content-length'] ?? 0);
    if (!isSupportedVideoMime(mimeType)) {
      res.status(415).json({ error: 'invalid_video', message: 'Teach accepts MP4, MOV or WebM recordings' });
      return;
    }
    if (Number.isFinite(declaredLength) && declaredLength > deps.maxVideoBytes) {
      res.status(413).json({ error: 'video_too_large', message: 'The recording exceeds the configured upload limit' });
      return;
    }

    let temporaryPath: string | undefined;
    let finalPath: string | undefined;
    try {
      const prepared = await deps.service.prepareUpload({ companyId, managerId, sessionId });
      const sessionDir = join(deps.uploadDir, companyId, sessionId);
      await mkdir(sessionDir, { recursive: true });
      const extension = extensionForMime(mimeType);
      // A unique path prevents one concurrent retry from deleting the file
      // accepted by another request when the artifact uniqueness gate wins.
      const uploadId = randomUUID();
      temporaryPath = join(sessionDir, `raw-${uploadId}.${extension}.uploading`);
      finalPath = join(sessionDir, `raw-${uploadId}.${extension}`);

      let received = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > deps.maxVideoBytes) {
            callback(new ManagerTeachError('video_too_large', 'The recording exceeds the configured upload limit'));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(req, limiter, createWriteStream(temporaryPath, { flags: 'w' }));
      if (prepared.expectedSize !== null && prepared.expectedSize !== undefined && prepared.expectedSize !== received) {
        throw new ManagerTeachError('invalid_video', 'The uploaded recording size does not match the selected file');
      }
      await rename(temporaryPath, finalPath);
      temporaryPath = undefined;

      const session = await deps.service.completeUpload({
        companyId,
        managerId,
        sessionId,
        storageKey: finalPath,
        mimeType,
        sizeBytes: received,
      });
      finalPath = undefined;
      res.status(202).json({ data: session });
    } catch (error) {
      if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (finalPath) await rm(finalPath, { force: true }).catch(() => undefined);
      respondError(res, error);
    }
  });

  router.post('/sessions/:sessionId/cancel', async (req, res) => {
    try {
      const session = await deps.service.cancelSession({
        companyId: res.locals.companyId as string,
        managerId: res.locals.userId as string,
        sessionId: req.params.sessionId!,
      });
      res.json({ data: session });
    } catch (error) {
      respondError(res, error);
    }
  });

  router.post('/persona/:departmentId/undo', async (req, res) => {
    try {
      const result = await deps.revisions.undo({
        companyId: res.locals.companyId as string,
        managerId: res.locals.userId as string,
        departmentId: req.params.departmentId!,
      });
      res.json({ data: result });
    } catch (error) {
      respondError(res, error);
    }
  });

  return router;
}

function extensionForMime(mimeType: string): 'mp4' | 'mov' | 'webm' {
  if (mimeType === 'video/quicktime') return 'mov';
  if (mimeType === 'video/webm') return 'webm';
  return 'mp4';
}

function respondError(res: Response, error: unknown): void {
  if (error instanceof ManagerTeachError) {
    const status = error.code === 'not_manager' ? 403
      : error.code === 'session_not_found' ? 404
      : error.code === 'video_too_large' ? 413
      : error.code === 'invalid_video' ? 415
      : 409;
    res.status(status).json({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof ManagerPersonaRevisionError) {
    const status = error.code === 'not_manager' ? 403
      : error.code === 'persona_not_found' ? 404
      : 409;
    res.status(status).json({ error: error.code, message: error.message });
    return;
  }
  res.status(500).json({ error: 'internal_error', message: 'Teach could not complete this request' });
}
