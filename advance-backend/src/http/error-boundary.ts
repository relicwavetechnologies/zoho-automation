import type { Request, Response, NextFunction } from 'express';
import type { Logger } from '../shared/logger';
import type { AppError } from '../shared/errors';

export const createErrorBoundary = (logger: Logger) =>
  (error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (error instanceof Error && 'kind' in error) {
      const appErr = error as AppError;
      switch (appErr.kind) {
        case 'permission':
          res.status(403).json({ error: 'permission_denied', message: appErr.message });
          return;
        case 'tool':
          res.status(422).json({ error: 'tool_failure', message: appErr.message });
          return;
        case 'channel':
          res.status(502).json({ error: 'channel_error', message: appErr.message });
          return;
        case 'orchestration':
          res.status(500).json({ error: 'orchestration_error', message: appErr.message });
          return;
        case 'infra':
          logger.error('infra.error', { op: appErr.payload.op, layer: appErr.payload.layer });
          res.status(500).json({ error: 'internal_error', message: 'Internal service error' });
          return;
      }
    }

    logger.error('unhandled.error', { error: String(error) });
    res.status(500).json({ error: 'internal_error', message: 'An unexpected error occurred' });
  };
