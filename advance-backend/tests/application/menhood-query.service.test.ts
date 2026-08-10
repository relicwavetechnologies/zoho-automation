import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PoolConfig } from 'pg';

import {
  MenhoodQueryService,
  MenhoodQueryServiceError,
  type MenhoodPoolFactory,
} from '../../src/application/menhood/menhood-query.service.ts';

const companyId = '9f9360aa-28d1-49df-919f-3b121b7403df';
const env = {
  MENHOOD_ENABLED: true,
  MENHOOD_DB_HOST: 'db.internal',
  MENHOOD_DB_PORT: 25_432,
  MENHOOD_DB_NAME: 'menhood',
  MENHOOD_DB_USER: 'reader',
  MENHOOD_DB_PASSWORD: 'private-password',
  MENHOOD_COMPANY_ID: companyId,
  MENHOOD_DB_SSL_MODE: 'require' as const,
  MENHOOD_DB_SSL_CA_BASE64: Buffer.from('-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n').toString('base64'),
  MENHOOD_DB_SSL_SERVER_NAME: 'db.internal',
};

type DriverResult = {
  fields: Array<{ name: string; dataTypeID: number }>;
  rows: unknown[][];
};

function harness(result: DriverResult | Error) {
  const calls: Array<string | { text: string; values: unknown[]; rowMode: 'array' }> = [];
  let released = 0;
  let ended = 0;
  let config: PoolConfig | undefined;
  const factory: MenhoodPoolFactory = poolConfig => {
    config = poolConfig;
    return {
      connect: async () => ({
        query: async query => {
          calls.push(query);
          if (typeof query !== 'string') {
            if (result instanceof Error) throw result;
            return result;
          }
          return {};
        },
        release: () => { released += 1; },
      }),
      end: async () => { ended += 1; },
    };
  };
  return {
    service: new MenhoodQueryService(env, factory),
    calls,
    get released() { return released; },
    get ended() { return ended; },
    get config() { return config; },
  };
}

