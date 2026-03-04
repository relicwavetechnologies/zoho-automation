import { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';

import config from '../config';
import { HttpException } from '../core/http-exception';
import { AuthenticatedRequest } from '../types/express';

export const authMiddleware = (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HttpException(401, 'Authorization header missing or invalid');
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as { userId: string };
    req.user = { id: payload.userId };
    return next();
  } catch {
    throw new HttpException(401, 'Invalid or expired token');
  }
};


