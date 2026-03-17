import config from '../config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type LogOptions = {
  sampleRate?: number;
  always?: boolean;
};

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const SENSITIVE_KEY_PATTERNS = [
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'api_key',
  'apikey',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clampSampleRate = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
};

const parseLogLevel = (value: string): LogLevel => {
  if (value === 'debug' || value === 'warn' || value === 'error' || value === 'fatal') {
    return value;
  }
  return 'info';
};

const minimumLevel = parseLogLevel(config.LOG_LEVEL.toLowerCase());
const AI_ONLY_LOG_MODE = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.LOG_AI_ONLY ?? '').trim().toLowerCase(),
);
const AI_LOG_PREFIXES = [
  'vercel.',
  'desktop.chat.',
  'llm.',
  'tool.',
  'orchestration.engine.selection',
];

const redactSensitiveValue = (key: string, value: unknown): unknown => {
  const lowered = key.toLowerCase();
  if (SENSITIVE_KEY_PATTERNS.some((pattern) => lowered.includes(pattern))) {
    return '[REDACTED]';
  }
  return value;
};

const serializeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof Error) {
    const base: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };

    if (config.LOG_INCLUDE_STACK && typeof error.stack === 'string') {
      base.stack = error.stack;
    }

    const candidate = error as Error & { code?: string; cause?: unknown };
    if (typeof candidate.code === 'string') {
      base.code = candidate.code;
    }
    if (candidate.cause !== undefined) {
      base.cause = candidate.cause instanceof Error ? serializeError(candidate.cause) : candidate.cause;
    }

    return base;
  }

  return {
    message: typeof error === 'string' ? error : 'non_error_throwable',
    value: error,
  };
};

const sanitize = (value: unknown, depth = 0): unknown => {
  if (depth > 6) {
    return '[MaxDepthReached]';
  }

  if (value instanceof Error) {
    return serializeError(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1));
  }

  if (!isRecord(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const redacted = redactSensitiveValue(key, raw);
    next[key] = sanitize(redacted, depth + 1);
  }
  return next;
};

const shouldLog = (level: LogLevel, options?: LogOptions, randomFn: () => number = Math.random): boolean => {
  if (options?.always) {
    return true;
  }

  if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[minimumLevel]) {
    return false;
  }

  const sampleRate = clampSampleRate(options?.sampleRate ?? 1);
  if (sampleRate >= 1) {
    return true;
  }

  return randomFn() < sampleRate;
};

const shouldLogMessage = (message: string, options?: LogOptions): boolean => {
  if (!AI_ONLY_LOG_MODE) {
    return true;
  }

  if (options?.always) {
    return AI_LOG_PREFIXES.some((prefix) => message.startsWith(prefix));
  }

  return AI_LOG_PREFIXES.some((prefix) => message.startsWith(prefix));
};

// ─── Pretty dev formatter ────────────────────────────────────────────────────

const IS_DEV = config.NODE_ENV !== 'production';

// ANSI colour codes (no-op in prod)
const C = IS_DEV
  ? {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    debug: '\x1b[36m',   // cyan
    info: '\x1b[32m',    // green
    warn: '\x1b[33m',    // yellow
    error: '\x1b[31m',   // red
    fatal: '\x1b[35m',   // magenta
  }
  : ({} as Record<string, string>);

const levelBadge: Record<LogLevel, string> = IS_DEV
  ? {
    debug: `${C.debug}DBG${C.reset}`,
    info: `${C.info}INF${C.reset}`,
    warn: `${C.warn}WRN${C.reset}`,
    error: `${C.error}ERR${C.reset}`,
    fatal: `${C.fatal}FTL${C.reset}`,
  }
  : { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR', fatal: 'FTL' };

/** Flatten a meta object to "key=value key2=value2" – skips nested objects beyond depth 1. */
const flattenMeta = (meta: unknown): string => {
  if (!isRecord(meta)) {
    return String(meta);
  }
  return Object.entries(meta)
    .map(([k, v]) => {
      if (isRecord(v) || Array.isArray(v)) {
        return `${k}=${JSON.stringify(v)}`;
      }
      return `${k}=${String(v)}`;
    })
    .join('  ');
};

const hhmm = (): string => {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
};

const prettyLine = (level: LogLevel, message: string, meta?: unknown): string => {
  const time = IS_DEV ? `${C.dim}${hhmm()}${C.reset}` : hhmm();
  const badge = levelBadge[level];
  const msg = IS_DEV ? `${C.bold}${message}${C.reset}` : message;
  const metaPart = meta !== undefined ? `  ${C.dim ?? ''}${flattenMeta(meta)}${C.reset ?? ''}` : '';
  return `${time} ${badge} ${msg}${metaPart}`;
};

// ─── Emit ────────────────────────────────────────────────────────────────────

const emit = (level: LogLevel, message: string, meta?: unknown, options?: LogOptions): void => {
  if (!shouldLogMessage(message, options)) {
    return;
  }

  if (!shouldLog(level, options)) {
    return;
  }

  if (IS_DEV) {
    const line = prettyLine(level, message, meta !== undefined ? sanitize(meta) : undefined);
    if (level === 'error' || level === 'fatal') {
      // eslint-disable-next-line no-console
      console.error(line);
    } else if (level === 'warn') {
      // eslint-disable-next-line no-console
      console.warn(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
    return;
  }

  // Production: structured JSON (unchanged)
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
    pid: process.pid,
  };

  if (meta !== undefined) {
    payload.meta = sanitize(meta);
  }

  const line = JSON.stringify(payload);
  if (level === 'error' || level === 'fatal') {
    // eslint-disable-next-line no-console
    console.error(line);
    return;
  }

  if (level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(line);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(line);
};

export const logger = {
  debug: (message: string, meta?: unknown, options?: LogOptions) => emit('debug', message, meta, options),
  info: (message: string, meta?: unknown, options?: LogOptions) => emit('info', message, meta, options),
  warn: (message: string, meta?: unknown, options?: LogOptions) => emit('warn', message, meta, options),
  error: (message: string, meta?: unknown, options?: LogOptions) => emit('error', message, meta, options),
  fatal: (message: string, meta?: unknown, options?: LogOptions) => emit('fatal', message, meta, options),
  success: (message: string, meta?: unknown, options?: LogOptions) =>
    emit('info', message, meta, {
      sampleRate: options?.sampleRate ?? config.LOG_SUCCESS_SAMPLE_RATE,
      always: options?.always,
    }),
};

export const __test__ = {
  sanitize,
  clampSampleRate,
  shouldLog,
};
