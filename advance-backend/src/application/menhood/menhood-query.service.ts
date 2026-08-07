import { performance } from 'node:perf_hooks';
import { Pool, type PoolConfig } from 'pg';

import type { TypedEnv } from '../../config/env';
import { ConsoleLogger, type Logger } from '../../shared/logger';
import {
  type MenhoodQueryErrorCode,
  type MenhoodQueryResult,
  MenhoodQueryValidationError,
  validateMenhoodQuery,
} from './menhood-query';
import type { DataExportPage } from '../data-export/data-export.types';

const PREVIEW_ROWS = 25;
const EXPORT_PAGE_ROWS = 1_000;
const EXPORT_CURSOR = 'menhood_export_cursor';

/**
 * Orders reach this reporting DB long after they are placed, and they keep
 * arriving for weeks. Measured over two independent settled cohorts:
 *
 *   order_date Mar 1 – Apr 15   68.2% of lines by day 7, 89.9% by day 14, 99.1% by day 30
 *   order_date May 1 – Jun 30   60.3% of lines by day 7, 78.9% by day 14, 95.3% by day 30
 *
 * So a window that ends inside the last month is undercounted, and silently:
 * the query succeeds and returns a number that reads as complete. That is more
 * dangerous than the empty result a current-week question returns, because
 * nothing about it looks wrong. Every result carries this window so the caller
 * can say which part of its answer is settled and which is still filling in.
 */
const MATURITY_DAYS = 30;
const COVERAGE_CACHE_MS = 10 * 60 * 1000;

