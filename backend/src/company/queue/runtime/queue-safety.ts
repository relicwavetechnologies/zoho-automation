import { createHash } from 'crypto';

const DEFAULT_QUEUE_NAME = 'orchestration_queue';
const MAX_QUEUE_NAME_LENGTH = 64;
const MAX_JOB_ID_LENGTH = 128;

const sanitizeFragment = (input: string): string =>
  input
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? value.slice(0, maxLength) : value;

const stableHash = (value: string): string => createHash('sha1').update(value, 'utf8').digest('hex').slice(0, 12);

export const sanitizeQueueName = (name: string): string => {
  const normalized = sanitizeFragment(name);
  if (normalized.length === 0) {
    return DEFAULT_QUEUE_NAME;
  }
  return truncate(normalized, MAX_QUEUE_NAME_LENGTH);
};

export const buildSafeJobId = (...parts: Array<string | number>): string => {
  const rawParts = parts.map((part) => String(part));
  const normalized = rawParts.map(sanitizeFragment).filter((part) => part.length > 0).join('__');

  if (normalized.length > 0) {
    return truncate(normalized, MAX_JOB_ID_LENGTH);
  }

  const fallbackSeed = rawParts.join('__') || 'empty';
  return `job_${stableHash(fallbackSeed)}`;
};

const TRANSIENT_QUEUE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'NR_CLOSED',
]);

const TRANSIENT_QUEUE_ERROR_MARKERS = [
  'connection is closed',
  'connection lost',
  'read only',
  'readonly',
  'try again',
  'timed out',
  'max retries per request',
];

export const isTransientQueueInfraError = (error: unknown): boolean => {
  const candidate = error as {
    code?: string;
    message?: string;
    cause?: unknown;
  };

  if (typeof candidate?.code === 'string' && TRANSIENT_QUEUE_ERROR_CODES.has(candidate.code.toUpperCase())) {
    return true;
  }

  const message = typeof candidate?.message === 'string' ? candidate.message.toLowerCase() : '';
  if (TRANSIENT_QUEUE_ERROR_MARKERS.some((marker) => message.includes(marker))) {
    return true;
  }

  if (candidate?.cause) {
    return isTransientQueueInfraError(candidate.cause);
  }

  return false;
};

export class QueueTaskTimeoutError extends Error {
  readonly timeoutMs: number;

  readonly meta?: Record<string, unknown>;

  readonly code = 'QUEUE_TASK_TIMEOUT';

  constructor(timeoutMs: number, meta?: Record<string, unknown>) {
    super(`Queue task exceeded timeout of ${timeoutMs}ms`);
    this.name = 'QueueTaskTimeoutError';
    this.timeoutMs = timeoutMs;
    this.meta = meta;
  }
}

export const withTaskTimeout = async <T>(
  run: (abortSignal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  meta?: Record<string, unknown>,
  controller = new AbortController(),
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new QueueTaskTimeoutError(timeoutMs, meta));
    }, timeoutMs);

    run(controller.signal)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
