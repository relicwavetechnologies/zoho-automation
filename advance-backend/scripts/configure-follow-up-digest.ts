import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';
import {
  nextRecurringRunAt,
  recurringScheduleSchema,
} from '../src/application/scheduling/recurring-schedule';
import { createLarkChatDestinationAuthorizer } from '../src/application/mail-ops/lark-chat-destination';
import { LarkMessagingClient } from '../src/infrastructure/channels/lark/clients/lark-messaging.client';
import { ConsoleLogger } from '../src/shared/logger';
import { ok, err } from '../src/shared/result';
import { LarkChatContextRepository } from '../src/infrastructure/persistence/lark-chat-context.repository';

/**
 * Point a department's follow-up digest at a Lark room.
 *
 * Everything that *reads* a `FollowUpDigest` was built with the rest of the
 * follow-ups feature — the claim, the card composer, the Lark send, the window
 * that `coveredThrough` moves on. Nothing wrote one, so the worker woke up,
 * found nothing due, and slept again. This is the missing writer.
 *
 * It is a script rather than a screen because a department names its digest
 * room once. When UA wants to change times without asking an engineer, this
 * becomes the API a settings panel calls; the vetting below is the part that
 * would move with it.
 *
 * The chat is vetted here as well as at delivery, and the two are not the same
 * check. `larkChatDeliveryAllowed` only refuses a room positively owned by
 * another company — the commonest mail destination, a member's own DM with
 * Divo, never has a directory row. The digest runner is stricter: it skips an
 * `unknown_chat` outright and reschedules, so a row created against a room Divo
 * has never seen a message in is a digest that quietly never delivers.
 *
 * Refused here for that reason. `--allow-unknown-chat` creates the row anyway,
 * for the case where the bot is demonstrably in the room and only needs one
 * message before Divo records it — but the runner will still skip until then.
 *
 * Usage:
 *   pnpm tsx scripts/configure-follow-up-digest.ts \
 *     --department Finance --chat oc_xxx --times 09:00,18:00 --days MO,TU,WE,TH,FR
 *   ... --dry-run          show what would be written, write nothing
 *   ... --pause            set status=paused instead of active
 */

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

const WEEKDAYS_MON_FRI = ['MO', 'TU', 'WE', 'TH', 'FR'];

