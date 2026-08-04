import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertBootstrapTarget,
  bootstrapEmptyDatabase,
  buildTransactionalBootstrapSql,
  parseBootstrapOptions,
  type BootstrapDependencies,
} from '../../scripts/bootstrap-empty-database';

const OPTIONS = {
  confirmed: true,
  databaseUrl: 'postgresql://bootstrap:secret@127.0.0.1:5432/divo_empty?schema=public',
  projectRoot: '/workspace/advance-backend',
} as const;

describe('blank database bootstrap', () => {
  it('requires explicit confirmation and a concrete PostgreSQL database', () => {
    assert.throws(
      () => assertBootstrapTarget({ ...OPTIONS, confirmed: false }),
      /--confirm-empty-database/,
    );
    assert.throws(
      () => assertBootstrapTarget({ ...OPTIONS, databaseUrl: 'mysql://localhost/divo' }),
      /PostgreSQL/,
    );
    assert.throws(
      () => assertBootstrapTarget({ ...OPTIONS, databaseUrl: 'postgresql://localhost' }),
      /explicit PostgreSQL host and database/,
    );
    assert.throws(
      () => assertBootstrapTarget({ ...OPTIONS, databaseUrl: 'postgresql://localhost/divo?schema=tenant' }),
      /only the public PostgreSQL schema/,
    );
  });

  it('rejects unknown command-line arguments', () => {
    assert.throws(
      () => parseBootstrapOptions(['--force'], { DATABASE_URL: OPTIONS.databaseUrl }, OPTIONS.projectRoot),
      /Unknown bootstrap argument/,
    );
  });

  it('wraps locking, emptiness validation, baseline, invariants, and policy seed in one transaction', () => {
    const sql = buildTransactionalBootstrapSql(
      'CREATE TABLE "Example" ("id" text PRIMARY KEY);',
      'ALTER TABLE "Example" ADD CONSTRAINT "id_nonempty" CHECK (length("id") > 0);',
    );

    assert.match(sql, /^BEGIN;/);
    assert.match(sql, /pg_try_advisory_xact_lock/);
    assert.match(sql, /public application schema is not empty/);
    assert.match(sql, /CREATE TABLE "Example"/);
    assert.match(sql, /ADD CONSTRAINT "id_nonempty"/);
    assert.match(sql, /ShopifyPrivacyRequest_customer_hash_check/);
    assert.match(sql, /"state" IN \('expired', 'redacted'\)[\s\S]*OR "customerIdHash" IS NOT NULL/);
    assert.match(sql, /ALTER COLUMN "orderIdHashes" SET NOT NULL/);
    assert.match(sql, /INSERT INTO "KnowledgePolicy"/);
    assert.match(sql, /FROM kinds CROSS JOIN scopes CROSS JOIN actions/);
    assert.match(sql, /COMMIT;\s*$/);
    assert.ok(sql.indexOf('pg_try_advisory_xact_lock') < sql.indexOf('CREATE TABLE "Example"'));
  });

  it('rejects nested transaction and psql control statements', () => {
    assert.throws(
      () => buildTransactionalBootstrapSql('BEGIN;', 'SELECT 1;'),
      /baseline contains transaction or psql control/,
    );
    assert.throws(
      () => buildTransactionalBootstrapSql('SELECT 1;', '\\connect other'),
      /knowledge invariants contains transaction or psql control/,
    );
  });

  it('applies the baseline before resolving migrations, then reconciles and checks drift', async () => {
    const calls: string[] = [];
    const dependencies: BootstrapDependencies = {
      readText: async path => path.endsWith('current_schema.sql') ? 'CREATE TABLE "Example" ("id" text);' : 'SELECT 1;',
      listMigrationNames: async () => ['20260803_shopify_privacy_lifecycle', '20260506_first'],
      generateCurrentBaseline: async () => {
        calls.push('baseline-current');
        return 'CREATE TABLE "Example" ("id" text);';
      },
      executeTransactionalSql: async sql => {
        assert.match(sql, /CREATE TABLE "Example"/);
        calls.push('baseline');
      },
      runPnpm: async args => { calls.push(args.join(' ')); },
      log: () => undefined,
    };

    await bootstrapEmptyDatabase(OPTIONS, dependencies);

    assert.deepEqual(calls, [
      'baseline-current',
      'baseline',
      'exec prisma migrate resolve --applied 20260506_first --schema prisma/schema.prisma',
      'exec prisma migrate resolve --applied 20260803_shopify_privacy_lifecycle --schema prisma/schema.prisma',
      'capabilities:reconcile',
      'exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code',
    ]);
  });

  it('never resolves a migration when transactional baseline application fails', async () => {
    let commandRan = false;
    const dependencies: BootstrapDependencies = {
      readText: async () => 'SELECT 1;',
      listMigrationNames: async () => ['20260506_first'],
      generateCurrentBaseline: async () => 'SELECT 1;',
      executeTransactionalSql: async () => { throw new Error('schema is not empty'); },
      runPnpm: async () => { commandRan = true; },
      log: () => undefined,
    };

    await assert.rejects(() => bootstrapEmptyDatabase(OPTIONS, dependencies), /schema is not empty/);
    assert.equal(commandRan, false);
  });

  it('stops at the first failed migration resolution and does not reconcile', async () => {
    const commands: string[] = [];
    const dependencies: BootstrapDependencies = {
      readText: async () => 'SELECT 1;',
      listMigrationNames: async () => ['20260506_first', '20260529_second'],
      generateCurrentBaseline: async () => 'SELECT 1;',
      executeTransactionalSql: async () => undefined,
      runPnpm: async args => {
        const command = args.join(' ');
        commands.push(command);
        if (command.includes('20260506_first')) throw new Error('resolve failed');
      },
      log: () => undefined,
    };

    await assert.rejects(() => bootstrapEmptyDatabase(OPTIONS, dependencies), /resolve failed/);
    assert.deepEqual(commands, [
      'exec prisma migrate resolve --applied 20260506_first --schema prisma/schema.prisma',
    ]);
  });

  it('refuses to proceed when migration history is absent', async () => {
    let baselineRan = false;
    const dependencies: BootstrapDependencies = {
      readText: async () => 'SELECT 1;',
      listMigrationNames: async () => [],
      generateCurrentBaseline: async () => 'SELECT 1;',
      executeTransactionalSql: async () => { baselineRan = true; },
      runPnpm: async () => undefined,
      log: () => undefined,
    };

    await assert.rejects(() => bootstrapEmptyDatabase(OPTIONS, dependencies), /No Prisma migrations/);
    assert.equal(baselineRan, false);
  });

  it('rejects a stale generated baseline before touching the database', async () => {
    let baselineRan = false;
    const dependencies: BootstrapDependencies = {
      readText: async path => path.endsWith('current_schema.sql') ? 'SELECT 1;' : 'SELECT 2;',
      listMigrationNames: async () => ['20260803_shopify_privacy_lifecycle'],
      generateCurrentBaseline: async () => 'SELECT 3;',
      executeTransactionalSql: async () => { baselineRan = true; },
      runPnpm: async () => undefined,
      log: () => undefined,
    };

    await assert.rejects(() => bootstrapEmptyDatabase(OPTIONS, dependencies), /baseline is stale/);
    assert.equal(baselineRan, false);
  });
});
