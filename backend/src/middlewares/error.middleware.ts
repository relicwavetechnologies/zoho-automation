import { NextFunction, Request, Response } from 'express';
import { Prisma } from '../generated/prisma';
import { ZodError } from 'zod';

import { ApiErrorResponse } from '../core/api-response';
import { HttpException } from '../core/http-exception';
import { desktopWorkflowsService } from '../modules/desktop-workflows/desktop-workflows.service';
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
    const isWorkflowDraftRoute =
      req.method === 'POST'
      && (req.originalUrl === '/api/desktop/workflows/drafts' || req.originalUrl === '/api/desktop/workflows/new-draft');
    const isDraftMisvalidation =
      isWorkflowDraftRoute
      && err.issues.some((issue) => issue.path[0] === 'userIntent');
    if (isDraftMisvalidation) {
      const memberSession = (req as Request & {
        memberSession?: {
          userId: string;
          companyId: string;
        };
      }).memberSession;
      if (memberSession) {
        logger.warn('http.error.workflow_draft_fallback', {
          ...baseMeta,
          issues: err.issues,
        });
        desktopWorkflowsService.createDraft(memberSession, {
          name: typeof req.body?.name === 'string' ? req.body.name : null,
          departmentId: typeof req.body?.departmentId === 'string' ? req.body.departmentId : null,
        })
          .then((result) => {
            res.status(201).json({
              success: true,
              data: result,
              message: 'Workflow draft created',
              requestId,
            });
          })
          .catch((fallbackError) => {
            logger.error('http.error.workflow_draft_fallback_failed', {
              ...baseMeta,
              error: fallbackError,
            });
            res.status(500).json({
              success: false,
              message: 'Internal Server Error',
              requestId,
            });
          });
        return;
      }
    }
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
