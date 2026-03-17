import { NextFunction, Request, Response } from 'express';
import { Prisma } from '../generated/prisma';
import { ZodError } from 'zod';

import { ApiErrorResponse } from '../core/api-response';
import { HttpException } from '../core/http-exception';
import { logger } from '../utils/logger';

export const errorMiddleware = (
  err: Error,
  req: Request,
  res: Response<ApiErrorResponse>,
  _next: NextFunction,
) => {
  const requestId = (req as Request & { requestId?: string }).requestId;
  const baseMeta = {
    requestId: requestId ?? 'missing_request_id',
    method: req.method,
    path: req.originalUrl || req.url,
  };

  if (err instanceof HttpException) {
    logger.warn('http.error.handled_http_exception', {
      ...baseMeta,
      status: err.status,
      message: err.message,
      code: 'HTTP_EXCEPTION',
    });
    return res.status(err.status).json({
      success: false,
      message: err.message,
      requestId,
    });
  }

  if (err instanceof ZodError) {
    logger.warn('http.error.zod_validation_failed', {
      ...baseMeta,
      issues: err.issues,
    });
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      details: err.issues,
      requestId,
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      logger.warn('http.error.prisma_unique_constraint', {
        ...baseMeta,
          code: err.code,
          prismaMeta: err.meta,
      });
      return res.status(409).json({
        success: false,
        message: 'Resource already exists',
        details: err.meta,
        requestId,
      });
    }
  }

  logger.error('http.error.unhandled', {
    ...baseMeta,
    error: err,
  });
  return res.status(500).json({
    success: false,
    message: 'Internal Server Error',
    ...(process.env.NODE_ENV !== 'production'
      ? {
        details: err instanceof Error
          ? {
            name: err.name,
            message: err.message,
            stack: err.stack,
          }
          : String(err),
      }
      : {}),
    requestId,
  });
};
