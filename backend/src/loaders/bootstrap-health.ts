import { logger } from '../utils/logger';

export type BootstrapCheckName = 'database' | 'redis';

export type BootstrapCheckResult = {
  name: BootstrapCheckName;
  ok: boolean;
  durationMs: number;
  error?: string;
};

type BootstrapCheck = {
  name: BootstrapCheckName;
  run: () => Promise<void>;
};

type BootstrapLog = Pick<typeof logger, 'info' | 'error' | 'fatal'>;

type BootstrapHealthOptions = {
  checks?: BootstrapCheck[];
  now?: () => number;
  log?: BootstrapLog;
};

export class BootstrapHealthError extends Error {
  readonly results: BootstrapCheckResult[];

  constructor(results: BootstrapCheckResult[]) {
    const failedChecks = results.filter((result) => !result.ok).map((result) => result.name);
    super(`Bootstrap health checks failed: ${failedChecks.join(', ')}`);
    this.name = 'BootstrapHealthError';
    this.results = results;
  }
}

const defaultChecks = (): BootstrapCheck[] => [
  {
    name: 'database',
    run: async () => {
      const { prisma } = await import('../utils/prisma');
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1`;
    },
  },
  {
    name: 'redis',
    run: async () => {
      const {
        queueRedisConnection,
        stateRedisConnection,
        cacheRedisConnection,
      } = await import('../company/queue/runtime/redis.connection');
      await Promise.all([
        queueRedisConnection.getClient().ping(),
        stateRedisConnection.getClient().ping(),
        cacheRedisConnection.getClient().ping(),
      ]);
    },
  },
];

export const runBootstrapHealthChecks = async (options: BootstrapHealthOptions = {}): Promise<BootstrapCheckResult[]> => {
  const checks = options.checks ?? defaultChecks();
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? logger;

  log.info(
    'bootstrap.health.start',
    {
      checks: checks.map((check) => check.name),
    },
    { always: true },
  );

  const results: BootstrapCheckResult[] = [];

  for (const check of checks) {
    const startedAt = now();
    try {
      await check.run();
      const durationMs = Math.max(0, Number((now() - startedAt).toFixed(2)));
      const result: BootstrapCheckResult = {
        name: check.name,
        ok: true,
        durationMs,
      };
      results.push(result);
      log.info('bootstrap.health.check.ok', result, { always: true });
    } catch (error) {
      const durationMs = Math.max(0, Number((now() - startedAt).toFixed(2)));
      const result: BootstrapCheckResult = {
        name: check.name,
        ok: false,
        durationMs,
        error: error instanceof Error ? error.message : 'unknown_error',
      };
      results.push(result);
      log.error('bootstrap.health.check.failed', result, { always: true });
    }
  }

  if (results.some((result) => !result.ok)) {
    log.fatal('bootstrap.health.failed', { results }, { always: true });
    throw new BootstrapHealthError(results);
  }

  return results;
};
