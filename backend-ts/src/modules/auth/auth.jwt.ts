import jwt from 'jsonwebtoken';

import { config } from '../../config/env';
import { JwtPayload } from './auth.types';

export function createToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: '7d' });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwtSecret) as JwtPayload;
}
