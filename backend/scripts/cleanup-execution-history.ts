import 'dotenv/config';

import { PrismaClient } from '../src/generated/prisma';

type CleanupOptions = {
  apply: boolean;
  olderThanDays: number;
  statuses: string[];
  companyId?: string;
  userId?: string;
  limit?: number;
  chunkSize: number;
};

const DEFAULT_STATUSES = ['completed', 'failed', 'cancelled'];
const DEFAULT_OLDER_THAN_DAYS = 14;
const DEFAULT_CHUNK_SIZE = 200;

const readArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  const matched = process.argv.find((entry) => entry.startsWith(prefix));
  return matched ? matched.slice(prefix.length).trim() : undefined;
};

const hasFlag = (name: string): boolean =>
  process.argv.includes(`--${name}`);

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const summarizeDate = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const options: CleanupOptions = {
    apply: hasFlag('apply'),
    olderThanDays: parsePositiveInt(readArg('older-than-days'), DEFAULT_OLDER_THAN_DAYS),
    statuses: (readArg('statuses') ?? DEFAULT_STATUSES.join(','))
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    companyId: readArg('company-id'),
    userId: readArg('user-id'),
    limit: readArg('limit') ? parsePositiveInt(readArg('limit'), 0) : undefined,
    chunkSize: parsePositiveInt(readArg('chunk-size'), DEFAULT_CHUNK_SIZE),
  };

  if (options.statuses.length === 0) {
    throw new Error('Provide at least one status via --statuses=');
  }

  const cutoff = new Date(Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000);
  const where = {
    status: { in: options.statuses },
    startedAt: { lt: cutoff },
    ...(options.companyId ? { companyId: options.companyId } : {}),
    ...(options.userId ? { userId: options.userId } : {}),
  } as const;

  const candidates = await prisma.executionRun.findMany({
    where,
    orderBy: { startedAt: 'asc' },
    take: options.limit,
    select: {
      id: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      companyId: true,
      userId: true,
      latestSummary: true,
      _count: {
        select: {
          events: true,
        },
      },
    },
  });

  const candidateIds = candidates.map((row) => row.id);
  const linkedWorkflowRuns = candidateIds.length === 0
    ? 0
    : await prisma.scheduledWorkflowRun.count({
      where: {
        executionRunId: {
          in: candidateIds,
        },
      },
    });

  const summary = {
    mode: options.apply ? 'apply' : 'dry-run',
    cutoff: cutoff.toISOString(),
    statuses: options.statuses,
    companyId: options.companyId ?? null,
    userId: options.userId ?? null,
    candidateRuns: candidates.length,
    candidateEvents: candidates.reduce((sum, row) => sum + row._count.events, 0),
    linkedWorkflowRuns,
    oldestStartedAt: summarizeDate(candidates[0]?.startedAt),
    newestStartedAt: summarizeDate(candidates[candidates.length - 1]?.startedAt),
    sample: candidates.slice(0, 10).map((row) => ({
      id: row.id,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      finishedAt: summarizeDate(row.finishedAt),
      eventCount: row._count.events,
      latestSummary: row.latestSummary?.slice(0, 180) ?? null,
    })),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!options.apply || candidateIds.length === 0) {
    console.log(options.apply
      ? 'No matching execution history rows to delete.'
      : 'Dry run only. Re-run with --apply to delete these execution rows.');
    return;
  }

  let deletedRuns = 0;
  let clearedWorkflowLinks = 0;

  for (let index = 0; index < candidateIds.length; index += options.chunkSize) {
    const chunkIds = candidateIds.slice(index, index + options.chunkSize);
    const result = await prisma.$transaction(async (tx) => {
      const cleared = await tx.scheduledWorkflowRun.updateMany({
        where: {
          executionRunId: {
            in: chunkIds,
          },
        },
        data: {
          executionRunId: null,
        },
      });

      const deleted = await tx.executionRun.deleteMany({
        where: {
          id: {
            in: chunkIds,
          },
        },
      });

      return {
        cleared: cleared.count,
        deleted: deleted.count,
      };
    });

    clearedWorkflowLinks += result.cleared;
    deletedRuns += result.deleted;
  }

  console.log(JSON.stringify({
    deletedRuns,
    deletedEvents: summary.candidateEvents,
    clearedWorkflowLinks,
  }, null, 2));
}

main()
  .catch(async (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
