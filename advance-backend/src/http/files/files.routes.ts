/**
 * File management routes.
 *
 * Routes:
 *   POST   /files/upload              — upload + ingest a file
 *   GET    /files                     — list indexed files visible to the user
 *   PATCH  /files/:id/policy          — update allowed roles
 *   DELETE /files/:id                 — delete file + vectors
 *   POST   /files/:id/retry           — re-ingest a failed file
 *   POST   /files/:id/share           — request file sharing (safe=auto, review=admin approval)
 *
 * All routes require member auth (res.locals.companyId + userId + aiRole).
 */

import multer from 'multer';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { IngestionService } from '../../application/ingestion/ingestion.service';
import type { IngestionQueue } from '../../application/ingestion/ingestion.queue';
import type { FileAssetRepository } from '../../infrastructure/persistence/file-asset.repository';
import type { FileAccessPolicyRepository } from '../../infrastructure/persistence/file-access-policy.repository';
import type { KnowledgeShareService } from '../../application/knowledge-share/knowledge-share.service';
import type { Logger } from '../../shared/logger';

export interface FilesRoutesDeps {
  ingestionService:     IngestionService;
  ingestionQueue:       IngestionQueue;
  fileAssetRepo:        FileAssetRepository;
  fileAccessPolicyRepo: FileAccessPolicyRepository;
  knowledgeShareService?: KnowledgeShareService;
  logger:               Logger;
  maxFileSizeMb:        number;
}

interface AuthLocals {
  companyId:  string;
  userId:     string;
  aiRole:     string;
  isAdmin:    boolean;
}

function auth(res: Response): AuthLocals {
  return {
    companyId: res.locals['companyId'] as string,
    userId:    res.locals['userId'] as string,
    aiRole:    res.locals['aiRole'] as string,
    isAdmin:   Boolean(res.locals['isAdmin']),
  };
}

export function createFilesRouter(deps: FilesRoutesDeps): Router {
  const router = Router();
  const log = deps.logger.child({ route: 'files' });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.maxFileSizeMb * 1024 * 1024 },
  });

  // POST /files/upload
  router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const { companyId, userId } = auth(res);
    const allowedRoles = (req.body['allowedRoles'] as string | undefined)?.split(',').map(r => r.trim()) ?? [];
    const visibility   = (req.body['visibility'] as 'personal' | 'shared' | 'public' | undefined) ?? 'personal';

    try {
      // Enqueue async (don't wait for full ingestion)
      await deps.ingestionQueue.enqueue({
        jobType:         'buffer',
        companyId,
        uploaderUserId:  userId,
        uploaderChannel: 'desktop',
        fileName:        req.file.originalname,
        mimeType:        req.file.mimetype,
        bufferBase64:    req.file.buffer.toString('base64'),
        allowedRoles,
        visibility,
      });

      res.status(202).json({ message: 'File queued for ingestion' });
    } catch (e) {
      log.error('files.upload.error', { error: String(e) });
      res.status(500).json({ error: 'Failed to queue file for ingestion' });
    }
  });

  // GET /files
  router.get('/', async (_req: Request, res: Response) => {
    const { companyId, userId, aiRole, isAdmin } = auth(res);
    const result = await deps.fileAssetRepo.listVisible({ companyId, aiRole, isAdmin, ownerUserId: userId });
    if (!result.ok) {
      res.status(500).json({ error: 'Failed to list files' });
      return;
    }
    res.json({ files: result.value });
  });

  // PATCH /files/:id/policy
  router.patch('/:id/policy', async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { companyId, userId, isAdmin } = auth(res);
    const allowedRoles = req.body['allowedRoles'] as string[] | undefined;

    if (!allowedRoles || !Array.isArray(allowedRoles)) {
      res.status(400).json({ error: 'allowedRoles array required' });
      return;
    }

    const assetResult = await deps.fileAssetRepo.findById(id);
    if (!assetResult.ok || !assetResult.value) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const asset = assetResult.value;
    if (asset.companyId !== companyId || (!isAdmin && asset.uploaderUserId !== userId)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await deps.fileAccessPolicyRepo.replaceForFileAsset(id, companyId, userId, allowedRoles);
    res.json({ message: 'Policy updated' });
  });

  // DELETE /files/:id
  router.delete('/:id', async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { companyId, userId, isAdmin } = auth(res);

    const assetResult = await deps.fileAssetRepo.findById(id);
    if (!assetResult.ok || !assetResult.value) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const asset = assetResult.value;
    if (asset.companyId !== companyId || (!isAdmin && asset.uploaderUserId !== userId)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    try {
      await deps.ingestionService.deleteFile(id, companyId);
      res.json({ message: 'File deleted' });
    } catch (e) {
      log.error('files.delete.error', { fileId: id, error: String(e) });
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });

  // POST /files/:id/retry
  router.post('/:id/retry', async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { companyId, userId, isAdmin } = auth(res);

    const assetResult = await deps.fileAssetRepo.findById(id);
    if (!assetResult.ok || !assetResult.value) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const asset = assetResult.value;
    if (asset.companyId !== companyId || (!isAdmin && asset.uploaderUserId !== userId)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    try {
      await deps.ingestionService.retryFile(id, companyId);
      res.json({ message: 'Retry queued' });
    } catch (e) {
      log.error('files.retry.error', { fileId: id, error: String(e) });
      res.status(500).json({ error: 'Failed to retry ingestion' });
    }
  });

  // POST /files/:id/share
  router.post('/:id/share', async (req: Request, res: Response) => {
    if (!deps.knowledgeShareService) {
      res.status(501).json({ error: 'File sharing not configured' });
      return;
    }

    const { id } = req.params as { id: string };
    const { companyId, userId } = auth(res);

    const assetResult = await deps.fileAssetRepo.findById(id);
    if (!assetResult.ok || !assetResult.value) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const asset = assetResult.value;
    if (asset.companyId !== companyId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    try {
      const result = await deps.knowledgeShareService.requestShare({
        companyId,
        requesterUserId: userId,
        requesterOpenId: (req.body as Record<string, unknown>)?.['larkOpenId'] as string | undefined ?? '',
        requesterName:   (req.body as Record<string, unknown>)?.['displayName'] as string | undefined ?? 'User',
        fileAssetId:     id,
      });
      res.json({ outcome: result.outcome, message: result.message });
    } catch (e) {
      log.error('files.share.error', { fileId: id, error: String(e) });
      res.status(500).json({ error: 'Failed to process share request' });
    }
  });

  return router;
}
