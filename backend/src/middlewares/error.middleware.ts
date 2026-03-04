import { NextFunction, Request, Response } from 'express';

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

  logger.error('Unhandled error', err);
  return res.status(500).json({ success: false, message: 'Internal Server Error' });
};