export type MenhoodCoverageWindow = {
  /** Latest `order_date` present. Nothing after this exists yet, at any count. */
  readonly ordersThrough: string | null;
  /** On/before this date counts are ~fully settled; after it they undercount. */
  readonly maturedThrough: string;
  readonly maturityDays: number;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type MenhoodEnv = Pick<TypedEnv,
  | 'MENHOOD_ENABLED'
  | 'MENHOOD_DB_HOST'
  | 'MENHOOD_DB_PORT'
  | 'MENHOOD_DB_NAME'
  | 'MENHOOD_DB_USER'
  | 'MENHOOD_DB_PASSWORD'
  | 'MENHOOD_COMPANY_ID'
  | 'MENHOOD_DB_SSL_MODE'
  | 'MENHOOD_DB_SSL_CA_BASE64'
  | 'MENHOOD_DB_SSL_SERVER_NAME'
>;

type DriverResult = {
  fields: Array<{ name: string; dataTypeID: number }>;
  rows: unknown[][];
};

type MenhoodClient = {
  query(query: string | { text: string; values: unknown[]; rowMode: 'array' }): Promise<unknown>;
  release(): void;
};

type MenhoodPool = {
  connect(): Promise<MenhoodClient>;
  end(): Promise<void>;
  on?(event: 'error', listener: (error: unknown) => void): void;
};

export type MenhoodPoolFactory = (config: PoolConfig) => MenhoodPool;

export class MenhoodQueryServiceError extends Error {
  constructor(
    readonly code: Extract<MenhoodQueryErrorCode, 'timeout' | 'unavailable_connection' | 'provider_failure'>,
    message: string,
  ) {
    super(message);
    this.name = 'MenhoodQueryServiceError';
  }
}

export class MenhoodQueryService {
  private pool: MenhoodPool | undefined;
  private coverageCache: { window: MenhoodCoverageWindow; readAt: number } | undefined;

  constructor(
    private readonly env: MenhoodEnv,
    private readonly poolFactory: MenhoodPoolFactory | undefined = undefined,
    private readonly logger: Pick<Logger, 'error'> = new ConsoleLogger({ service: 'menhood-query' }),
    private readonly now: () => Date = () => new Date(),
  ) {}

  preflight(companyId: string): void {
    if (!this.env.MENHOOD_ENABLED || companyId !== this.env.MENHOOD_COMPANY_ID) {
      throw new MenhoodQueryServiceError('unavailable_connection', 'Menhood reporting is not available');
    }
  }

  async execute(companyId: string, input: unknown): Promise<MenhoodQueryResult> {
    this.preflight(companyId);
    const query = validateMenhoodQuery(input);
    const startedAt = performance.now();
    let client: MenhoodClient;

    try {
      client = await this.getPool().connect();
    } catch (error) {
      throw mapProviderError(error);
    }

    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '30s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
      const result = await client.query({
        text: `SELECT * FROM (${query.normalizedSql}) AS menhood_preview LIMIT ${PREVIEW_ROWS + 1}`,
        values: query.parameters,
        rowMode: 'array',
      }) as DriverResult;
      await client.query('COMMIT');

      const truncated = result.rows.length > PREVIEW_ROWS;
      const rows = result.rows.slice(0, PREVIEW_ROWS);
      const columns = uniqueColumnNames(result.fields);
      return {
        columns: result.fields.map((field, index) => ({
          name: columns[index]!,
          dataTypeId: field.dataTypeID,
        })),
        rows: rows.map(row => Object.fromEntries(
          columns.map((column, index) => [column, normalizeJson(row[index])]),
        )),
        coverage: { returnedRows: rows.length, truncated },
        elapsedMs: Math.max(0, performance.now() - startedAt),
        queryFingerprint: query.fingerprint,
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original, stable provider error.
      }
      throw mapProviderError(error);
    } finally {
      client.release();
    }
  }

  /**
   * Best effort by design: a freshness read must never turn a good answer into
   * a failed tool call, so any error here degrades to `ordersThrough: null`
   * rather than propagating.
   */
  async coverageWindow(companyId: string): Promise<MenhoodCoverageWindow> {
    this.preflight(companyId);
    const now = this.now();
    const maturedThrough = isoDate(new Date(now.getTime() - MATURITY_DAYS * 86_400_000));
    const cached = this.coverageCache;
    if (cached && now.getTime() - cached.readAt < COVERAGE_CACHE_MS) return cached.window;

    let ordersThrough: string | null = null;
    try {
      const client = await this.getPool().connect();
      try {
        const result = await client.query({
          text: 'SELECT max(order_date)::text AS orders_through FROM menhood_orders',
          values: [],
          rowMode: 'array',
        }) as DriverResult;
        const value = result.rows[0]?.[0];
        ordersThrough = typeof value === 'string' ? value : null;
      } finally {
        client.release();
      }
    } catch (error) {
      this.logger.error('menhood.coverage_window.failed', { error });
    }

    const window: MenhoodCoverageWindow = { ordersThrough, maturedThrough, maturityDays: MATURITY_DAYS };
    this.coverageCache = { window, readAt: now.getTime() };
    return window;
  }

  async *streamExportPages(
    companyId: string,
    input: unknown,
    expectedFingerprint: string,
    signal?: AbortSignal,
  ): AsyncIterable<DataExportPage> {
    this.preflight(companyId);
    const query = validateMenhoodQuery(input);
    if (query.fingerprint !== expectedFingerprint) {
      throw new MenhoodQueryValidationError('invalid_query', 'Menhood query fingerprint mismatch');
    }
    signal?.throwIfAborted();

    let client: MenhoodClient;
    try {
      client = await this.getPool().connect();
    } catch (error) {
      signal?.throwIfAborted();
      throw mapProviderError(error);
    }

    let cursorDeclared = false;
    let committed = false;
    try {
      signal?.throwIfAborted();
      await checkedQuery(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', signal);
      await checkedQuery(client, "SET LOCAL statement_timeout = '5min'", signal);
      await checkedQuery(client, "SET LOCAL lock_timeout = '2s'", signal);
      await checkedQuery(client, "SET LOCAL idle_in_transaction_session_timeout = '30s'", signal);
      signal?.throwIfAborted();
      await client.query({
        text: `DECLARE ${EXPORT_CURSOR} NO SCROLL CURSOR FOR ${query.normalizedSql}`,
        values: query.parameters,
        rowMode: 'array',
      });
      cursorDeclared = true;
      signal?.throwIfAborted();

      let carry: unknown[] | undefined;
      let fields: DriverResult['fields'] = [];
      for (;;) {
        const rows = carry ? [carry] : [];
        carry = undefined;
        const result = await checkedQuery(client, {
          text: `FETCH FORWARD ${EXPORT_PAGE_ROWS - rows.length} FROM ${EXPORT_CURSOR}`,
          values: [],
          rowMode: 'array',
        }, signal) as DriverResult;
        if (result.fields.length > 0) fields = result.fields;
        rows.push(...result.rows);
        if (rows.length === 0) break;
        if (rows.length === EXPORT_PAGE_ROWS) {
          const lookahead = await checkedQuery(client, {
            text: `FETCH FORWARD 1 FROM ${EXPORT_CURSOR}`,
            values: [],
            rowMode: 'array',
          }, signal) as DriverResult;
          carry = lookahead.rows[0];
        }
        const columns = uniqueColumnNames(fields);
        yield {
          rows: rows.map(row => Object.fromEntries(
            columns.map((column, index) => [column, normalizeJson(row[index])]),
          )),
          ...(carry ? { hasMore: true } : {}),
        };
        if (!carry) break;
      }

      await checkedQuery(client, `CLOSE ${EXPORT_CURSOR}`, signal);
      cursorDeclared = false;
      await checkedQuery(client, 'COMMIT', signal);
      committed = true;
    } catch (error) {
      signal?.throwIfAborted();
      throw mapProviderError(error);
    } finally {
      if (cursorDeclared) {
        try {
          await client.query(`CLOSE ${EXPORT_CURSOR}`);
        } catch {
          // Rollback below remains the authoritative cleanup path.
        }
      }
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original provider or cancellation error.
        }
      }
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.pool) return;
    const pool = this.pool;
    this.pool = undefined;
    await pool.end();
  }

  private getPool(): MenhoodPool {
    if (this.pool) return this.pool;

    const config: PoolConfig = {
      host: this.env.MENHOOD_DB_HOST,
      port: this.env.MENHOOD_DB_PORT,
      database: this.env.MENHOOD_DB_NAME,
      user: this.env.MENHOOD_DB_USER,
      password: this.env.MENHOOD_DB_PASSWORD,
      ssl: {
        rejectUnauthorized: true,
        ca: Buffer.from(this.env.MENHOOD_DB_SSL_CA_BASE64, 'base64').toString('utf8'),
        servername: this.env.MENHOOD_DB_SSL_SERVER_NAME,
      },
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
      allowExitOnIdle: true,
      application_name: 'divo-menhood-readonly',
    };
    const pool = this.poolFactory
      ? this.poolFactory(config)
      : new Pool(config) as unknown as MenhoodPool;
    pool.on?.('error', error => {
      this.logger.error('menhood.db.pool_error', safeErrorMetadata(error));
    });
    this.pool = pool;
    return this.pool;
  }
}

