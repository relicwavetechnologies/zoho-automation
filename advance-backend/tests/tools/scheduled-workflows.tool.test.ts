import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledWorkflowsTool } from '../../src/application/tools/families/scheduled-workflows.tool.ts';
import { asDepartmentId } from '../../src/shared/ids.ts';
import { makeCtx } from './tool-test.helpers.ts';

const fixedNow = new Date('2026-07-19T05:00:00.000Z');

function makePrisma() {
  let created: Record<string, unknown> | null = null;
  const prisma = {
    integrationConnection: {
      findFirst: async () => ({ externalAccountId: 'ou_creator' }),
    },
    channelIdentity: {
      findFirst: async () => ({ id: 'identity-1' }),
    },
    desktopThread: {
      findFirst: async ({ where }: any) => where.id === 'thread-1' ? { id: 'thread-1' } : null,
    },
    scheduledWorkflow: {
      create: async ({ data }: any) => {
        created = data;
        return {
          id: 'schedule-1',
          name: data.name,
          scheduleType: data.scheduleType,
          status: data.status,
          timezone: data.timezone,
          nextRunAt: data.nextRunAt,
          lastRunAt: null,
          outputConfigJson: data.outputConfigJson,
        };
      },
    },
  };
  return { prisma: prisma as never, getCreated: () => created };
}

describe('scheduledWorkflows tool', () => {
  it('publishes exact schedule variants so the agent sees required timing fields before invocation', () => {
    const { prisma } = makePrisma();
    const tool = createScheduledWorkflowsTool({ prisma });

    assert.equal(tool.argsSchema.safeParse({
      operation: 'create',
      name: 'Daily inbox review',
      intent: 'Review new finance mail and summarize exceptions.',
      scheduleType: 'daily',
      timezone: 'Asia/Kolkata',
      delivery: 'current_conversation',
    }).success, false);

    assert.equal(tool.argsSchema.safeParse({
      operation: 'create',
      name: 'Daily inbox review',
      intent: 'Review new finance mail and summarize exceptions.',
      scheduleType: 'daily',
      timezone: 'Asia/Kolkata',
      hour: 10,
      timeMinute: 0,
    }).success, false);

    assert.equal(tool.argsSchema.safeParse({
      operation: 'create',
      name: 'Daily inbox review',
      intent: 'Review new finance mail and summarize exceptions.',
      scheduleType: 'daily',
      timezone: 'Asia/Kolkata',
      delivery: 'current_conversation',
      hour: 10,
      timeMinute: 0,
    }).success, true);
  });

  it('creates a desktop schedule bound to the authenticated user, department, and durable thread', async () => {
    const { prisma, getCreated } = makePrisma();
    const tool = createScheduledWorkflowsTool({ prisma });
    const args = {
      operation: 'create' as const,
      name: 'Daily inbox review',
      intent: 'Read the last 24 hours of finance email, summarize exceptions, and return the result here.',
      scheduleType: 'daily' as const,
      timezone: 'Asia/Kolkata',
      delivery: 'current_conversation' as const,
      hour: 10,
      timeMinute: 0,
    };
    const ctx = {
      ...makeCtx('scheduledWorkflows', ['create'], {
        channel: 'desktop',
        departmentId: asDepartmentId('dept-finance'),
        chatId: 'thread-1',
      }),
      clock: { now: () => fixedNow, nowMs: () => fixedNow.getTime() },
    };

    assert.equal(tool.permissionCheck(args, ctx.perm).ok, true);
    const result = await tool.execute(args, ctx);

    assert.equal(result.ok, true);
    assert.equal((result as any).value.schedule.deliveryChannel, 'desktop');
    assert.equal((result as any).value.schedule.deliveryTarget, 'origin_chat');
    assert.match((result as any).value.nextRunLabel, /20 Jul 2026, 10:00 am/i);
    assert.deepEqual(getCreated(), {
      companyId: 'co-test',
      departmentId: 'dept-finance',
      createdByUserId: 'user-test',
      name: 'Daily inbox review',
      userIntent: args.intent,
      compiledPrompt: args.intent,
      scheduleType: 'daily',
      scheduleConfigJson: {
        type: 'daily',
        timezone: 'Asia/Kolkata',
        time: { hour: 10, minute: 0 },
      },
      timezone: 'Asia/Kolkata',
      workflowSpecJson: {},
      capabilitySummaryJson: {},
      outputConfigJson: { deliveryChannel: 'desktop', deliveryTarget: 'origin_chat' },
      status: 'scheduled_active',
      scheduleEnabled: true,
      nextRunAt: new Date('2026-07-20T04:30:00.000Z'),
      originChatId: 'thread-1',
    });
  });

  it('refuses desktop scheduling when the originating conversation is not durable', async () => {
    const { prisma } = makePrisma();
    const tool = createScheduledWorkflowsTool({ prisma });
    const result = await tool.execute({
      operation: 'create',
      name: 'Daily inbox review',
      intent: 'Summarize finance mail.',
      scheduleType: 'daily',
      timezone: 'Asia/Kolkata',
      delivery: 'current_conversation',
      hour: 10,
      timeMinute: 0,
    }, makeCtx('scheduledWorkflows', ['create'], {
      channel: 'desktop',
      chatId: 'missing-thread',
    }));

    assert.equal(result.ok, false);
    assert.match((result as any).error.message, /conversation is not persisted/i);
  });

  it('creates creator Lark DM delivery without requiring a persisted desktop conversation', async () => {
    const { prisma, getCreated } = makePrisma();
    const tool = createScheduledWorkflowsTool({ prisma });
    const result = await tool.execute({
      operation: 'create',
      name: 'Daily inbox review',
      intent: 'Summarize finance mail and produce the summary as the final answer.',
      scheduleType: 'daily',
      timezone: 'Asia/Kolkata',
      delivery: 'creator_lark_dm',
      hour: 10,
      timeMinute: 0,
    }, makeCtx('scheduledWorkflows', ['create'], {
      channel: 'desktop',
      chatId: 'missing-thread',
    }));

    assert.equal(result.ok, true);
    assert.equal((result as any).value.schedule.deliveryChannel, 'lark');
    assert.equal((result as any).value.schedule.deliveryTarget, 'creator_dm');
    assert.deepEqual((getCreated() as any).outputConfigJson, {
      deliveryChannel: 'lark',
      deliveryTarget: 'creator_dm',
    });
    assert.equal((getCreated() as any).originChatId, null);
  });

  it('refuses creator Lark DM delivery when the authenticated creator has no Lark identity', async () => {
    const { prisma } = makePrisma();
    (prisma as any).integrationConnection.findFirst = async () => null;
    const tool = createScheduledWorkflowsTool({ prisma });
    const result = await tool.execute({
      operation: 'create',
      name: 'Daily inbox review',
      intent: 'Summarize finance mail and produce the summary as the final answer.',
      scheduleType: 'daily',
      timezone: 'Asia/Kolkata',
      delivery: 'creator_lark_dm',
      hour: 10,
      timeMinute: 0,
    }, makeCtx('scheduledWorkflows', ['create'], {
      channel: 'desktop',
      chatId: 'missing-thread',
    }));

    assert.equal(result.ok, false);
    assert.match((result as any).error.message, /connect your Lark account/i);
  });
});
