import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScheduledWorkflowsTool,
  scheduledWorkflowsArgsSchema,
} from '../../src/application/tools/families/scheduled-workflows.tool.ts';
import { SCHEDULE_DIVO_WORK_SKILL_MARKDOWN } from '../../src/application/skills/scheduled-work-system-skill.ts';
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

    // Omitting delivery is the shape to aim for: it no longer decides anything.
    assert.equal(tool.argsSchema.safeParse({
      operation: 'create',
      name: 'Daily inbox review',
      intent: 'Review new finance mail and summarize exceptions.',
      scheduleType: 'daily',
      timezone: 'Asia/Kolkata',
      hour: 10,
      timeMinute: 0,
    }).success, true);

    // Still accepted, so a caller working from an older copy of the scheduling
    // skill is not rejected for sending it.
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

  it('never advertises delivery into the conversation the schedule was made from', async () => {
    const { prisma } = makePrisma();
    const tool = createScheduledWorkflowsTool({ prisma });
    // Every piece of copy that reaches the model before it answers: the tool's
    // own docs, the `delivery` field description, and the scheduling skill the
    // gateway loads first — which is where the old promise actually lived.
    const deliveryField = (scheduledWorkflowsArgsSchema as any).options?.[0]
      ?.shape?.delivery?.description ?? '';
    const modelFacing = [
      tool.description,
      ...tool.parameterDocs,
      deliveryField,
      SCHEDULE_DIVO_WORK_SKILL_MARKDOWN,
    ].join('\n');
    assert.notEqual(deliveryField, '', 'the delivery field description must be inspected');

    // The model answers the user from this copy, before it ever sees what create
    // returned. Copy promising the result will appear "here" makes Divo tell a
    // room it will be posted there, and the room then silently gets nothing.
    assert.doesNotMatch(modelFacing, /return results to the current conversation/i);
    assert.doesNotMatch(modelFacing, /must return to this exact persisted conversation/i);
    assert.match(modelFacing, /creator's own Lark DM/i);
  });

  it('sends results to the creator even when they asked for the current conversation', async () => {
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
    // The run executes with one person's history and permissions, so its output
    // goes to that person — not back into whatever conversation it was set up
    // from, which may be a room full of colleagues.
    assert.equal((result as any).value.schedule.deliveryChannel, 'lark');
    assert.equal((result as any).value.schedule.deliveryTarget, 'creator_dm');
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
      outputConfigJson: { deliveryChannel: 'lark', deliveryTarget: 'creator_dm' },
      status: 'scheduled_active',
      scheduleEnabled: true,
      nextRunAt: new Date('2026-07-20T04:30:00.000Z'),
    });
  });

  it('no longer needs the originating conversation to be durable', async () => {
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

    // Delivery no longer depends on that conversation surviving, so a schedule
    // set up from a throwaway one is no longer rejected.
    assert.equal(result.ok, true);
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
