import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduledWorkflowService, buildScheduledExecutionPrompt, usesLockedCurrentChatDelivery } from '../../src/application/scheduling/scheduled-workflow.service.ts';
import { ok } from '../../src/shared/result.ts';
import type { Logger } from '../../src/shared/logger.ts';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

const fixedNow = new Date('2026-05-15T16:45:30.000Z');
const fakeClock = {
  now: () => fixedNow,
  nowMs: () => fixedNow.getTime(),
};

describe('scheduled workflow current-chat delivery helpers', () => {
  it('detects workflows that rely on lark_current_chat delivery', () => {
    const prompt = [
      'Workflow: Daily email summary',
      '2. [deliver] Deliver result',
      '   Deliver to: dest_1:lark_current_chat',
    ].join('\n');

    assert.equal(usesLockedCurrentChatDelivery(prompt), true);
    assert.equal(usesLockedCurrentChatDelivery('Workflow: plain summary only'), false);
  });

  it('rewrites lark_current_chat delivery prompts for runtime-locked delivery', () => {
    const prompt = [
      'Workflow: Daily email summary',
      '2. [deliver] Deliver result',
      '   Deliver to: dest_1:lark_current_chat',
    ].join('\n');

    const rewritten = buildScheduledExecutionPrompt(prompt, 'oc_dm_chat');
    assert.match(rewritten, /runtime_locked_current_chat/);
    assert.match(rewritten, /RUNTIME DELIVERY OVERRIDE/);
    assert.match(rewritten, /oc_dm_chat/);
    assert.doesNotMatch(rewritten, /Deliver to:\s+dest_1:lark_current_chat/);
  });

  it('adds runtime delivery ownership to new raw-intent schedules', () => {
    const rewritten = buildScheduledExecutionPrompt(
      'Review new mail and return a concise summary.',
      'oc_dm_chat',
    );

    assert.match(rewritten, /RUNTIME DELIVERY OVERRIDE/);
    assert.match(rewritten, /Do NOT use larkMessaging/i);
  });
});

