import 'dotenv/config';

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const CONFIRMATION_FLAG = '--confirm-empty-database';
const BASELINE_PATH = 'prisma/baselines/20260803_current_schema.sql';
const INVARIANTS_PATH = 'prisma/sql/knowledge-invariants.sql';
const SCHEMA_PATH = 'prisma/schema.prisma';
const MIGRATIONS_PATH = 'prisma/migrations';

const GLOBAL_KNOWLEDGE_POLICY_SEED = String.raw`
WITH kinds(kind) AS (
  VALUES ('memory'::"KnowledgeResourceKind"), ('skill'::"KnowledgeResourceKind"), ('file'::"KnowledgeResourceKind")
), scopes(scope) AS (
  VALUES ('personal'::"KnowledgeResourceScope"), ('department'::"KnowledgeResourceScope"), ('company'::"KnowledgeResourceScope")
), actions(action) AS (
  VALUES ('create'::"KnowledgeMutationAction"), ('update'::"KnowledgeMutationAction"), ('publish'::"KnowledgeMutationAction"), ('delete'::"KnowledgeMutationAction")
)
INSERT INTO "KnowledgePolicy" (
  "id", "tenantKey", "kind", "scope", "action",
  "requesterReviewRequired", "requiredAuthority", "distinctApprover",
  "enabled", "version", "createdAt", "updatedAt"
)
SELECT
  'kp-global-' || kind::text || '-' || scope::text || '-' || action::text,
  'global', kind, scope, action,
  (scope <> 'personal' OR kind <> 'memory'),
  CASE scope
    WHEN 'department' THEN 'department_manager'::"KnowledgeApprovalAuthority"
    WHEN 'company' THEN 'company_admin'::"KnowledgeApprovalAuthority"
    ELSE 'none'::"KnowledgeApprovalAuthority"
  END,
  scope <> 'personal',
  true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM kinds CROSS JOIN scopes CROSS JOIN actions;
`;

// Prisma's datamodel diff does not emit CHECK constraints. These constraints
// are part of the privacy lifecycle migration that this bootstrap records as
// applied, so the blank-database path must restore them before doing so.
const SHOPIFY_PRIVACY_INVARIANTS = String.raw`
ALTER TABLE "ShopifyPrivacyRequest"
  ALTER COLUMN "orderIdHashes" SET NOT NULL,
  ADD CONSTRAINT "ShopifyPrivacyRequest_subject_check" CHECK (
    "state" IN ('expired', 'redacted')
    OR "customerIdHash" IS NOT NULL
    OR cardinality("orderIdHashes") > 0
  ),
  ADD CONSTRAINT "ShopifyPrivacyRequest_customer_hash_check" CHECK (
    "customerIdHash" IS NULL OR "customerIdHash" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "ShopifyPrivacyRequest_order_hashes_check" CHECK (
    cardinality("orderIdHashes") <= 250
    AND length(array_to_string("orderIdHashes", '')) = cardinality("orderIdHashes") * 64
    AND array_to_string("orderIdHashes", '') ~ '^[0-9a-f]*$'
  ),
  ADD CONSTRAINT "ShopifyPrivacyRequest_retention_check" CHECK (
    "expiresAt" >= "deadlineAt"
  ),
  ADD CONSTRAINT "ShopifyPrivacyRequest_export_check" CHECK (
    (
      "state" IN ('ready', 'delivered')
      AND "exportPayloadEncrypted" IS NOT NULL
      AND "exportCipherVersion" IS NOT NULL
    )
    OR
    (
      "state" NOT IN ('ready', 'delivered')
      AND "exportPayloadEncrypted" IS NULL
      AND "exportCipherVersion" IS NULL
    )
  ),
  ADD CONSTRAINT "ShopifyPrivacyRequest_failure_check" CHECK (
    ("state" = 'failed' AND "failureCode" IS NOT NULL)
    OR ("state" <> 'failed' AND "failureCode" IS NULL)
  ),
  ADD CONSTRAINT "ShopifyPrivacyRequest_delivery_check" CHECK (
    "state" <> 'delivered' OR "deliveredAt" IS NOT NULL
  ),
  ADD CONSTRAINT "ShopifyPrivacyRequest_redaction_check" CHECK (
    "state" <> 'redacted' OR "redactedAt" IS NOT NULL
  );
`;

export interface BootstrapOptions {
  readonly confirmed: boolean;
  readonly databaseUrl: string | undefined;
  readonly projectRoot: string;
}

export interface BootstrapDependencies {
  readonly readText: (path: string) => Promise<string>;
  readonly listMigrationNames: (path: string) => Promise<readonly string[]>;
  readonly generateCurrentBaseline: (options: BootstrapOptions) => Promise<string>;
  readonly executeTransactionalSql: (sql: string, options: BootstrapOptions) => Promise<void>;
  readonly runPnpm: (args: readonly string[], options: BootstrapOptions) => Promise<void>;
  readonly log: (message: string) => void;
}

export function parseBootstrapOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  projectRoot = resolve(__dirname, '..'),
): BootstrapOptions {
  const unknown = argv.filter(argument => argument !== CONFIRMATION_FLAG);
  if (unknown.length > 0) {
    throw new Error(`Unknown bootstrap argument: ${unknown[0]}`);
  }

  return {
    confirmed: argv.includes(CONFIRMATION_FLAG),
    databaseUrl: env['DATABASE_URL'],
    projectRoot,
  };
}

