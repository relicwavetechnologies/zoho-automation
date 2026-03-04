import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

import { logger } from '../utils/logger';

const toSingleHeaderValue = (value: string | string[] | undefined): string | null => {
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value;
};

const readRequestId = (req: Request): string | undefined =>
  (req as Request & { requestId?: string }).requestId;

const writeRequestId = (req: Request, requestId: string): void => {
  (req as Request & { requestId?: string }).requestId = requestId;
};

export const requestContextMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const inboundRequestId = toSingleHeaderValue(req.headers['x-request-id']);
  const requestId = inboundRequestId && inboundRequestId.trim().length > 0 ? inboundRequestId : randomUUID();
  writeRequestId(req, requestId);
  res.setHeader('x-request-id', requestId);
  next();
};

export const requestLoggingMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const startedAt = process.hrtime.bigint();
  const requestMeta = {
    requestId: readRequestId(req) ?? 'missing_request_id',
    method: req.method,
    path: req.originalUrl || req.url,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  };

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const meta = {
      ...requestMeta,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
    };

    if (res.statusCode >= 500) {
      logger.error('http.request.server_error', meta);
      return;
    }

    if (res.statusCode >= 400) {
      logger.warn('http.request.client_error', meta);
      return;
    }

    logger.success('http.request.success', meta);
  });

  res.on('close', () => {
    if (res.writableEnded) {
      return;
    }
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.warn('http.request.aborted', {
      ...requestMeta,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
    });
  });

  next();
};
