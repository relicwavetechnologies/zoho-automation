import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma';

/**
 * Move a linked WhatsApp number, and everything it has read, to another
 * department.
 *
 * A session is department-scoped, and so is every row that hangs off it: the
 * conversations, the follow-ups drawn from them, the broadcasts sent from it.
 * Moving the session alone would leave all three pointing at a department the
 * handset no longer belongs to — visible to the wrong team, invisible to the
 * right one.
 *
 * Why this exists at all: `WhatsappChat` is unique on `[companyId, waChatId]`,
 * so one conversation can be held once per company. Linking the same handset to
 * a second department therefore does not duplicate the feature — the second
 * session simply cannot record any conversation the first already owns, and
 * ingest fails per message with a constraint violation. Moving the session is
 * the honest way to hand a number to another team; scanning it twice is not.
 *
 * Everything runs in one transaction. A half-moved number is worse than an
 * unmoved one: the department sees conversations whose follow-ups are still
 * filed elsewhere.
 *
 * Usage:
 *   pnpm tsx scripts/move-whatsapp-session.ts --session <id|label> --to "Urban Aura"
 *   ... --dry-run     show what would move, change nothing
 */

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main() {
  const sessionRef = argValue('--session');
  const target = argValue('--to');
  const dryRun = process.argv.includes('--dry-run');

  if (!sessionRef) throw new Error('Pass --session <id or label>');
  if (!target) throw new Error('Pass --to <department name or id>');

  const prisma = new PrismaClient();
  try {
    const session = await prisma.whatsappSession.findFirst({
      where: { OR: [{ id: sessionRef }, { openwaSessionId: sessionRef }, { label: sessionRef }] },
      select: { id: true, label: true, companyId: true, departmentId: true, phoneE164: true },
    });
    if (!session) {
      const all = await prisma.whatsappSession.findMany({ select: { id: true, label: true } });
      throw new Error(
        `No session "${sessionRef}". Known: ${all.map(s => `${s.label} (${s.id})`).join(', ')}`,
      );
    }

    const dept = await prisma.department.findFirst({
      where: {
        OR: [{ id: target }, { name: target }],
        // Never across companies. A handset carries a company's conversations,
        // and the department overlay is the only thing narrowing who reads
        // them — moving one to another tenant would hand over the lot.
        companyId: session.companyId,
      },
      select: { id: true, name: true, status: true },
    });
    if (!dept) throw new Error(`No department "${target}" in this company`);
    if (dept.status !== 'active') throw new Error(`Department "${dept.name}" is archived`);
    if (dept.id === session.departmentId) throw new Error(`"${session.label}" is already in ${dept.name}`);

    const [chats, followUps, broadcasts] = await Promise.all([
      prisma.whatsappChat.count({ where: { owningSessionId: session.id } }),
      prisma.followUp.count({ where: { chat: { owningSessionId: session.id } } }),
      prisma.whatsappBroadcast.count({ where: { sessionId: session.id } }),
    ]);

    /*
     * Another handset already in the destination is the one thing that makes
     * this move pointless.
     *
     * Two sessions in one department read the same conversations and collide on
     * the same unique key, which is the state this script exists to get out of
     * — arriving in it from the other direction is no better.
     */
    const alreadyThere = await prisma.whatsappSession.findMany({
      where: { departmentId: dept.id },
      select: { label: true, phoneE164: true },
    });

    const shape = {
      session: `${session.label} (${session.phoneE164 ?? 'no phone'})`,
      from: session.departmentId,
      to: `${dept.name} (${dept.id})`,
      moving: { chats, followUps, broadcasts },
      ...(alreadyThere.length > 0
        ? { warning: `${dept.name} already has: ${alreadyThere.map(s => s.label).join(', ')}` }
        : {}),
    };

    if (dryRun) {
      console.log('would move:', JSON.stringify(shape, null, 2));
      return;
    }

    const moved = await prisma.$transaction(async tx => {
      // Chats first, then the follow-ups drawn from them, then the sends. Order
      // does not matter inside a transaction, but it reads as the dependency it
      // is: a follow-up belongs to a chat, which belongs to a session.
      const c = await tx.whatsappChat.updateMany({
        where: { owningSessionId: session.id },
        data: { departmentId: dept.id },
      });
      const f = await tx.followUp.updateMany({
        where: { chat: { owningSessionId: session.id } },
        data: { departmentId: dept.id },
      });
      const b = await tx.whatsappBroadcast.updateMany({
        where: { sessionId: session.id },
        data: { departmentId: dept.id },
      });
      await tx.whatsappSession.update({
        where: { id: session.id },
        data: { departmentId: dept.id },
      });
      return { chats: c.count, followUps: f.count, broadcasts: b.count };
    });

    console.log(`moved "${session.label}" to ${dept.name}`);
    console.log(JSON.stringify({ ...shape, moved }, null, 2));
    if (alreadyThere.length > 0) {
      console.warn(
        `\nWARNING: ${dept.name} now holds more than one handset. If they are the same\n`
        + 'number, only one of them will ever record a conversation — the other fails\n'
        + 'per message on the [companyId, waChatId] unique key. Unlink the spare.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