async function checkedQuery(
  client: MenhoodClient,
  query: string | { text: string; values: unknown[]; rowMode: 'array' },
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const result = await client.query(query);
  signal?.throwIfAborted();
  return result;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function uniqueColumnNames(fields: DriverResult['fields']): string[] {
  const used = new Set<string>();
  return fields.map((field, index) => {
    const cleaned = field.name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    const base = !cleaned || ['__proto__', 'constructor', 'prototype'].includes(cleaned.toLowerCase())
      ? `column_${index + 1}`
      : cleaned;
    let name = base;
    let suffix = 2;
    while (used.has(name.toLowerCase())) name = `${base}_${suffix++}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalizeJson(nested)]));
  }
  return null;
}

function mapProviderError(error: unknown): MenhoodQueryServiceError {
  if (error instanceof MenhoodQueryServiceError) return error;
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  if (code === '57014' || code === '55P03') {
    return new MenhoodQueryServiceError('timeout', 'Menhood query timed out');
  }
  if (
    code.startsWith('08')
    || ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', '57P01', '57P02', '57P03'].includes(code)
  ) {
    return new MenhoodQueryServiceError('unavailable_connection', 'Menhood database is unavailable');
  }
  return new MenhoodQueryServiceError('provider_failure', safeSqlFailureMessage(error, code));
}

function safeSqlFailureMessage(error: unknown, code: string): string {
  if (!['42703', '42702', '42P01'].includes(code)) return 'Menhood query failed';
  const message = error instanceof Error ? error.message : '';
  const safeMessage = message
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s."'_-]/g, '')
    .trim()
    .slice(0, 180);
  return safeMessage
    ? `Menhood SQL failed: ${safeMessage}. Use the Menhood schema map, then make at most one corrected retry.`
    : 'Menhood SQL failed. Use the Menhood schema map, then make at most one corrected retry.';
}

function safeErrorMetadata(error: unknown): Record<string, unknown> {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined;
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(code ? { errorCode: code } : {}),
    };
  }
  return {
    errorMessage: String(error),
    ...(code ? { errorCode: code } : {}),
  };
}
