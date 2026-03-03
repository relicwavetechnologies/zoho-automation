import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Request, Response } from 'express';

import { config } from '../../config/env';
import { AppHttpError } from '../../middlewares/error.middleware';
import { sendPasswordResetEmail } from '../../utils/mailer';
import { prisma } from '../../utils/prisma';

const REQUEST_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const REQUEST_LIMIT_MAX = 5;
const INVALID_CONFIRM_WINDOW_MS = 15 * 60 * 1000;
const INVALID_CONFIRM_MAX = 10;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

const requestRateLimit = new Map<string, { count: number; resetAt: number }>();
const invalidConfirmRateLimit = new Map<string, { count: number; resetAt: number }>();

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hitRateLimit(map: Map<string, { count: number; resetAt: number }>, key: string, windowMs: number) {
  const now = Date.now();
  const current = map.get(key);
  if (!current || current.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  current.count += 1;
  map.set(key, current);
  return false;
}

function isRateLimited(map: Map<string, { count: number; resetAt: number }>, key: string, max: number) {
  const current = map.get(key);
  if (!current) return false;
  if (current.resetAt <= Date.now()) {
    map.delete(key);
    return false;
  }
  return current.count > max;
}

export async function requestPasswordReset(req: Request, res: Response) {
  const ip = req.ip || 'unknown';
  hitRateLimit(requestRateLimit, ip, REQUEST_LIMIT_WINDOW_MS);

  if (isRateLimited(requestRateLimit, ip, REQUEST_LIMIT_MAX)) {
    return res.status(200).json({
      message: 'If an account exists, a reset link has been sent.',
    });
  }

  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.status(200).json({
      message: 'If an account exists, a reset link has been sent.',
    });
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });

  if (user) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await prisma.passwordResetToken.updateMany({
      where: { user_id: user.id, used_at: null },
      data: { used_at: new Date() },
    });

    await prisma.passwordResetToken.create({
      data: {
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: expiresAt,
      },
    });

    const resetUrl = new URL('/reset-password', config.appBaseUrl);
    resetUrl.searchParams.set('token', rawToken);

    await sendPasswordResetEmail({
      to: user.email,
      resetLink: resetUrl.toString(),
      expiresInMinutes: Math.floor(RESET_TOKEN_TTL_MS / 60000),
    });
  }

  return res.status(200).json({
    message: 'If an account exists, a reset link has been sent.',
  });
}

export async function confirmPasswordReset(req: Request, res: Response) {
  const ip = req.ip || 'unknown';
  hitRateLimit(invalidConfirmRateLimit, ip, INVALID_CONFIRM_WINDOW_MS);

  if (isRateLimited(invalidConfirmRateLimit, ip, INVALID_CONFIRM_MAX)) {
    throw new AppHttpError(400, 'invalid_reset_token');
  }

  const token = String(req.body?.token ?? '').trim();
  const newPassword = String(req.body?.new_password ?? '').trim();

  if (!token || newPassword.length < 8) {
    throw new AppHttpError(400, 'validation_error');
  }

  const tokenHash = hashToken(token);
  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { token_hash: tokenHash },
    include: { user: true },
  });

  if (!resetToken || resetToken.used_at) {
    throw new AppHttpError(400, 'invalid_reset_token');
  }

  if (resetToken.expires_at.getTime() < Date.now()) {
    await prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { used_at: new Date() },
    });
    throw new AppHttpError(400, 'expired_reset_token');
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: resetToken.user_id },
      data: {
        password_hash: passwordHash,
        last_password_change_at: new Date(),
      },
    }),
    prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { used_at: new Date() },
    }),
  ]);

  return res.status(200).json({ status: 'success' });
}
