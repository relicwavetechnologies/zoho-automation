import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMailAutomationsTool } from '../../src/application/orchestration/tools/families/mail-automations.tool.ts';
import {
  MAIL_OPS_SYSTEM_SKILLS,
  provisionMailOpsPermissionsForExistingCompanies,
} from '../../src/application/skills/mail-ops-system-skills.ts';
import { makeCtx } from './tool-test.helpers.ts';

const connectionId = '11111111-1111-4111-8111-111111111111';

describe('mailAutomations tool', () => {
  it('creates an idempotent user-owned Gmail rule for the current Lark chat', async () => {
    let createInput: any;
    const tool = createMailAutomationsTool({
      pubsubReady: true,
      repo: {
        createRuleForMailbox: async input => {
          createInput = input;
          return {
            ok: true,
            value: { ruleId: 'rule-1', subscriptionId: 'mailbox-1' },
          };
        },
        listRulesForUser: async () => ({ ok: true, value: [] }),
        setRuleStatus: async () => ({ ok: true, value: true }),
      } as any,
      resolveConnection: async () => ({
        status: 'resolved',
        connectionId,
        mailboxEmail: 'user@example.com',
      }),
    });
    const args = {
      operation: 'create' as const,
      connectionId,
      name: 'Forward login OTP',
      match: {
        from: 'alerts@example.com',
        subjectContains: 'OTP',
      },
      destination: { type: 'current_lark_chat' as const },
    };
    const ctx = makeCtx('mailAutomations', ['create', 'execute'], {
      channel: 'lark',
      chatId: 'oc_current',
    });

    assert.equal(tool.permissionCheck(args, ctx.perm).ok, true);
    const result = await tool.execute(args, ctx);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.rule?.status, 'active');
    assert.equal(result.ok && result.value.rule?.ruleId, 'rule-1');
    assert.deepEqual(createInput.match, {
      from: 'alerts@example.com',
      subjectContains: 'OTP',
    });
    assert.deepEqual(createInput.action, { type: 'deliver' });
    assert.deepEqual(createInput.destination, {
      type: 'lark_chat',
      chatId: 'oc_current',
    });
    assert.match(createInput.dedupeKey, /^mail-rule:/);
  });

  it('starts deferred OAuth and ends the run contract when no owned account exists', async () => {
    let authorizationInput: any;
    const tool = createMailAutomationsTool({
      pubsubReady: true,
      repo: {
        createRuleForMailbox: async () => {
          throw new Error('Rule must not be created before OAuth.');
        },
        listRulesForUser: async () => ({ ok: true, value: [] }),
        setRuleStatus: async () => ({ ok: true, value: true }),
      } as any,
      resolveConnection: async () => ({
        status: 'unavailable',
        reason: 'Connect Google to continue.',
      }),
      beginAuthorization: async input => {
        authorizationInput = input;
        return { status: 'sent', intentId: 'intent-1' };
      },
    });
    const connectionAuthorization = {
      larkOpenId: 'ou_user',
      larkTenantKey: 'tenant-1',
      chatId: 'oc_current',
      chatType: 'p2p',
      originalMessageId: 'om_request',
      replyInThread: false,
      originalRequest: 'Forward future OTP mail here',
    };

    const result = await tool.execute({
      operation: 'create',
      name: 'Forward login OTP',
      match: { subjectContains: 'OTP' },
      destination: { type: 'current_lark_chat' },
    }, makeCtx('mailAutomations', ['create', 'execute'], {
      channel: 'lark',
      chatId: 'oc_current',
      connectionAuthorization,
    }));

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.value.code,
      'google_workspace_authorization_pending',
    );
    assert.equal(authorizationInput.toolId, 'mailAutomations');
    assert.deepEqual(
      authorizationInput.runContext.connectionAuthorization,
      connectionAuthorization,
    );
  });

  it('replaces an owned rule without creating a second rule', async () => {
    let replaced: any;
    const tool = createMailAutomationsTool({
      pubsubReady: true,
      repo: {
        createRuleForMailbox: async () => {
          throw new Error('Update must not create another rule.');
        },
        replaceRule: async input => {
          replaced = input;
          return { ok: true, value: true };
        },
        listRulesForUser: async () => ({ ok: true, value: [] }),
        setRuleStatus: async () => ({ ok: true, value: true }),
      } as any,
      resolveConnection: async () => ({
        status: 'resolved',
        connectionId,
        mailboxEmail: 'user@example.com',
      }),
    });

    const result = await tool.execute({
      operation: 'update',
      ruleId: '22222222-2222-4222-8222-222222222222',
      connectionId,
      name: 'Forward security codes',
      match: { from: 'security@example.com' },
      destination: { type: 'email', email: 'owner@example.com' },
    }, makeCtx('mailAutomations', ['update', 'execute'], { channel: 'lark' }));

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.operation, 'update');
    assert.equal(
      replaced.ruleId,
      '22222222-2222-4222-8222-222222222222',
    );
    assert.deepEqual(replaced.action, { type: 'forward' });
    assert.deepEqual(replaced.destination, {
      type: 'email',
      email: 'owner@example.com',
    });
  });

  it('requires background execute access when creating a durable rule', () => {
    const tool = createMailAutomationsTool({
      pubsubReady: true,
      repo: {} as any,
      resolveConnection: async () => ({
        status: 'unavailable',
        reason: 'unused',
      }),
    });
    const permission = tool.permissionCheck({
      operation: 'create',
      name: 'Forward OTP',
      match: { subjectContains: 'OTP' },
      destination: { type: 'email', email: 'owner@example.com' },
    }, makeCtx('mailAutomations', ['create']).perm);

    assert.equal(permission.ok, false);
    assert.equal(
      !permission.ok && permission.error.payload.action,
      'execute',
    );
  });

  it('requires background execute access when updating or resuming a rule', () => {
    const tool = createMailAutomationsTool({
      pubsubReady: true,
      repo: {} as any,
      resolveConnection: async () => ({
        status: 'unavailable',
        reason: 'unused',
      }),
    });
    const update = tool.permissionCheck({
      operation: 'update',
      ruleId: '22222222-2222-4222-8222-222222222222',
      connectionId,
      name: 'Forward OTP',
      match: { subjectContains: 'OTP' },
      destination: { type: 'email', email: 'owner@example.com' },
    }, makeCtx('mailAutomations', ['update']).perm);
    const resume = tool.permissionCheck({
      operation: 'resume',
      ruleId: '22222222-2222-4222-8222-222222222222',
    }, makeCtx('mailAutomations', ['update']).perm);

    assert.equal(update.ok, false);
    assert.equal(resume.ok, false);
  });

  it('does not resume a rule when Pub/Sub is not configured', async () => {
    let statusCalls = 0;
    const tool = createMailAutomationsTool({
      pubsubReady: false,
      repo: {
        setRuleStatus: async () => {
          statusCalls += 1;
          return { ok: true, value: true };
        },
      } as any,
      resolveConnection: async () => ({
        status: 'unavailable',
        reason: 'unused',
      }),
    });

    const result = await tool.execute({
      operation: 'resume',
      ruleId: '22222222-2222-4222-8222-222222222222',
    }, makeCtx('mailAutomations', ['update', 'execute']));

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.value.code,
      'mail_ops_configuration_required',
    );
    assert.match(
      result.ok ? result.value.message ?? '' : '',
      /Do not substitute Scheduler or a Gmail filter/,
    );
    assert.equal(statusCalls, 0);
  });

  it('publishes one instruction-only router and one executable DB specialist', () => {
    const router = MAIL_OPS_SYSTEM_SKILLS.find(
      skill => skill.slug === 'google-workspace-router',
    );
    const mailOps = MAIL_OPS_SYSTEM_SKILLS.find(
      skill => skill.slug === 'mail-ops',
    );

    assert(router);
    assert.deepEqual(router.toolIds, []);
    assert(router.tags.includes('router'));
    assert.match(router.markdown, /Always load the routed specialist/);
    assert.match(router.markdown, /send a Connect Google card/);
    assert.match(mailOps.markdown, /mail_ops_configuration_required/);
    assert.match(mailOps.markdown, /Never substitute Scheduler/);
    assert.match(router.markdown, /future matching Gmail message arrives/);
    assert.match(router.markdown, /load `mail-ops`/);
    assert.match(router.markdown, /load `schedule-divo-work` and `google-gmail`/);
    assert(mailOps);
    assert.deepEqual(mailOps.toolIds, ['mailAutomations']);
    assert.match(mailOps.markdown, /do not invoke an LLM/i);
    assert.match(mailOps.markdown, /per-message approval/i);
    assert.match(mailOps.markdown, /does not retransmit attachments/i);
  });

  it('grants every Mail Ops action to every existing department role once', async () => {
    let createManyInput: any;
    const result = await provisionMailOpsPermissionsForExistingCompanies({
      company: {
        findMany: async () => [{ id: 'company-1' }],
      },
      adminMembership: {
        findFirst: async () => ({ userId: 'admin-1' }),
      },
      departmentRole: {
        findMany: async () => [
          { id: 'manager-role', departmentId: 'department-1' },
          { id: 'member-role', departmentId: 'department-1' },
        ],
      },
      departmentToolPermission: {
        createMany: async (input: any) => {
          createManyInput = input;
          return { count: 10 };
        },
      },
    } as any);

    assert.deepEqual(result, { companies: 1, roles: 2, created: 10 });
    assert.equal(createManyInput.skipDuplicates, true);
    assert.deepEqual(
      createManyInput.data
        .filter((row: any) => row.roleId === 'member-role')
        .map((row: any) => row.actionGroup),
      ['read', 'create', 'update', 'delete', 'execute'],
    );
    assert(createManyInput.data.every(
      (row: any) =>
        row.toolId === 'mailAutomations'
        && row.allowed === true
        && row.updatedBy === 'admin-1',
    ));
  });
});