describe('ScheduledWorkflowService.executeWorkflow', () => {
  it('locks the run context to the originating chat for scheduled current-chat delivery', async () => {
    const workflow = {
      id: 'wf-1',
      name: 'Daily email summary',
      companyId: 'co-1',
      createdByUserId: 'user-1',
      departmentId: 'dept-1',
      originChatId: 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50',
      compiledPrompt: 'Review new mail and return a concise summary.',
      outputConfigJson: { deliveryChannel: 'lark' },
      scheduleConfigJson: {
        type: 'daily',
        timezone: 'Asia/Kolkata',
        time: { hour: 9, minute: 0 },
      },
    };

    let capturedInput: any = null;
    const prisma = {
      scheduledWorkflow: {
        findUnique: async () => workflow,
        update: async () => ({}),
      },
      scheduledWorkflowRun: {
        upsert: async () => ({ id: 'run-1' }),
        update: async () => ({}),
      },
    } as any;

    const engine = {
      run: async (input: any) => {
        capturedInput = input;
        return ok({
          finalReply: { kind: 'final', text: 'Here are your latest emails.', format: 'text' },
          toolsCalled: [],
        });
      },
    } as any;

    const channelIdentityRepo = {
      resolveByUserId: async () => ok({
        userId: 'user-1',
        companyId: 'co-1',
        aiRole: 'MEMBER',
        channel: 'lark',
        larkOpenId: 'ou_123',
      }),
    } as any;

    const svc = new ScheduledWorkflowService({
      prisma,
      engine,
      channelAdapters: { lark: {} as any, larkDm: {} as any, desktop: {} as any },
      channelIdentityRepo,
      logger: noopLogger,
      clock: fakeClock as any,
      pollIntervalMs: 1_000,
    });

    await (svc as any).executeWorkflow('wf-1', new Date('2026-05-15T16:45:00.000Z'));

    assert.ok(capturedInput, 'engine.run should be called');
    assert.equal(capturedInput.runContext.chatId, 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50');
    assert.equal(capturedInput.runContext.deliveryMode, 'current_chat_only');
    assert.equal(capturedInput.runContext.departmentId, 'dept-1');
    assert.equal(capturedInput.conversation.chatId, 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50');
    assert.match(capturedInput.incoming.text, /RUNTIME DELIVERY OVERRIDE/);
    assert.match(capturedInput.incoming.text, /Do NOT use larkMessaging/i);
  });

  it('runs desktop schedules headlessly and persists delivery through the desktop adapter', async () => {
    const workflow = {
      id: 'wf-desktop',
      name: 'Daily review',
      companyId: 'co-1',
      createdByUserId: 'user-1',
      departmentId: 'dept-finance',
      originChatId: 'desktop-thread-1',
      compiledPrompt: 'Review new invoices and summarize exceptions.',
      outputConfigJson: { deliveryChannel: 'desktop' },
      scheduleConfigJson: {
        type: 'daily',
        timezone: 'Asia/Kolkata',
        time: { hour: 9, minute: 0 },
      },
    };
    let capturedInput: any = null;
    const desktopAdapter = { key: 'desktop' } as any;
    const prisma = {
      scheduledWorkflow: { findUnique: async () => workflow, update: async () => ({}) },
      scheduledWorkflowRun: { upsert: async () => ({ id: 'run-desktop' }), update: async () => ({}) },
    } as any;
    const svc = new ScheduledWorkflowService({
      prisma,
      engine: {
        run: async (input: any) => {
          capturedInput = input;
          return ok({ finalReply: { kind: 'final', text: 'Done', format: 'text' }, toolsCalled: [] });
        },
      } as any,
      channelAdapters: { lark: { key: 'lark' } as any, larkDm: { key: 'lark' } as any, desktop: desktopAdapter },
      channelIdentityRepo: {
        resolveByUserId: async () => ok({
          userId: 'user-1', companyId: 'co-1', aiRole: 'MEMBER', channel: 'lark', larkOpenId: 'ou_123',
        }),
      } as any,
      logger: noopLogger,
      clock: fakeClock as any,
      pollIntervalMs: 1_000,
    });

    await (svc as any).executeWorkflow('wf-desktop', new Date('2026-05-15T16:45:00.000Z'));

    assert.equal(capturedInput.incoming.channel, 'desktop');
    assert.equal(capturedInput.runContext.channel, 'desktop');
    assert.equal(capturedInput.runContext.departmentId, 'dept-finance');
    assert.equal(capturedInput.conversation.chatId, 'desktop-thread-1');
    assert.equal(capturedInput.channelAdapter, desktopAdapter);
    assert.match(capturedInput.incoming.text, /originating Divo desktop conversation/);
  });

  it('delivers creator-DM schedules through the dedicated Lark open-id adapter', async () => {
    const workflow = {
      id: 'wf-creator-dm',
      name: 'Daily inbox review',
      companyId: 'co-1',
      createdByUserId: 'user-1',
      departmentId: 'dept-finance',
      originChatId: null,
      compiledPrompt: 'Review new invoices and produce a concise summary.',
      outputConfigJson: { deliveryChannel: 'lark', deliveryTarget: 'creator_dm' },
      scheduleConfigJson: {
        type: 'daily',
        timezone: 'Asia/Kolkata',
        time: { hour: 9, minute: 0 },
      },
    };
    let capturedInput: any = null;
    const larkDmAdapter = { key: 'lark' } as any;
    const prisma = {
      scheduledWorkflow: { findUnique: async () => workflow, update: async () => ({}) },
      scheduledWorkflowRun: { upsert: async () => ({ id: 'run-creator-dm' }), update: async () => ({}) },
    } as any;
    const svc = new ScheduledWorkflowService({
      prisma,
      engine: {
        run: async (input: any) => {
          capturedInput = input;
          return ok({ finalReply: { kind: 'final', text: 'Done', format: 'text' }, toolsCalled: [] });
        },
      } as any,
      channelAdapters: {
        lark: { key: 'lark' } as any,
        larkDm: larkDmAdapter,
        desktop: { key: 'desktop' } as any,
      },
      channelIdentityRepo: {
        resolveByUserId: async () => ok({
          userId: 'user-1', companyId: 'co-1', aiRole: 'MEMBER', channel: 'lark', larkOpenId: 'ou_creator',
        }),
      } as any,
      logger: noopLogger,
      clock: fakeClock as any,
      pollIntervalMs: 1_000,
    });

    await (svc as any).executeWorkflow('wf-creator-dm', new Date('2026-05-15T16:45:00.000Z'));

    assert.equal(capturedInput.incoming.channel, 'lark');
    assert.equal(capturedInput.runContext.channel, 'lark');
    assert.equal(capturedInput.runContext.chatId, 'ou_creator');
    assert.equal(capturedInput.runContext.deliveryMode, 'scheduled_runtime_delivery');
    assert.equal(capturedInput.conversation.chatId, 'ou_creator');
    assert.equal(capturedInput.channelAdapter, larkDmAdapter);
    assert.match(capturedInput.incoming.text, /authenticated schedule creator's Lark DM/i);
    assert.match(capturedInput.incoming.text, /Do not call larkMessaging/i);
  });
});
