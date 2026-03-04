import { NextFunction, Request, Response } from 'express';
import { Prisma } from '../generated/prisma';

import { ApiErrorResponse } from '../core/api-response';
import { HttpException } from '../core/http-exception';
import { logger } from '../utils/logger';

export const errorMiddleware = (
  err: Error,
  _req: Request,
  res: Response<ApiErrorResponse>,
  _next: NextFunction,
) => {
  if (err instanceof HttpException) {
    logger.warn('Handled HttpException', { status: err.status, message: err.message });
    return res.status(err.status).json({ success: false, message: err.message });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      logger.warn('Handled Prisma unique constraint error', { code: err.code, meta: err.meta });
      return res.status(409).json({ success: false, message: 'Resource already exists' });
    }
  }

  logger.error('Unhandled error', err);
  return res.status(500).json({ success: false, message: 'Internal Server Error' });
};

