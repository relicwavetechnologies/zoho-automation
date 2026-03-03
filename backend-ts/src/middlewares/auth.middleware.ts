import { NextFunction, Request, Response } from 'express';

import { verifyToken } from '../modules/auth/auth.jwt';

export interface AuthRequest extends Request {
  userId: string;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  try {
    const payload = verifyToken(token);
    (req as AuthRequest).userId = payload.sub;
    (req as Request & { userId?: string }).userId = payload.sub;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
