import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import { ConsoleLogger } from '../src/shared/logger';
import { DEFAULT_MODEL, canonicalModel, type ProxyModel } from '../src/application/observability/pricing';

/**
 * Add a model to the grant of every member who already has an explicit one.
 *
 * `DEFAULT_ALLOWED_MODELS` decides nothing for a member who has a
 * `MemberProxyPolicy` row naming models — the proxy reads the row and the
 * constant is never consulted. The Guardrails page writes a full row whenever
 * an admin saves anything on it, budget included, so the models that were
 * default on the day of that save are frozen into the row. Changing the
 * platform default therefore moves nobody who has ever been edited; this moves
 * them.
 *
 * Additive by construction: a model is appended, never removed, so a grant an
 * admin deliberately narrowed stays narrow in every other respect. A row that
 * already names the model is left untouched rather than rewritten, so
 * `updatedAt` keeps meaning "an admin changed this".
 *
 * Blocked members are skipped. `blocked` is the whole account, not a model
 * choice, and widening the catalogue of somebody who may not call the proxy at
 * all would only make the block harder to read later.
 *
 * Usage:
 *   pnpm tsx scripts/backfill-member-model-grants.ts                  # dry run
 *   pnpm tsx scripts/backfill-member-model-grants.ts --apply
 *   pnpm tsx scripts/backfill-member-model-grants.ts --apply --model gpt-5.6-luna
 *   pnpm tsx scripts/backfill-member-model-grants.ts --apply --company <companyId>
 */

const prisma = new PrismaClient();
const logger = new ConsoleLogger({ service: 'backfill-member-model-grants' });

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const companyFilter = argValue('--company');
  const requested = argValue('--model') ?? DEFAULT_MODEL;

  /*
   * Validated against the catalogue rather than trusted: a typo written into
   * 116 grants is a model nobody can run and no error anybody will see, since
   * an unknown id in an allow-list simply never matches.
   */
  const model = canonicalModel(requested) as ProxyModel;
  if (model !== requested) {
    throw new Error(`--model ${requested} is not a model in the catalogue`);
  }

  const rows = await prisma.memberProxyPolicy.findMany({
    where: {
      blocked: false,
      ...(companyFilter ? { companyId: companyFilter } : {}),
    },
    select: { id: true, userId: true, companyId: true, allowedModels: true },
  });

  const missing = rows.filter(
    row => row.allowedModels.length > 0 && !row.allowedModels.includes(model),
  );

  logger.info('backfill.scanned', {
    model,
    policies: rows.length,
    alreadyGranted: rows.length - missing.length,
    toUpdate: missing.length,
    apply,
  });

  if (!apply) {
    logger.info('backfill.dry_run', { hint: 're-run with --apply to write' });
    return;
  }

  let updated = 0;
  for (const row of missing) {
    await prisma.memberProxyPolicy.update({
      where: { id: row.id },
      data: { allowedModels: [...row.allowedModels, model] },
    });
    updated += 1;
  }

  logger.info('backfill.done', { model, updated });
}

main()
  .catch((error: unknown) => {
    logger.error('backfill.failed', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
