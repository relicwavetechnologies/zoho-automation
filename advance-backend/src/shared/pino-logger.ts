/**
 * PinoLogger — production-grade structured logger implementing the Logger port.
 *
 * Features over ConsoleLogger:
 *   - Sensitive key redaction: password, token, secret, authorization, cookie,
 *     api_key patterns never appear in output (masked as [REDACTED])
 *   - Log level from LOG_LEVEL env var (default 'info')
 *   - Dev mode: pretty-printed ANSI output via pino-pretty transport
 *   - Production mode: compact JSON (one line per log entry)
 *   - Child loggers inherit all parent bindings + add new ones
 *   - "event" field is always the first user-supplied field for easy scanning
 *
 * Usage in composition.ts:
 *   const logger = createPinoLogger({ isDev: env.NODE_ENV !== 'production', level: env.LOG_LEVEL });
 */

import pino from 'pino';
import type { Logger, LogLevel } from './logger';

// ─── Sensitive key patterns ────────────────────────────────────────────────────

/** Keys whose VALUES are always replaced with [REDACTED] in log output. */
const SENSITIVE_KEYS = [
  'password', 'passwd', 'pwd',
  'secret', 'apiSecret', 'api_secret',
  'token', 'accessToken', 'refreshToken', 'idToken', 'access_token', 'refresh_token', 'id_token',
  'authorization', 'Authorization',
  'cookie', 'Cookie',
  'apiKey', 'api_key', 'apikey',
  'privateKey', 'private_key',
  'oauthToken', 'oauth_token',
  'clientSecret', 'client_secret',
];

// ─── Factory ──────────────────────────────────────────────────────────────────

export interface PinoLoggerOptions {
  isDev:     boolean;
  level?:    LogLevel;
  service?:  string;
}

export function createPinoLogger(opts: PinoLoggerOptions): Logger {
  const level = opts.level ?? 'info';

  const transport = opts.isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize:        true,
          translateTime:   'SYS:HH:MM:ss.l',
          ignore:          'pid,hostname',
          messageKey:      'event',
          singleLine:      false,
        },
      }
    : undefined;

  const pinoInstance = pino({
    level,
    redact: {
      paths: SENSITIVE_KEYS.map(k => `*.${k}`).concat(SENSITIVE_KEYS),
      censor: '[REDACTED]',
    },
    ...(transport ? { transport } : {}),
  });

  const rootChild = opts.service
    ? pinoInstance.child({ service: opts.service })
    : pinoInstance;

  return new PinoLoggerAdapter(rootChild);
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

class PinoLoggerAdapter implements Logger {
  constructor(private readonly p: pino.Logger) {}

  debug(event: string, data?: Record<string, unknown>): void {
    this.p.debug({ ...data }, event);
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.p.info({ ...data }, event);
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.p.warn({ ...data }, event);
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.p.error({ ...data }, event);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new PinoLoggerAdapter(this.p.child(bindings));
  }
}
