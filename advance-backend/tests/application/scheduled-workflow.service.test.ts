import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduledWorkflowService, buildScheduledExecutionPrompt, usesLockedCurrentChatDelivery } from '../../src/application/scheduling/scheduled-workflow.service.ts';
import { ok, err } from '../../src/shared/result.ts';
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

  it('tells a run its answer is delivered to the creator, not to a chat', () => {
    // The shape every schedule now takes. Called the way the service calls it,
    // rather than through the defaults, which still describe the retired
    // current-chat delivery.
    const rewritten = buildScheduledExecutionPrompt(
      'Review new mail and return a concise summary.',
      'ou_creator',
      'lark',
      'creator_dm',
    );

    assert.match(rewritten, /RUNTIME DELIVERY OVERRIDE/);
    assert.match(rewritten, /schedule creator's Lark DM/i);
    assert.match(rewritten, /do not search for the creator or a destination chat/i);
  });
});

describe('ScheduledWorkflowService.executeWorkflow', () => {
  const identity = {
    userId: 'user-1',
    companyId: 'co-1',
    aiRole: 'MEMBER',
    channel: 'lark',
    larkOpenId: 'ou_123',
    larkTenantKey: 'tenant-1',
  };

  /** Records the session lifecycle so a run can assert it was cleaned up. */
  function sessionSpy() {
    const created: any[] = [];
    const revoked: any[] = [];
    return {
      created,
      revoked,
      memberSession: {
        create: async (args: any) => {
          created.push(args.data);
          return { sessionId: 'sess-1', expiresAt: args.data.expiresAt };
        },
        updateMany: async (args: any) => { revoked.push(args.where); return { count: 1 }; },
      },
    };
  }

  /** An adapter that remembers the reply it was asked to deliver. */
  function recordingAdapter(key: string) {
    const delivered: any[] = [];
    return {
      key,
      delivered,
      sendFinalReply: async (conversation: any, reply: any) => {
        delivered.push({ conversation, reply });
        return ok(undefined);
      },
    } as any;
  }

  it('redirects a schedule created before the DM rule away from its origin chat', async () => {
    const workflow = {
      id: 'wf-1',
      name: 'Daily email summary',
      companyId: 'co-1',
      createdByUserId: 'user-1',
      departmentId: 'dept-1',
      originChatId: 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50',
      compiledPrompt: [
        'Review new mail and return a concise summary.',
        '   Deliver to: dest_1:lark_current_chat',
      ].join('\n'),
      outputConfigJson: { deliveryChannel: 'lark' },
      scheduleConfigJson: { type: 'daily', timezone: 'Asia/Kolkata', time: { hour: 9, minute: 0 } },
    };

    let capturedInput: any = null;
    const sessions = sessionSpy();
    const larkAdapter = recordingAdapter('lark');
    const larkDmAdapter = recordingAdapter('lark');
    const prisma = {
      scheduledWorkflow: { findUnique: async () => workflow, update: async () => ({}) },
      scheduledWorkflowRun: { upsert: async () => ({ id: 'run-1' }), update: async () => ({}) },
      memberSession: sessions.memberSession,
    } as any;

    const svc = new ScheduledWorkflowService({
      prisma,
      piRuntime: {
        run: async (input: any) => {
          capturedInput = input;
          return { text: 'Here are your latest emails.' };
        },
      } as any,
      channelAdapters: { lark: larkAdapter, larkDm: larkDmAdapter, desktop: recordingAdapter('desktop') },
      channelIdentityRepo: { resolveByUserId: async () => ok(identity) } as any,
      logger: noopLogger,
      clock: fakeClock as any,
      pollIntervalMs: 1_000,
      runTimeoutMs: 60_000,
    });

    await (svc as any).executeWorkflow('wf-1', new Date('2026-05-15T16:45:00.000Z'));

    assert.ok(capturedInput, 'piRuntime.run should be called');
    // This row still names the chat it was created in, which may be a group. The
    // run reads one person's history and permissions, so it answers to that
    // person instead of to whoever happens to be in that room.
    assert.equal(capturedInput.runContext.chatId, 'ou_123');
    assert.equal(capturedInput.conversation.chatId, 'ou_123');
    assert.equal(capturedInput.runContext.deliveryMode, 'scheduled_runtime_delivery');
    assert.equal(capturedInput.runContext.departmentId, 'dept-1');
    assert.match(capturedInput.incoming.text, /RUNTIME DELIVERY OVERRIDE/);
    // The stored task still names the room it was written for. Left in place it
    // contradicts the override, and the model may try to satisfy it by posting
    // there itself rather than just answering.
    assert.doesNotMatch(capturedInput.incoming.text, /Deliver to:\s+dest_1:lark_current_chat/);
    assert.match(capturedInput.incoming.text, /Ignore any delivery destination named in the task above/i);

    // Pi identifies the member by tenant key and open id together.
    assert.equal(capturedInput.runContext.tenantId, 'tenant-1');
    assert.equal(capturedInput.runContext.userExternalId, 'ou_123');

    // One thread per workflow, so the workspace persists between runs.
    assert.equal(capturedInput.threadId, 'scheduled-workflow:wf-1');

    // Pi returns the reply; the scheduler is what delivers it — through the DM
    // adapter, never through the general chat adapter that would reach the room.
    assert.equal(larkAdapter.delivered.length, 0);
    assert.equal(larkDmAdapter.delivered.length, 1);
    assert.equal(larkDmAdapter.delivered[0].reply.text, 'Here are your latest emails.');
  });

  it('issues a machine session for the run and revokes it afterwards', async () => {
    const workflow = {
      id: 'wf-session',
      name: 'Session lifecycle',
      companyId: 'co-1',
      createdByUserId: 'user-1',
      departmentId: null,
      originChatId: 'oc_chat',
      compiledPrompt: 'Do the thing.',
      outputConfigJson: { deliveryChannel: 'lark' },
      scheduleConfigJson: { type: 'daily', timezone: 'Asia/Kolkata', time: { hour: 9, minute: 0 } },
    };
    const sessions = sessionSpy();
    const prisma = {
      scheduledWorkflow: { findUnique: async () => workflow, update: async () => ({}) },
      scheduledWorkflowRun: { upsert: async () => ({ id: 'run-s' }), update: async () => ({}) },
      memberSession: sessions.memberSession,
    } as any;

    const svc = new ScheduledWorkflowService({
      prisma,
      piRuntime: { run: async () => ({ text: 'done' }) } as any,
      channelAdapters: { lark: recordingAdapter('lark'), larkDm: recordingAdapter('lark'), desktop: recordingAdapter('desktop') },
      channelIdentityRepo: { resolveByUserId: async () => ok(identity) } as any,
      logger: noopLogger,
      clock: fakeClock as any,
      pollIntervalMs: 1_000,
      runTimeoutMs: 60_000,
    });

    await (svc as any).executeWorkflow('wf-session', new Date('2026-05-15T16:45:00.000Z'));

    assert.equal(sessions.created.length, 1);
    assert.equal(sessions.created[0].authProvider, 'scheduled_workflow');
    assert.equal(sessions.created[0].larkTenantKey, 'tenant-1');
    assert.equal(sessions.created[0].larkOpenId, 'ou_123');
    assert.equal(sessions.revoked.length, 1, 'the session must not outlive the run');
    assert.equal(sessions.revoked[0].sessionId, 'sess-1');
  });

  it('revokes the session even when the run itself fails', async () => {
    const workflow = {
      id: 'wf-fail',
      name: 'Failing run',
      companyId: 'co-1',
      createdByUserId: 'user-1',
      departmentId: null,
      originChatId: 'oc_chat',
      compiledPrompt: 'Do the thing.',
      outputConfigJson: { deliveryChannel: 'lark' },
      scheduleConfigJson: { type: 'daily', timezone: 'Asia/Kolkata', time: { hour: 9, minute: 0 } },
    };
    const sessions = sessionSpy();
    let runStatus: string | undefined;
    const prisma = {
      scheduledWorkflow: { findUnique: async () => workflow, update: async () => ({}) },
      scheduledWorkflowRun: {
        upsert: async () => ({ id: 'run-f' }),
        update: async (args: any) => { runStatus = args.data.status; return {}; },
      },
      memberSession: sessions.memberSession,
    } as any;

    const svc = new ScheduledWorkflowService({
      prisma,
      piRuntime: { run: async () => { throw new Error('container unreachable'); } } as any,
      channelAdapters: { lark: recordingAdapter('lark'), larkDm: recordingAdapter('lark'), desktop: recordingAdapter('desktop') },
      channelIdentityRepo: { resolveByUserId: async () => ok(identity) } as any,
      logger: noopLogger,
      clock: fakeClock as any,
      pollIntervalMs: 1_000,
      runTimeoutMs: 60_000,
    });

    await (svc as any).executeWorkflow('wf-fail', new Date('2026-05-15T16:45:00.000Z'));

    assert.equal(runStatus, 'failed');
    assert.equal(sessions.revoked.length, 1, 'a failed run must still retire its session');
  });

  it('fails the run when the channel refuses the delivery', async () => {
    const workflow = {
      id: 'wf-undelivered',
      name: 'Undelivered',
      companyId: 'co-1',
      createdByUserId: 'user-1',
      departmentId: null,
      originChatId: 'oc_chat',
      compiledPrompt: 'Do the thing.',
      outputConfigJson: { deliveryChannel: 'lark' },
      scheduleConfigJson: { type: 'daily', timezone: 'Asia/Kolkata', time: { hour: 9, minute: 0 } },
    };
    const sessions = sessionSpy();
    let recorded: any = null;
    const prisma = {
      scheduledWorkflow: { findUnique: async () => workflow, update: async () => ({}) },
      scheduledWorkflowRun: {
        upsert: async () => ({ id: 'run-u' }),
        update: async (args: any) => { recorded = args.data; return {}; },
      },
      memberSession: sessions.memberSession,
    } as any;

    // Adapters report a refusal by returning err, they do not throw. A run whose
    // reply never arrived is not a successful run.
    const refusingAdapter = {
      key: 'lark',
      sendFinalReply: async () => err(new Error('bot is not in this chat')),
    } as any;

    const svc = new ScheduledWorkflowService({
      prisma,
      piRuntime: { run: async () => ({ text: 'the report' }) } as any,
      channelAdapters: { lark: refusingAdapter, larkDm: refusingAdapter, desktop: refusingAdapter },
      channelIdentityRepo: { resolveByUserId: async () => ok(identity) } as any,
      logger: noopLogger,
      clock: fakeClock as any,
      pollIntervalMs: 1_000,
      runTimeoutMs: 60_000,
    });

    await (svc as any).executeWorkflow('wf-undelivered', new Date('2026-05-15T16:45:00.000Z'));

    assert.equal(recorded.status, 'failed', 'an undelivered report must not read as succeeded');
    assert.match(recorded.errorSummary, /bot is not in this chat/);
    assert.equal(sessions.revoked.length, 1);
  });

  it('fails the run when it produces no reply to deliver', async () => {
    const workflow = {
      id: 'wf-empty',
      name: 'Empty',
      companyId: 'co-1',
      createdByUserId: 'user-1',
      departmentId: null,
      originChatId: 'oc_chat',
      compiledPrompt: 'Do the thing.',
      outputConfigJson: { deliveryChannel: 'lark' },
      scheduleConfigJson: { type: 'daily', timezone: 'Asia/Kolkata', time: { hour: 9, minute: 0 } },
    };
    const sessions = sessionSpy();
    const adapter = recordingAdapter('lark');
    let recorded: any = null;
    const prisma = {
      scheduledWorkflow: { findUnique: async () => workflow, update: async () => ({}) },
      scheduledWorkflowRun: {
        upsert: async () => ({ id: 'run-e' }),
        update: async (args: any) => { recorded = args.data; return {}; },
      },
      memberSession: sessions.memberSession,
    } as any;

    const svc = new ScheduledWorkflowService({
      prisma,
      piRuntime: { run: async () => ({ text: '   ' }) } as any,
      channelAdapters: { lark: adapter, larkDm: adapter, desktop: adapter },
      channelIdentityRepo: { resolveByUserId: async () => ok(identity) } as any,
      logger: noopLogger,
      clock: fakeClock as any,
      pollIntervalMs: 1_000,
      runTimeoutMs: 60_000,
    });

    await (svc as any).executeWorkflow('wf-empty', new Date('2026-05-15T16:45:00.000Z'));

    assert.equal(recorded.status, 'failed');
    assert.equal(adapter.delivered.length, 0, 'nothing to deliver means nothing is sent');
  });

  it('fails the run when the creator has no Lark identity to execute as', async () => {
    const workflow = {
      id: 'wf-noidentity',
      name: 'No identity',
      companyId: 'co-1',
      createdByUserId: 'user-1',
      departmentId: null,
      originChatId: 'oc_chat',
      compiledPrompt: 'Do the thing.',
      outputConfigJson: { deliveryChannel: 'lark' },
      scheduleConfigJson: { type: 'daily', timezone: 'Asia/Kolkata', time: { hour: 9, minute: 0 } },
    };
    const sessions = sessionSpy();
    let piCalled = false;
    const prisma = {
      scheduledWorkflow: { findUnique: async () => workflow, update: async () => ({}) },
      scheduledWorkflowRun: { upsert: async () => ({ id: 'run-n' }), update: async () => ({}) },
      memberSession: sessions.memberSession,
    } as any;

    const svc = new ScheduledWorkflowService({
      prisma,
      piRuntime: { run: async () => { piCalled = true; return { text: '' }; } } as any,
      channelAdapters: { lark: recordingAdapter('lark'), larkDm: recordingAdapter('lark'), desktop: recordingAdapter('desktop') },
      channelIdentityRepo: {
        // Resolvable member, but never connected Lark — so nothing to run as.
        resolveByUserId: async () => ok({ ...identity, larkOpenId: undefined, larkTenantKey: undefined }),
      } as any,
      logger: noopLogger,
      clock: fakeClock as any,
      pollIntervalMs: 1_000,
      runTimeoutMs: 60_000,
    });

    await (svc as any).executeWorkflow('wf-noidentity', new Date('2026-05-15T16:45:00.000Z'));

    assert.equal(piCalled, false, 'no container run without an identity to run as');
    assert.equal(sessions.created.length, 0, 'no session may be minted without an identity');
  });

  it('retries soon when the container was busy, instead of forfeiting the slot', async () => {
    const workflow = {
      id: 'wf-busy',
      name: 'Busy',
      companyId: 'co-1',
      createdByUserId: 'user-1',
      departmentId: null,
      originChatId: 'oc_chat',
      compiledPrompt: 'Do the thing.',
      outputConfigJson: { deliveryChannel: 'lark' },
      scheduleConfigJson: { type: 'daily', timezone: 'Asia/Kolkata', time: { hour: 9, minute: 0 } },
    };
    const sessions = sessionSpy();
    let workflowUpdate: any = null;
    const prisma = {
      scheduledWorkflow: {
        findUnique: async () => workflow,
        update: async (args: any) => { workflowUpdate = args.data; return {}; },
      },
      scheduledWorkflowRun: { upsert: async () => ({ id: 'run-b' }), update: async () => ({}) },
      memberSession: sessions.memberSession,
    } as any;

    const busy = Object.assign(new Error('Your Pi agent is busy.'), { code: 'user_busy' });
    const svc = new ScheduledWorkflowService({
      prisma,
      piRuntime: { run: async () => { throw busy; } } as any,
      channelAdapters: { lark: recordingAdapter('lark'), larkDm: recordingAdapter('lark'), desktop: recordingAdapter('desktop') },
      channelIdentityRepo: { resolveByUserId: async () => ok(identity) } as any,
      logger: noopLogger,
      clock: fakeClock as any,
      pollIntervalMs: 1_000,
      runTimeoutMs: 60_000,
    });

    await (svc as any).executeWorkflow('wf-busy', new Date('2026-05-15T16:45:00.000Z'));

    // The member was simply using their container. Waiting until tomorrow would
    // silently drop today's report.
    const next = workflowUpdate.nextRunAt as Date;
    const minutesOut = (next.getTime() - fakeClock.now().getTime()) / 60_000;
    assert.ok(minutesOut > 0 && minutesOut <= 5, `expected a near-term retry, got ${minutesOut} minutes`);
  });

  it('does not delay a natural slot that already comes sooner than the busy retry', async () => {
    const workflow = {
      id: 'wf-busy-soon',
      name: 'Busy but frequent',
      companyId: 'co-1',
      createdByUserId: 'user-1',
      departmentId: null,
      originChatId: 'oc_chat',
      compiledPrompt: 'Do the thing.',
      outputConfigJson: { deliveryChannel: 'lark' },
      scheduleConfigJson: { type: 'hourly', timezone: 'Asia/Kolkata', intervalHours: 1, minute: 0 },
    };
    const sessions = sessionSpy();
    let workflowUpdate: any = null;
    const prisma = {
      scheduledWorkflow: {
        findUnique: async () => workflow,
        update: async (args: any) => { workflowUpdate = args.data; return {}; },
      },
      scheduledWorkflowRun: { upsert: async () => ({ id: 'run-bs' }), update: async () => ({}) },
      memberSession: sessions.memberSession,
    } as any;

    const busy = Object.assign(new Error('busy'), { code: 'capacity_full' });
    const svc = new ScheduledWorkflowService({
      prisma,
      piRuntime: { run: async () => { throw busy; } } as any,
      channelAdapters: { lark: recordingAdapter('lark'), larkDm: recordingAdapter('lark'), desktop: recordingAdapter('desktop') },
      channelIdentityRepo: { resolveByUserId: async () => ok(identity) } as any,
      logger: noopLogger,
      clock: fakeClock as any,
      pollIntervalMs: 1_000,
      runTimeoutMs: 60_000,
    });

    await (svc as any).executeWorkflow('wf-busy-soon', new Date('2026-05-15T16:45:00.000Z'));

    const retryCeiling = new Date(fakeClock.now().getTime() + 5 * 60_000);
    assert.ok((workflowUpdate.nextRunAt as Date) <= retryCeiling);
  });

  it('carries the workflow department into the run so it does not default to the first one', async () => {
    const workflow = {
      id: 'wf-dept',
      name: 'Finance only',
      companyId: 'co-1',
      createdByUserId: 'user-1',
      departmentId: 'dept-finance',
      originChatId: 'oc_chat',
      compiledPrompt: 'Do the thing.',
      outputConfigJson: { deliveryChannel: 'lark' },
      scheduleConfigJson: { type: 'daily', timezone: 'Asia/Kolkata', time: { hour: 9, minute: 0 } },
    };
    const sessions = sessionSpy();
    let capturedInput: any = null;
    const prisma = {
      scheduledWorkflow: { findUnique: async () => workflow, update: async () => ({}) },
      scheduledWorkflowRun: { upsert: async () => ({ id: 'run-d' }), update: async () => ({}) },
      memberSession: sessions.memberSession,
    } as any;

    const svc = new ScheduledWorkflowService({
      prisma,
      piRuntime: { run: async (input: any) => { capturedInput = input; return { text: 'done' }; } } as any,
      channelAdapters: { lark: recordingAdapter('lark'), larkDm: recordingAdapter('lark'), desktop: recordingAdapter('desktop') },
      channelIdentityRepo: {
        // The member also belongs to another department, which is what the
        // container would otherwise pick.
        resolveByUserId: async () => ok({ ...identity, activeDepartmentId: 'dept-sales' }),
      } as any,
      logger: noopLogger,
      clock: fakeClock as any,
      pollIntervalMs: 1_000,
      runTimeoutMs: 60_000,
    });

    await (svc as any).executeWorkflow('wf-dept', new Date('2026-05-15T16:45:00.000Z'));

    assert.equal(capturedInput.runContext.departmentId, 'dept-finance');
  });

  it('delivers a desktop-created schedule to the creator Lark DM, not the desktop thread', async () => {
    const workflow = {
      id: 'wf-desktop',
      name: 'Daily review',
      companyId: 'co-1',
      createdByUserId: 'user-1',
      departmentId: 'dept-finance',
      originChatId: 'desktop-thread-1',
      compiledPrompt: 'Review new invoices and summarize exceptions.',
      outputConfigJson: { deliveryChannel: 'desktop' },
      scheduleConfigJson: { type: 'daily', timezone: 'Asia/Kolkata', time: { hour: 9, minute: 0 } },
    };
    let capturedInput: any = null;
    const sessions = sessionSpy();
    const desktopAdapter = recordingAdapter('desktop');
    const larkDmAdapter = recordingAdapter('lark');
    const prisma = {
      scheduledWorkflow: { findUnique: async () => workflow, update: async () => ({}) },
      scheduledWorkflowRun: { upsert: async () => ({ id: 'run-desktop' }), update: async () => ({}) },
      memberSession: sessions.memberSession,
    } as any;
    const svc = new ScheduledWorkflowService({
      prisma,
      piRuntime: {
        run: async (input: any) => { capturedInput = input; return { text: 'Done' }; },
      } as any,
      channelAdapters: { lark: recordingAdapter('lark'), larkDm: larkDmAdapter, desktop: desktopAdapter },
      channelIdentityRepo: { resolveByUserId: async () => ok(identity) } as any,
      logger: noopLogger,
      clock: fakeClock as any,
      pollIntervalMs: 1_000,
      runTimeoutMs: 60_000,
    });

    await (svc as any).executeWorkflow('wf-desktop', new Date('2026-05-15T16:45:00.000Z'));

    // Scheduling from the desktop is still allowed; the result arrives in Lark,
    // because that is where Divo can reach the creator privately.
    assert.equal(capturedInput.incoming.channel, 'lark');
    assert.equal(capturedInput.runContext.channel, 'lark');
    assert.equal(capturedInput.runContext.departmentId, 'dept-finance');
    assert.equal(capturedInput.conversation.chatId, 'ou_123');

    assert.equal(capturedInput.runContext.tenantId, 'tenant-1');
    assert.equal(desktopAdapter.delivered.length, 0);
    assert.equal(larkDmAdapter.delivered.length, 1);
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
      scheduleConfigJson: { type: 'daily', timezone: 'Asia/Kolkata', time: { hour: 9, minute: 0 } },
    };
    let capturedInput: any = null;
    const sessions = sessionSpy();
    const larkDmAdapter = recordingAdapter('lark');
    const prisma = {
      scheduledWorkflow: { findUnique: async () => workflow, update: async () => ({}) },
      scheduledWorkflowRun: { upsert: async () => ({ id: 'run-creator-dm' }), update: async () => ({}) },
      memberSession: sessions.memberSession,
    } as any;
    const svc = new ScheduledWorkflowService({
      prisma,
      piRuntime: {
        run: async (input: any) => { capturedInput = input; return { text: 'Done' }; },
      } as any,
      channelAdapters: { lark: recordingAdapter('lark'), larkDm: larkDmAdapter, desktop: recordingAdapter('desktop') },
      channelIdentityRepo: {
        resolveByUserId: async () => ok({ ...identity, larkOpenId: 'ou_creator' }),
      } as any,
      logger: noopLogger,
      clock: fakeClock as any,
      pollIntervalMs: 1_000,
      runTimeoutMs: 60_000,
    });

    await (svc as any).executeWorkflow('wf-creator-dm', new Date('2026-05-15T16:45:00.000Z'));

    assert.equal(capturedInput.incoming.channel, 'lark');
    assert.equal(capturedInput.runContext.channel, 'lark');
    assert.equal(capturedInput.runContext.chatId, 'ou_creator');
    assert.equal(capturedInput.runContext.deliveryMode, 'scheduled_runtime_delivery');
    assert.equal(capturedInput.conversation.chatId, 'ou_creator');
    assert.match(capturedInput.incoming.text, /authenticated schedule creator's Lark DM/i);
    assert.match(capturedInput.incoming.text, /Do not call larkMessaging/i);
    assert.equal(larkDmAdapter.delivered.length, 1);
  });
});