async function main() {
  const chatId = argValue('--chat');
  const department = argValue('--department');
  const dryRun = process.argv.includes('--dry-run');
  const paused = process.argv.includes('--pause');
  const allowUnknownChat = process.argv.includes('--allow-unknown-chat');

  if (!chatId) throw new Error('Pass --chat <larkChatId>, e.g. --chat oc_1a2b3c');
  if (!department) throw new Error('Pass --department <name or id>');

  const schedule = recurringScheduleSchema.parse({
    times: (argValue('--times') ?? '09:00,18:00').split(',').map(s => s.trim()),
    days: (argValue('--days') ?? WEEKDAYS_MON_FRI.join(',')).split(',').map(s => s.trim().toUpperCase()),
    timeZone: argValue('--tz') ?? process.env.WHATSAPP_TIMEZONE ?? 'Asia/Kolkata',
  });

  const prisma = new PrismaClient();
  try {
    const dept = await prisma.department.findFirst({
      where: { OR: [{ id: department }, { name: department }] },
      select: { id: true, name: true, companyId: true },
    });
    if (!dept) {
      const all = await prisma.department.findMany({ select: { name: true, id: true } });
      throw new Error(
        `No department "${department}". Available: ${all.map(d => `${d.name} (${d.id})`).join(', ')}`,
      );
    }

    // The same guard Mail Ops uses, through the same repository. A second
    // implementation of this rule is exactly how one company's room stops
    // being refused.
    /*
     * The same two sources the digest runner consults, in the same order.
     *
     * Wired here as well because the point of vetting at creation is to refuse
     * a room the runner would refuse later — and an authorizer built with one
     * source here and two there is the drift that makes creation say yes to
     * something delivery says no to, or, as it did, the reverse.
     */
    const lark = new LarkMessagingClient({
      appId: process.env['LARK_APP_ID'] ?? '',
      appSecret: process.env['LARK_APP_SECRET'] ?? '',
      ...(process.env['LARK_API_BASE_URL'] ? { apiBaseUrl: process.env['LARK_API_BASE_URL'] } : {}),
      logger: new ConsoleLogger({ script: 'configure-follow-up-digest' }),
    });
    const authorize = createLarkChatDestinationAuthorizer(
      new LarkChatContextRepository(prisma),
      {
        botIsInChat: async chatId => {
          try {
            return ok(await lark.botIsInChat(chatId));
          } catch (error) {
            return err({ message: error instanceof Error ? error.message : String(error) });
          }
        },
      },
    );
    const verdict = await authorize({ companyId: dept.companyId, chatId });

    if (verdict.status === 'other_company') {
      throw new Error(
        `Lark chat ${chatId} belongs to a different Divo company on this Lark install. Refused.`,
      );
    }
    if (verdict.status === 'unavailable') {
      throw new Error(`Could not check the Lark chat: ${verdict.reason}`);
    }
    if (verdict.status === 'unknown_chat') {
      const note = `Divo's bot is not in Lark chat ${chatId}, and this company has `
        + 'never seen a message there.';
      const remedy = 'Add the Divo bot to that room, then re-run this. Membership is asked of\n'
        + 'Lark directly, so no message needs to be sent first.';
      if (!allowUnknownChat) {
        throw new Error(
          `${note}\n${remedy}\n`
          + 'Re-run after that, or pass --allow-unknown-chat to create the row now.',
        );
      }
      console.warn(
        `WARNING: ${note}\n`
        + 'The row is being created, but the digest runner skips an unrecognised room\n'
        + `and reschedules — it logs follow_up_digest.unknown_chat and sends nothing.\n${remedy}`,
      );
    }

    const status = paused ? 'paused' : 'active';
    // A paused digest carries no next slot: `claimDueDigests` filters on
    // `status: 'active'`, and leaving a stale time on a paused row would make
    // it fire the instant somebody re-activated it.
    const nextRunAt = status === 'active' ? nextRecurringRunAt(schedule, new Date()) : null;
    if (status === 'active' && !nextRunAt) {
      throw new Error('That schedule never fires in the next fourteen days. Check --days and --tz.');
    }

    const shape = {
      company: dept.companyId,
      department: `${dept.name} (${dept.id})`,
      chatId,
      times: schedule.times,
      days: schedule.days,
      timeZone: schedule.timeZone,
      status,
      nextRunAt: nextRunAt?.toISOString() ?? null,
    };

    if (dryRun) {
      console.log('would write:', JSON.stringify(shape, null, 2));
      return;
    }

    const row = await prisma.followUpDigest.upsert({
      where: {
        companyId_departmentId_larkChatId: {
          companyId: dept.companyId,
          departmentId: dept.id,
          larkChatId: chatId,
        },
      },
      create: {
        companyId: dept.companyId,
        departmentId: dept.id,
        larkChatId: chatId,
        timesJson: schedule.times,
        daysJson: schedule.days,
        timeZone: schedule.timeZone,
        status,
        nextRunAt,
      },
      // `coveredThrough` is deliberately not reset. Re-running this to change
      // the times must not make the next digest re-report everything the last
      // one already delivered.
      update: {
        timesJson: schedule.times,
        daysJson: schedule.days,
        timeZone: schedule.timeZone,
        status,
        nextRunAt,
      },
      select: { id: true, createdAt: true, updatedAt: true, coveredThrough: true },
    });

    const created = row.createdAt.getTime() === row.updatedAt.getTime();
    console.log(`${created ? 'created' : 'updated'} digest ${row.id}`);
    console.log(JSON.stringify(shape, null, 2));
    if (row.coveredThrough) {
      console.log(`covers follow-ups after ${row.coveredThrough.toISOString()}`);
    } else {
      console.log('first run reaches back 24 hours.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
