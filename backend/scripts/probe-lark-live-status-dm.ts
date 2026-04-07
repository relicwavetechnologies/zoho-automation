import 'dotenv/config';

import { PrismaClient } from '../src/generated/prisma';
import { LarkChannelAdapter } from '../src/company/channels/lark/lark.adapter';

const prisma = new PrismaClient();
const adapter = new LarkChannelAdapter();

const args = process.argv.slice(2);

const readArg = (name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

type HarnessContext = {
  companyId: string;
  linkedUserId: string;
  larkOpenId: string;
  larkUserId?: string;
  requesterName?: string;
  requesterEmail?: string;
};

const resolveLatestDmContext = async (): Promise<HarnessContext> => {
  const explicitOpenId = asString(readArg('--open-id'));
  const explicitCompanyId = asString(readArg('--company-id'));
  const explicitUserId = asString(readArg('--user-id'));

  if (explicitOpenId && explicitCompanyId && explicitUserId) {
    return {
      companyId: explicitCompanyId,
      linkedUserId: explicitUserId,
      larkOpenId: explicitOpenId,
      larkUserId: asString(readArg('--lark-user-id')),
      requesterName: asString(readArg('--name')),
      requesterEmail: asString(readArg('--email')),
    };
  }

  const link = await prisma.larkUserAuthLink.findFirst({
    where: {
      revokedAt: null,
    },
    orderBy: [
      { lastUsedAt: 'desc' },
      { updatedAt: 'desc' },
      { createdAt: 'desc' },
    ],
    select: {
      companyId: true,
      userId: true,
      larkOpenId: true,
      larkUserId: true,
      larkEmail: true,
    },
  });

  if (!link?.companyId || !link.userId || !link.larkOpenId) {
    throw new Error('Could not resolve a recent linked Lark user. Pass --open-id --company-id --user-id.');
  }

  const identity = await prisma.channelIdentity.findFirst({
    where: {
      companyId: link.companyId,
      channel: 'lark',
      OR: [
        { larkOpenId: link.larkOpenId },
        ...(link.larkUserId ? [{ larkUserId: link.larkUserId }] : []),
      ],
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      displayName: true,
      email: true,
    },
  });

  return {
    companyId: link.companyId,
    linkedUserId: link.userId,
    larkOpenId: link.larkOpenId,
    larkUserId: link.larkUserId ?? undefined,
    requesterName: identity?.displayName ?? undefined,
    requesterEmail: link.larkEmail ?? identity?.email ?? undefined,
  };
};

const buildTodoText = (input: {
  goal: string;
  items: Array<{ index: number; text: string; status: 'pending' | 'running' | 'done' }>;
  vibe: string;
}) => {
  const iconFor = (status: 'pending' | 'running' | 'done') =>
    status === 'done' ? '✓' : status === 'running' ? '⟳' : '○';

  return [
    `ACTIVE TODOS — Goal: ${input.goal}`,
    ...input.items.map((item) => `${iconFor(item.status)} ${item.index}. ${item.text}`),
    '',
    `${input.vibe}`,
  ].join('\n');
};

const buildFinalCard = (input: { goal: string; durationSec: number }) => [
  `Completed research flow`,
  '',
  `Goal: ${input.goal}`,
  `Completed in ${input.durationSec}s ✓`,
].join('\n');

const main = async () => {
  const format = (asString(readArg('--format')) ?? 'interactive') as 'interactive' | 'text';
  const updates = Number(readArg('--updates') ?? '8');
  const intervalMs = Number(readArg('--interval-ms') ?? '1500');
  const context = await resolveLatestDmContext();
  const goal = 'Research top 5 agentic AI companies and initiate outreach';

  const todoTemplates = [
    'Search for top 5 agentic AI companies in 2026',
    'Find contact details for the CEOs of these 5 companies',
    'Create a Lark task for each company to reach out',
    `Send summary email${context.requesterEmail ? ` to ${context.requesterEmail}` : ''}`,
  ];

  const startedAt = Date.now();

  console.log(JSON.stringify({
    target: {
      companyId: context.companyId,
      linkedUserId: context.linkedUserId,
      larkOpenId: context.larkOpenId,
      requesterName: context.requesterName ?? null,
      requesterEmail: context.requesterEmail ?? null,
    },
    format,
    updates,
    intervalMs,
  }, null, 2));

  const initial = await adapter.sendMessage({
    chatId: context.larkOpenId,
    text: buildTodoText({
      goal,
      items: todoTemplates.map((text, index) => ({
        index: index + 1,
        text,
        status: index === 0 ? 'running' : 'pending',
      })),
      vibe: 'Warping ·',
    }),
    format,
    correlationId: `probe-live-dm-${Date.now()}`,
  });

  console.log('initial', JSON.stringify({
    status: initial.status,
    messageId: initial.messageId ?? null,
    error: initial.error ?? null,
  }, null, 2));

  if (initial.status === 'failed' || !initial.messageId) {
    throw new Error(`Initial send failed: ${initial.error?.rawMessage ?? 'unknown'}`);
  }

  for (let step = 1; step <= updates; step += 1) {
    await sleep(intervalMs);

    const currentItems = todoTemplates.map((text, index) => {
      const itemStep = index * 2 + 1;
      let status: 'pending' | 'running' | 'done' = 'pending';
      if (step > itemStep) {
        status = 'done';
      } else if (step === itemStep || step === itemStep + 1) {
        status = 'running';
      }
      return {
        index: index + 1,
        text,
        status,
      };
    });

    const vibePool = ['Warping ·', 'Routing ··', 'Refining ···', 'Closing ·'];
    const text = buildTodoText({
      goal,
      items: currentItems,
      vibe: vibePool[(step - 1) % vibePool.length] ?? 'Working ·',
    });

    const updated = await adapter.updateMessage({
      messageId: initial.messageId,
      text,
      format,
      correlationId: `probe-live-dm-${Date.now()}-${step}`,
    });

    console.log('update', JSON.stringify({
      step,
      status: updated.status,
      messageId: updated.messageId ?? initial.messageId,
      error: updated.error ?? null,
    }, null, 2));

    if (updated.status === 'failed') {
      break;
    }
  }

  await sleep(intervalMs);

  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  const finalUpdate = await adapter.updateMessage({
    messageId: initial.messageId,
    text: buildFinalCard({ goal, durationSec }),
    format,
    correlationId: `probe-live-dm-final-${Date.now()}`,
  });

  console.log('final', JSON.stringify({
    status: finalUpdate.status,
    messageId: finalUpdate.messageId ?? initial.messageId,
    error: finalUpdate.error ?? null,
    durationSec,
  }, null, 2));
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