export function assertBootstrapTarget(options: BootstrapOptions): void {
  if (!options.confirmed) {
    throw new Error(`Refusing database mutation without ${CONFIRMATION_FLAG}.`);
  }
  if (!options.databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  let url: URL;
  try {
    url = new URL(options.databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('PostgreSQL DATABASE_URL must use postgres:// or postgresql://.');
  }
  if (!url.hostname || url.pathname === '' || url.pathname === '/') {
    throw new Error('DATABASE_URL must identify an explicit PostgreSQL host and database.');
  }
  const schema = url.searchParams.get('schema');
  if (schema && schema !== 'public') {
    throw new Error('Blank-database bootstrap supports only the public PostgreSQL schema.');
  }
}

export function buildTransactionalBootstrapSql(baseline: string, invariants: string): string {
  assertNoTransactionControl('baseline', baseline);
  assertNoTransactionControl('knowledge invariants', invariants);

  return String.raw`BEGIN;

DO $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('divo-empty-database-bootstrap', 0)) THEN
    RAISE EXCEPTION 'another blank-database bootstrap is running';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  ) THEN
    RAISE EXCEPTION 'public application schema is not empty';
  END IF;
END $$;

${baseline.trim()}

${invariants.trim()}

${SHOPIFY_PRIVACY_INVARIANTS.trim()}

${GLOBAL_KNOWLEDGE_POLICY_SEED.trim()}

COMMIT;
`;
}

export async function bootstrapEmptyDatabase(
  options: BootstrapOptions,
  dependencies: BootstrapDependencies = defaultDependencies,
): Promise<void> {
  assertBootstrapTarget(options);

  const [baseline, invariants, migrationNames, currentBaseline] = await Promise.all([
    dependencies.readText(resolve(options.projectRoot, BASELINE_PATH)),
    dependencies.readText(resolve(options.projectRoot, INVARIANTS_PATH)),
    dependencies.listMigrationNames(resolve(options.projectRoot, MIGRATIONS_PATH)),
    dependencies.generateCurrentBaseline(options),
  ]);
  if (migrationNames.length === 0) {
    throw new Error('No Prisma migrations were found; refusing to create an untracked baseline.');
  }
  if (normalizeSql(baseline) !== normalizeSql(currentBaseline)) {
    throw new Error(
      `Generated baseline is stale. Regenerate ${BASELINE_PATH} from the current Prisma schema before retrying.`,
    );
  }

  dependencies.log('Applying current-schema baseline to an empty database...');
  await dependencies.executeTransactionalSql(
    buildTransactionalBootstrapSql(baseline, invariants),
    options,
  );

  for (const migrationName of [...migrationNames].sort()) {
    dependencies.log(`Recording migration ${migrationName}...`);
    await dependencies.runPnpm([
      'exec',
      'prisma',
      'migrate',
      'resolve',
      '--applied',
      migrationName,
      '--schema',
      SCHEMA_PATH,
    ], options);
  }

  dependencies.log('Reconciling registered tools, skills, and capability grants...');
  await dependencies.runPnpm(['capabilities:reconcile'], options);

  dependencies.log('Verifying zero schema drift...');
  await dependencies.runPnpm([
    'exec',
    'prisma',
    'migrate',
    'diff',
    '--from-schema-datasource',
    SCHEMA_PATH,
    '--to-schema-datamodel',
    SCHEMA_PATH,
    '--exit-code',
  ], options);
  dependencies.log(`Blank-database bootstrap complete; ${migrationNames.length} migrations recorded.`);
}

function assertNoTransactionControl(label: string, sql: string): void {
  if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/imu.test(sql) || /^\s*\\/mu.test(sql)) {
    throw new Error(`${label} contains transaction or psql control statements.`);
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\r\n/g, '\n').trimEnd();
}

async function listMigrationNames(path: string): Promise<readonly string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^\d{8}[a-zA-Z0-9_-]*$/.test(entry.name)) {
      throw new Error(`Invalid Prisma migration directory: ${entry.name}`);
    }
    await readFile(resolve(path, entry.name, 'migration.sql'), 'utf8');
    names.push(entry.name);
  }
  return names.sort();
}

async function executeTransactionalSql(sql: string, options: BootstrapOptions): Promise<void> {
  const directory = await mkdtemp(resolve(tmpdir(), 'divo-empty-database-bootstrap-'));
  const sqlPath = resolve(directory, 'bootstrap.sql');
  try {
    await writeFile(sqlPath, sql, { encoding: 'utf8', mode: 0o600 });
    await run('pnpm', [
      'exec',
      'prisma',
      'db',
      'execute',
      '--file',
      sqlPath,
      '--schema',
      SCHEMA_PATH,
    ], options);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function generateCurrentBaseline(options: BootstrapOptions): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'divo-current-schema-baseline-'));
  const outputPath = resolve(directory, 'current-schema.sql');
  try {
    await run('pnpm', [
      'exec',
      'prisma',
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
      SCHEMA_PATH,
      '--script',
      '--output',
      outputPath,
    ], options);
    return await readFile(outputPath, 'utf8');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function run(command: string, args: readonly string[], options: BootstrapOptions): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.projectRoot,
      env: { ...process.env, DATABASE_URL: options.databaseUrl },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolvePromise();
      reject(new Error(
        `${command} command failed ${signal ? `with ${signal}` : `with code ${code ?? 'unknown'}`}.`,
      ));
    });
  });
}

const defaultDependencies: BootstrapDependencies = {
  readText: path => readFile(path, 'utf8'),
  listMigrationNames,
  generateCurrentBaseline,
  executeTransactionalSql,
  runPnpm: (args, options) => run('pnpm', args, options),
  log: message => console.log(message),
};

if (require.main === module) {
  bootstrapEmptyDatabase(parseBootstrapOptions(process.argv.slice(2), process.env)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
