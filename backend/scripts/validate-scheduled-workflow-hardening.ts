import 'dotenv/config';

import { randomUUID } from 'crypto';

import { PrismaClient } from '../src/generated/prisma';
import { memberAuthRepository } from '../src/modules/member-auth/member-auth.repository';
import type { MemberSessionDTO } from '../src/modules/member-auth/member-auth.service';
import { desktopWorkflowsService } from '../src/modules/desktop-workflows/desktop-workflows.service';
import type {
  ScheduledWorkflowOutputConfig,
  ScheduledWorkflowScheduleConfig,
} from '../src/company/scheduled-workflows/contracts';
import { getNextScheduledRunAt } from '../src/modules/desktop-workflows/desktop-workflows.schedule';

const prisma = new PrismaClient();

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const resolveLatestLarkSession = async (): Promise<{
  session: MemberSessionDTO;
  chatId: string;
}> => {
  const recentMessages = await prisma.desktopMessage.findMany({
    where: {
      thread: {
        channel: 'lark',
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      metadata: true,
      thread: {
        select: {
          companyId: true,
          userId: true,
        },
      },
    },
  });

  for (const recentMessage of recentMessages) {
    const larkMeta = asRecord(asRecord(recentMessage.metadata)?.lark);
    const chatId = asString(larkMeta?.chatId);
    const larkTenantKey = asString(larkMeta?.larkTenantKey);
    const larkOpenId = asString(larkMeta?.larkOpenId);
    const larkUserId = asString(larkMeta?.larkUserId);
    const requesterEmail = asString(larkMeta?.requesterEmail);
    if (!chatId || !recentMessage.thread.companyId || !recentMessage.thread.userId) {
      continue;
    }

    const user = await memberAuthRepository.findUserById(recentMessage.thread.userId);
    const membership = await memberAuthRepository.findActiveMembership(
      recentMessage.thread.userId,
      recentMessage.thread.companyId,
    );
    if (!user || !membership) {
      continue;
    }

    return {
      chatId,
      session: {
        userId: user.id,
        companyId: recentMessage.thread.companyId,
        role: membership.role,
        aiRole: membership.role,
        sessionId: `scheduled-hardening-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        authProvider: 'lark',
        name: user.name ?? undefined,
        email: user.email,
        larkTenantKey: larkTenantKey ?? undefined,
        larkOpenId: larkOpenId ?? undefined,
        larkUserId: larkUserId ?? undefined,
      },
    };
  }

  throw new Error('No recent Lark session context could be resolved.');
};

const desktopInboxOutputConfig: ScheduledWorkflowOutputConfig = {
  version: 'v1',
  destinations: [
    { id: 'desktop_inbox', kind: 'desktop_inbox', label: 'Desktop inbox' },
  ],
  defaultDestinationIds: ['desktop_inbox'],
};

const buildCurrentChatOutputConfig = (): ScheduledWorkflowOutputConfig => ({
  version: 'v1',
  destinations: [
    { id: 'lark_current_chat', kind: 'lark_current_chat', label: 'Current Lark chat' },
  ],
  defaultDestinationIds: ['lark_current_chat'],
});

const dailySchedule = (hour: number, minute: number): ScheduledWorkflowScheduleConfig => ({
  type: 'daily',
  timezone: 'Asia/Kolkata',
  time: { hour, minute },
});

const weeklySchedule = (): ScheduledWorkflowScheduleConfig => ({
  type: 'weekly',
  timezone: 'Asia/Kolkata',
  daysOfWeek: ['MO'],
  time: { hour: 9, minute: 0 },
});

const archiveIfPresent = async (session: MemberSessionDTO, workflowId: string | null | undefined) => {
  if (!workflowId) return;
  try {
    await desktopWorkflowsService.archive(session, workflowId);
  } catch {
    // cleanup only
  }
};

const main = async () => {
  const { session, chatId } = await resolveLatestLarkSession();

  const createdIds: string[] = [];

  try {
    const createDraft = await desktopWorkflowsService.createDraft(session, {
      name: `Codex Schedule Hardening CRUD ${Date.now()}`,
      originChatId: chatId,
    });
    createdIds.push(createDraft.id);

    const published = await desktopWorkflowsService.publish(session, {
      workflowId: createDraft.id,
      name: createDraft.name,
      userIntent: 'Send a daily digest.',
      aiDraft: 'Send a daily digest.',
      workflowSpec: createDraft.workflowSpec,
      compiledPrompt: 'Send a daily digest.',
      schedule: weeklySchedule(),
      scheduleEnabled: false,
      outputConfig: desktopInboxOutputConfig,
      originChatId: chatId,
      departmentId: null,
    });

    const enabled = await desktopWorkflowsService.setScheduleState(session, createDraft.id, true);
    const beforeReschedule = await desktopWorkflowsService.get(session, createDraft.id);
    const newSchedule = dailySchedule(23, 45);
    const updated = await desktopWorkflowsService.update(session, createDraft.id, {
      schedule: newSchedule,
    });
    const afterReschedule = await desktopWorkflowsService.get(session, createDraft.id);
    const expectedNextRunAtAfterReschedule = getNextScheduledRunAt(newSchedule, new Date());
    const paused = await desktopWorkflowsService.setScheduleState(session, createDraft.id, false);
    await desktopWorkflowsService.archive(session, createDraft.id);
    const visibleAfterArchive = await desktopWorkflowsService.resolveVisibleWorkflow(session, createDraft.name);

    const currentChatDraftMissing = await desktopWorkflowsService.createDraft(session, {
      name: `Codex Current Chat Missing ${Date.now()}`,
      originChatId: null,
    });
    createdIds.push(currentChatDraftMissing.id);

    let currentChatMissingError: string | null = null;
    try {
      await desktopWorkflowsService.publish(session, {
        workflowId: currentChatDraftMissing.id,
        name: currentChatDraftMissing.name,
        userIntent: 'Post results back here.',
        aiDraft: 'Post results back here.',
        workflowSpec: currentChatDraftMissing.workflowSpec,
        compiledPrompt: 'Post results back here.',
        schedule: weeklySchedule(),
        scheduleEnabled: false,
        outputConfig: buildCurrentChatOutputConfig(),
        originChatId: null,
        departmentId: null,
      });
    } catch (error) {
      currentChatMissingError = error instanceof Error ? error.message : String(error);
    }

    const currentChatDraftOk = await desktopWorkflowsService.createDraft(session, {
      name: `Codex Current Chat OK ${Date.now()}`,
      originChatId: chatId,
    });
    createdIds.push(currentChatDraftOk.id);

    const currentChatPublished = await desktopWorkflowsService.publish(session, {
      workflowId: currentChatDraftOk.id,
      name: currentChatDraftOk.name,
      userIntent: 'Post results back here.',
      aiDraft: 'Post results back here.',
      workflowSpec: currentChatDraftOk.workflowSpec,
      compiledPrompt: 'Post results back here.',
      schedule: weeklySchedule(),
      scheduleEnabled: false,
      outputConfig: buildCurrentChatOutputConfig(),
      originChatId: chatId,
      departmentId: null,
    });
    await desktopWorkflowsService.archive(session, currentChatDraftOk.id);

    console.log(JSON.stringify({
      ok: true,
      session: {
        userId: session.userId,
        companyId: session.companyId,
        email: session.email,
        chatId,
      },
      checks: {
        createDraft: {
          workflowId: createDraft.id,
          status: createDraft.status,
        },
        publishDesktopInbox: {
          workflowId: published.workflowId,
          status: published.status,
          scheduleEnabled: published.scheduleEnabled,
        },
        enableSchedule: enabled,
        rescheduleWhileActive: {
          beforeSchedule: beforeReschedule.schedule,
          afterSchedule: updated.schedule,
          nextRunAtBefore: beforeReschedule.nextRunAt,
          nextRunAtAfter: afterReschedule.nextRunAt,
          expectedNextRunAtAfterReschedule: expectedNextRunAtAfterReschedule?.toISOString() ?? null,
          nextRunRecomputed:
            (afterReschedule.nextRunAt ?? null) === (expectedNextRunAtAfterReschedule?.toISOString() ?? null),
        },
        pauseSchedule: paused,
        archiveViaTool: {
          success: visibleAfterArchive.status === 'not_found',
          summary: visibleAfterArchive.status === 'not_found' ? 'Archived and removed from visible workflow list.' : 'Archive did not hide the workflow as expected.',
          archivedWorkflowId: createDraft.id,
          hiddenFromVisibleList: visibleAfterArchive.status === 'not_found',
        },
        publishCurrentChatWithoutOrigin: {
          rejected: Boolean(currentChatMissingError),
          error: currentChatMissingError,
        },
        publishCurrentChatWithOrigin: {
          workflowId: currentChatPublished.workflowId,
          originChatId: currentChatPublished.originChatId,
          status: currentChatPublished.status,
        },
      },
    }, null, 2));
  } finally {
    for (const workflowId of createdIds) {
      await archiveIfPresent(session, workflowId);
    }
    await prisma.$disconnect();
  }
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    await prisma.$disconnect();
    process.exit(1);
  });
