import type { NextFunction, Request, Response } from 'express';

import { ApiResponse } from '../core/api-response';
import { logger } from '../utils/logger';

type RateLimitConfig = {
  name: string;
  max: number;
  windowMs: number;
  message?: string;
  key: (req: Request) => string | null;
  skip?: (req: Request) => boolean;
};

type RedisAvailabilityConfig = {
  name: string;
  statusCode?: number;
  message?: string;
  skip?: (req: Request) => boolean;
};

type RateLimitBucket = {
  timestamps: number[];
};

const rateLimitState = new Map<string, RateLimitBucket>();

const readRequestId = (req: Request): string =>
  ((req as Request & { requestId?: string }).requestId ?? 'missing_request_id');

const toRetryAfterSeconds = (timestamps: number[], windowMs: number, now: number): number => {
  const oldest = timestamps[0];
  if (!Number.isFinite(oldest)) {
    return Math.max(1, Math.ceil(windowMs / 1000));
  }
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
};

const pruneBucket = (timestamps: number[], windowMs: number, now: number): number[] =>
  timestamps.filter((timestamp) => now - timestamp < windowMs);

const cleanupStaleBuckets = (now: number, windowMs: number): void => {
  if (rateLimitState.size <= 1_000) {
    return;
  }
  for (const [key, bucket] of rateLimitState.entries()) {
    const pruned = pruneBucket(bucket.timestamps, windowMs, now);
    if (pruned.length === 0) {
      rateLimitState.delete(key);
      continue;
    }
    bucket.timestamps = pruned;
  }
};

export const createRateLimitMiddleware = (config: RateLimitConfig) =>
  (req: Request, res: Response, next: NextFunction): void => {
    if (config.skip?.(req)) {
      next();
      return;
    }

    const key = config.key(req);
    if (!key) {
      next();
      return;
    }

    const now = Date.now();
    cleanupStaleBuckets(now, config.windowMs);
    const bucketKey = `${config.name}:${key}`;
    const current = rateLimitState.get(bucketKey) ?? { timestamps: [] };
    const timestamps = pruneBucket(current.timestamps, config.windowMs, now);

    if (timestamps.length >= config.max) {
      const retryAfterSeconds = toRetryAfterSeconds(timestamps, config.windowMs, now);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      logger.warn('http.rate_limit.exceeded', {
        limiter: config.name,
        path: req.originalUrl || req.url,
        requestId: readRequestId(req),
        retryAfterSeconds,
      });
      res.status(429).json(ApiResponse.error(config.message ?? 'Too many requests. Please try again shortly.'));
      return;
    }

    timestamps.push(now);
    rateLimitState.set(bucketKey, { timestamps });
    next();
  };

export const createRedisAvailabilityMiddleware = (config: RedisAvailabilityConfig) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (config.skip?.(req)) {
      next();
      return;
    }
    const { redisConnection } = await import('../company/queue/runtime/redis.connection');
    const health = await redisConnection.health(400);
    if (health.ok) {
      next();
      return;
    }

    logger.warn('http.redis.degraded', {
      guard: config.name,
      path: req.originalUrl || req.url,
      requestId: readRequestId(req),
      error: health.error ?? 'redis_unavailable',
    });

    res
      .status(config.statusCode ?? 503)
      .json(ApiResponse.error(config.message ?? 'This service is temporarily unavailable while runtime infrastructure recovers.'));
  };
