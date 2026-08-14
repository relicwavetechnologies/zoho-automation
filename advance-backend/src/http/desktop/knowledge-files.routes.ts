import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import type { KnowledgeFileService } from '../../application/knowledge/knowledge-file.service';
import { KnowledgeMutationError } from '../../application/knowledge/knowledge-mutation.errors';
import type { Logger } from '../../shared/logger';
import { asChannelKey } from '../../domain/channel/runtime-channel';

export function createKnowledgeFileRoutes(deps: {
  readonly files: KnowledgeFileService;
  readonly logger: Logger;
  readonly maxBytes: number;
}) {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fileSize: deps.maxBytes, fields: 0 },
  });

  router.post('/', (req, res, next) => {
    upload.single('file')(req, res, error => {
      if (error) {
        const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
        res.status(tooLarge ? 413 : 400).json({
          ok: false,
          error: tooLarge ? 'file_too_large' : 'invalid_upload',
          message: tooLarge ? 'The file exceeds the governed-file upload limit.' : 'The file upload is invalid.',
        });
        return;
      }
      void stage(req, res, next);
    });
  });

  router.get('/:assetId/download', async (req, res, next) => {
    try {
      const result = await deps.files.createDownload({
        identity: identityFrom(res),
        assetId: req.params['assetId'] ?? '',
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, ...result });
    } catch (error) {
      handleKnowledgeFileError(error, res, next);
    }
  });

  router.delete('/:assetId', async (req, res, next) => {
    try {
      const deleted = await deps.files.discardStaged({
        identity: identityFrom(res),
        assetId: req.params['assetId'] ?? '',
      });
      res.status(deleted ? 200 : 404).json({ ok: deleted, deleted });
    } catch (error) {
      handleKnowledgeFileError(error, res, next);
    }
  });

  async function stage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({ ok: false, error: 'file_required', message: 'Attach exactly one file.' });
        return;
      }
      const asset = await deps.files.stage({
        identity: identityFrom(res),
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
      });
      deps.logger.info('knowledge_file.staged', {
        assetId: asset.id,
        companyId: res.locals['companyId'],
        userId: res.locals['userId'],
        sizeBytes: asset.sizeBytes,
      });
      res.status(201).setHeader('Cache-Control', 'no-store').json({
        ok: true,
        asset: {
          assetId: asset.id,
          fileName: asset.fileName,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          sha256: asset.sha256,
          expiresAt: asset.expiresAt.toISOString(),
        },
      });
    } catch (error) {
      handleKnowledgeFileError(error, res, next);
    }
  }

  return router;
}

function identityFrom(res: Response) {
  return {
    companyId: String(res.locals['companyId']),
    userId: String(res.locals['userId']),
    companyRole: String(res.locals['aiRole']),
    channel: asChannelKey(res.locals['channel']),
  };
}

function handleKnowledgeFileError(
  error: unknown,
  res: Response,
  next: NextFunction,
): void {
  if (!(error instanceof KnowledgeMutationError)) {
    next(error);
    return;
  }
  const status = error.code === 'permission_denied' ? 403
    : error.code === 'not_found' ? 404
      : error.code === 'storage_failure' ? 503
        : error.code === 'conflict' ? 409
          : 400;
  res.status(status).json({ ok: false, error: error.code, message: error.message });
}