describe('MenhoodQueryService', () => {
  it('fails closed while disabled or for any other company without creating a pool', async () => {
    let pools = 0;
    const factory: MenhoodPoolFactory = () => {
      pools += 1;
      throw new Error('must not run');
    };
    const disabled = new MenhoodQueryService({ ...env, MENHOOD_ENABLED: false }, factory);
    const enabled = new MenhoodQueryService(env, factory);

    for (const [service, id] of [[disabled, companyId], [enabled, 'other-company']] as const) {
      await assert.rejects(
        () => service.execute(id, { sql: 'SELECT * FROM menhood_orders' }),
        (error: MenhoodQueryServiceError) => error.code === 'unavailable_connection',
      );
    }
    assert.equal(pools, 0);
  });

  it('uses one small TLS pool and executes bound SQL in read-only transaction order', async () => {
    const test = harness({
      fields: [{ name: 'order_id', dataTypeID: 25 }],
      rows: [['order-1']],
    });

    const result = await test.service.execute(companyId, {
      sql: 'SELECT order_id FROM menhood_orders WHERE status = $1',
      parameters: ['paid'],
    });

    assert.deepEqual(test.calls.slice(0, 4), [
      'BEGIN READ ONLY',
      "SET LOCAL statement_timeout = '30s'",
      "SET LOCAL lock_timeout = '2s'",
      "SET LOCAL idle_in_transaction_session_timeout = '30s'",
    ]);
    assert.deepEqual(test.calls[4], {
      text: 'SELECT * FROM (SELECT order_id  FROM menhood_orders   WHERE (status = ($1))) AS menhood_preview LIMIT 26',
      values: ['paid'],
      rowMode: 'array',
    });
    assert.equal(test.calls[5], 'COMMIT');
    assert.equal(test.released, 1);
    assert.deepEqual(result.rows, [{ order_id: 'order-1' }]);
    assert.equal(test.config?.max, 2);
    assert.deepEqual(test.config?.ssl, {
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n',
      servername: 'db.internal',
    });
    assert.equal('connectionString' in (test.config ?? {}), false);

    await test.service.close();
    assert.equal(test.ended, 1);
  });

  it('logs structured details for an idle pool error', async () => {
    let poolErrorHandler: ((error: unknown) => void) | undefined;
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const service = new MenhoodQueryService(
      env,
      () => ({
        on: (_event, handler) => { poolErrorHandler = handler; },
        connect: async () => ({
          query: async query => typeof query === 'string'
            ? {}
            : { fields: [], rows: [] },
          release: () => {},
        }),
        end: async () => {},
      }),
      { error: (event, data) => { events.push({ event, data }); } },
    );

    await service.execute(companyId, { sql: 'SELECT 1' });
    poolErrorHandler?.(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));

    assert.deepEqual(events, [{
      event: 'menhood.db.pool_error',
      data: {
        errorName: 'Error',
        errorMessage: 'connection reset',
        errorCode: 'ECONNRESET',
      },
    }]);
  });

  it('reads the 26th row only to report truncation', async () => {
    const test = harness({
      fields: [{ name: 'id', dataTypeID: 23 }],
      rows: Array.from({ length: 26 }, (_, index) => [index + 1]),
    });

    const result = await test.service.execute(companyId, { sql: 'SELECT id FROM menhood_products' });

    assert.equal(result.rows.length, 25);
    assert.deepEqual(result.coverage, { returnedRows: 25, truncated: true });
  });

  it('returns safe unique columns and JSON-safe values without precision loss', async () => {
    const test = harness({
      fields: [
        { name: 'value', dataTypeID: 20 },
        { name: 'Value', dataTypeID: 1184 },
        { name: '__proto__', dataTypeID: 17 },
        { name: '', dataTypeID: 114 },
      ],
      rows: [[
        9_007_199_254_740_993n,
        new Date('2026-08-03T05:30:00.000Z'),
        Buffer.from('ok'),
        { amount: 12n, missing: undefined, invalid: Number.POSITIVE_INFINITY },
      ]],
    });

    const result = await test.service.execute(companyId, { sql: 'SELECT * FROM menhood_orders' });

    assert.deepEqual(result.columns.map(column => column.name), ['value', 'Value_2', 'column_3', 'column_4']);
    assert.deepEqual(result.rows, [{
      value: '9007199254740993',
      Value_2: '2026-08-03T05:30:00.000Z',
      column_3: 'b2s=',
      column_4: { amount: '12', missing: null, invalid: null },
    }]);
  });

  it('maps timeout errors and always rolls back and releases', async () => {
    const timeout = Object.assign(new Error('cancelled by statement timeout'), { code: '57014' });
    const test = harness(timeout);

    await assert.rejects(
      () => test.service.execute(companyId, { sql: 'SELECT * FROM menhood_customers' }),
      (error: MenhoodQueryServiceError) => error.code === 'timeout' && error.message === 'Menhood query timed out',
    );
    assert.equal(test.calls.at(-1), 'ROLLBACK');
    assert.equal(test.released, 1);
  });

  it('uses stable unavailable and provider failure codes', async () => {
    const unavailableFactory: MenhoodPoolFactory = () => ({
      connect: async () => { throw Object.assign(new Error('connection details'), { code: 'ECONNREFUSED' }); },
      end: async () => {},
    });
    const unavailable = new MenhoodQueryService(env, unavailableFactory);
    await assert.rejects(
      () => unavailable.execute(companyId, { sql: 'SELECT * FROM menhood_orders' }),
      (error: MenhoodQueryServiceError) => error.code === 'unavailable_connection'
        && error.message === 'Menhood database is unavailable',
    );

    const failed = harness(new Error('contains internal provider detail'));
    await assert.rejects(
      () => failed.service.execute(companyId, { sql: 'SELECT * FROM menhood_orders' }),
      (error: MenhoodQueryServiceError) => error.code === 'provider_failure'
        && error.message === 'Menhood query failed',
    );
    assert.equal(failed.calls.at(-1), 'ROLLBACK');
    assert.equal(failed.released, 1);
  });

  it('surfaces sanitized schema SQL failures so the model can correct once instead of looping', async () => {
    const undefinedColumn = Object.assign(new Error('column "name" does not exist'), { code: '42703' });
    const test = harness(undefinedColumn);

    await assert.rejects(
      () => test.service.execute(companyId, { sql: 'SELECT name FROM menhood_customers' }),
      (error: MenhoodQueryServiceError) => error.code === 'provider_failure'
        && error.message.includes('column "name" does not exist')
        && error.message.includes('Use the Menhood schema map')
        && error.message.includes('at most one corrected retry'),
    );
    assert.equal(test.calls.at(-1), 'ROLLBACK');
    assert.equal(test.released, 1);
  });

});
