import 'dotenv/config';
import { Queue } from 'bullmq';
import { PrismaClient } from '../src/generated/prisma';
import { retireDataExportCapability } from '../src/application/skills/retired-data-export-capability';

const QUEUE_NAME = 'data-export';
const APPLY_CONFIRMATION = 'delete-retired-data-export-storage';
const TABLES = [
  'DataExportPlan',
  'DataExportCandidate',
  'DataExportOffer',
  'DataExportDestinationPreference',
] as const;
const BLOCKING_QUEUE_STATES = [
  'active',
  'waiting',
  'delayed',
  'paused',
  'prioritized',
  'waiting-children',
] as const;

type QueueCounts = Readonly<Record<string, number>>;

export function blockingDataExportJobs(counts: QueueCounts): number {
  return BLOCKING_QUEUE_STATES.reduce((total, state) => total + (counts[state] ?? 0), 0);
}

export function dataExportRetirementProbeExitCode(
  tableRows: Readonly<Record<string, number | 'absent'>>,
  queueCounts: QueueCounts,
): 0 | 3 | 4 {
  if (blockingDataExportJobs(queueCounts) > 0) return 4;
  const storageExists = Object.values(tableRows).some(count => count !== 'absent');
  const queueExists = Object.values(queueCounts).some(count => count > 0);
  return storageExists || queueExists ? 0 : 3;
}

export function retiredDataExportDropSql(): string {
  return `DROP TABLE IF EXISTS ${TABLES.map(table => `"${table}"`).join(', ')}`;
}

export async function inspectRetiredDataExportStorage(prisma: PrismaClient) {
  const tableRows: Record<string, number | 'absent'> = {};
  for (const table of TABLES) {
    const exists = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      'SELECT to_regclass($1) IS NOT NULL AS exists',
      `public."${table}"`,
    );
    if (!exists[0]?.exists) {
      tableRows[table] = 'absent';
      continue;
    }
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) AS count FROM "${table}"`,
    );
    tableRows[table] = Number(rows[0]?.count ?? 0n);
  }
  return tableRows;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const needsApplyOnly = process.argv.includes('--needs-apply');
  if (apply && needsApplyOnly) throw new Error('Choose either --apply or --needs-apply.');
  if (apply && process.env.DATA_EXPORT_RETIRE_CONFIRM !== APPLY_CONFIRMATION) {
    throw new Error(
      `Refusing destructive retirement. Set DATA_EXPORT_RETIRE_CONFIRM=${APPLY_CONFIRMATION}.`,
    );
  }

  const redisUrl = process.env.REDIS_QUEUE_URL;
  if (!redisUrl) throw new Error('REDIS_QUEUE_URL is required to inspect the retired queue.');

  const prisma = new PrismaClient();
  const queue = new Queue(QUEUE_NAME, { connection: { url: redisUrl } });
  try {
    const [tableRows, queueCounts] = await Promise.all([
      inspectRetiredDataExportStorage(prisma),
      queue.getJobCounts(),
    ]);
    if (needsApplyOnly) {
      process.exitCode = dataExportRetirementProbeExitCode(tableRows, queueCounts);
      return;
    }
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'inspect', tableRows, queueCounts }, null, 2));

    if (!apply) return;
    const blockingJobs = blockingDataExportJobs(queueCounts);
    if (blockingJobs > 0) {
      throw new Error(
        `Refusing retirement while ${blockingJobs} legacy export job(s) are active or queued. `
        + 'Let them finish or cancel them explicitly, then retry.',
      );
    }

    await retireDataExportCapability(prisma);
    await queue.pause();
    await queue.obliterate({ force: false });
    await prisma.$executeRawUnsafe(retiredDataExportDropSql());
    console.log(JSON.stringify({ retired: true, queue: QUEUE_NAME, tables: TABLES }));
  } finally {
    await Promise.allSettled([queue.close(), prisma.$disconnect()]);
  }
}

if (process.argv[1]?.endsWith('retire-data-export-storage.ts')) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
