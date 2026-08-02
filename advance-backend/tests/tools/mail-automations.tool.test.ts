import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createMailAutomationsTool,
  mailOpsConnectionUnavailableMessage,
} from '../../src/application/tools/families/mail-automations.tool.ts';
import {
  MAIL_OPS_SYSTEM_SKILLS,
  provisionMailOpsPermissionsForExistingCompanies,
} from '../../src/application/skills/mail-ops-system-skills.ts';
import {
  mailRuleMatchSchema,
  mailRuleMatches,
  parseMailRule,
} from '../../src/application/mail-ops/mail-rule.matcher.ts';
import { mailRuleDedupeKey } from '../../src/application/mail-ops/mail-ops.types.ts';
import type {
  MailMessageMetadata,
  MailRuleIdentity,
} from '../../src/application/mail-ops/mail-ops.types.ts';
import { makeCtx } from './tool-test.helpers.ts';

const connectionId = '11111111-1111-4111-8111-111111111111';

describe('mailAutomations tool', () => {
  it('creates an idempotent user-owned Gmail rule for the current Lark chat', async () => {
    let createInput: any;
    const tool = createMailAutomationsTool({
      runtime: { pubsubConfigured: true, workersEnabled: true },
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
    assert.equal(result.ok && result.value.rule?.valid, true);
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

  it('reports legacy invalid rules instead of presenting them as healthy', async () => {
    const tool = createMailAutomationsTool({
      runtime: { pubsubConfigured: true, workersEnabled: true },
      repo: {
        listRulesForUser: async () => ({
          ok: true,
          value: [{
            ruleId: 'rule-1',
            name: 'Forward Anthropic emails',
            status: 'active',
            mailboxEmail: 'user@example.com',
            connectionId,
            match: { from: 'anthropic' },
            action: { type: 'forward' },
            destination: {
              type: 'email',
              email: 'owner@example.com',
            },
            createdAt: new Date('2026-07-29T05:00:00.000Z'),
          }],
        }),
      } as any,
      resolveConnection: async () => ({
        status: 'unavailable',
        reason: 'unused',
      }),
    });

    const result = await tool.execute(
      { operation: 'list' },
      makeCtx('mailAutomations', ['read']),
    );

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.rules?.[0]?.valid, false);
    assert.match(
      result.ok ? result.value.rules?.[0]?.invalidReason ?? '' : '',
      /exact email address or an @domain/,
    );
  });

  it('requires an exact sender address or domain and ignores display-name spoofing', () => {
    assert.equal(mailRuleMatchSchema.safeParse({ from: 'anthropic' }).success, false);
    assert.equal(mailRuleMatchSchema.safeParse({ from: '@anthropic.com' }).success, true);
    assert.equal(mailRuleMatches(
      { from: '@anthropic.com' },
      {
        from: 'Anthropic <notice@anthropic.com>',
        to: 'user@example.com',
        subject: 'Account notice',
        snippet: '',
        bodyText: '',
        hasAttachment: false,
      },
    ), true);
    assert.equal(mailRuleMatches(
      { from: '@anthropic.com' },
      {
        from: '"support@anthropic.com" <attacker@evil.example>',
        to: 'user@example.com',
        subject: 'Account notice',
        snippet: '',
        bodyText: '',
        hasAttachment: false,
      },
    ), false);
    // The display position of `From` is as free as a recipient's, and with no
    // angle brackets the leftmost address in the raw header is not the
    // sender's. `From: (receipts@stripe.com) evil@attacker.tld` is a legal
    // header from `evil@attacker.tld`.
    const sender = (from: string): MailMessageMetadata => ({
      from,
      to: 'user@example.com',
      subject: 'Account notice',
      snippet: '',
      bodyText: '',
      hasAttachment: false,
    });
    assert.equal(mailRuleMatches(
      { from: '@anthropic.com' },
      sender('(notice@anthropic.com) attacker@evil.example'),
    ), false);
    assert.equal(mailRuleMatches(
      { from: '@anthropic.com' },
      sender('"notice@anthropic.com" attacker@evil.example'),
    ), false);
    // Honest senders, bracketed and bare, still match.
    assert.equal(mailRuleMatches(
      { from: '@anthropic.com' },
      sender('Jane (Support) <notice@anthropic.com>'),
    ), true);
    assert.equal(
      mailRuleMatches({ from: '@anthropic.com' }, sender('notice@anthropic.com')),
      true,
    );
    // Escapes are honoured inside a quote, which is how one can be walked back
    // out of: the `\\` is consumed as an escaped backslash, the next quote
    // closes the name, and the real mailbox is left inside a quote that never
    // ends. A header that ran out mid-name is not a header.
    assert.equal(mailRuleMatches(
      { from: '@anthropic.com' },
      sender('"a\\\\"notice@anthropic.com" <attacker@evil.example>'),
    ), false);
    // An unquoted comma in a display name is invalid and still emitted. One
    // bracketed mailbox and no ambiguity, so the rule keeps firing.
    assert.equal(mailRuleMatches(
      { from: 'notice@anthropic.com' },
      sender('Doe, John <notice@anthropic.com>'),
    ), true);
    // Two candidates is ambiguity, and the recovery does not choose. It counts
    // every bracketed mailbox, not one per entry, or a second one sharing an
    // entry with the first would go uncounted.
    assert.equal(mailRuleMatches(
      { from: 'notice@anthropic.com' },
      sender('Doe, John <notice@anthropic.com> <attacker@evil.example>'),
    ), false);
    // With no brackets the address must be a token, not sit inside one. This
    // holds no mailbox at all — `?` and `=` are legal in a local part, so
    // reading one out of the middle let text that is not an address satisfy
    // the rule.
    assert.equal(mailRuleMatches(
      { from: '@anthropic.com' },
      sender('=?utf-8?q?notice@anthropic.com?x, <attacker@evil.example>'),
    ), false);
    // And two bare addresses side by side name no single sender.
    assert.equal(mailRuleMatches(
      { from: '@anthropic.com' },
      sender('notice@anthropic.com attacker@evil.example'),
    ), false);
  });

  it('matches a recipient across To, Cc and Delivered-To, not To alone', () => {
    const message = (headers: Partial<MailMessageMetadata>): MailMessageMetadata => ({
      from: 'Payroll <payroll@example.com>',
      to: 'everyone@example.com',
      subject: 'March payslips',
      snippet: '',
      bodyText: '',
      hasAttachment: false,
      ...headers,
    });

    // Being copied is not a different event to the person receiving the mail.
    assert.equal(
      mailRuleMatches({ to: 'ana@example.com' }, message({ cc: 'Ana <ana@example.com>, bo@example.com' })),
      true,
    );
    // The header that survives an alias expansion, where the address the user
    // typed appears nowhere else in the message.
    assert.equal(
      mailRuleMatches({ to: 'ana@example.com' }, message({ deliveredTo: 'ana@example.com' })),
      true,
    );
    // An event recorded before recipient headers were captured still matches
    // on the one header it has.
    assert.equal(
      mailRuleMatches({ to: 'ana@example.com' }, message({ to: 'ana@example.com' })),
      true,
    );
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, message({})), false);
  });

  it('reads a recipient as a whole mailbox rather than a substring', () => {
    const message: MailMessageMetadata = {
      from: 'alerts@example.com',
      to: '"ana@example.com" <impostor@evil.example>, dana@example.com',
      subject: 'Notice',
      snippet: '',
      bodyText: '',
      hasAttachment: false,
    };
    // `dana@example.com` contains `ana@example.com`, and the display name
    // claims to be it outright. Neither is the mailbox the rule named.
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, message), false);
    assert.equal(mailRuleMatches({ to: '@example.com' }, message), true);
    assert.equal(mailRuleMatches({ to: 'dana@example.com' }, message), true);

    // A display name may legally hold a comma, and splitting the header
    // through one left a fragment reading as the address it imitates — enough
    // for any sender to fire someone else's rule at will.
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, {
      ...message,
      to: '"ana@example.com, VIP" <impostor@evil.example>',
    }), false);
    // A name is quoted text and may hold an escaped quote, so ending it at the
    // first `"` walks straight back out of the quotes and into the same trick.
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, {
      ...message,
      to: '"a \\" ana@example.com, VIP" <impostor@evil.example>',
    }), false);
    // A quoted name is not the only free text in the display position. A
    // comment and an encoded word can both hold a comma too, and an outsider
    // sending one of these to a member would otherwise fire that member's rule
    // on the outsider's own mail.
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, {
      ...message,
      to: '(ana@example.com, VIP) <impostor@evil.example>',
    }), false);
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, {
      ...message,
      to: 'Jane (ana@example.com, VIP) <impostor@evil.example>',
    }), false);
    // `?` and `=` are legal in an address, so an encoded word's tail reads as
    // one to a domain rule even when it does not to an exact-mailbox rule.
    assert.equal(mailRuleMatches({ to: '@example.com' }, {
      ...message,
      to: '=?utf-8?Q?ana@example.com,_x?= <impostor@evil.tld>',
    }), false);
    // Honest versions of all of it still resolve to the real mailbox.
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, {
      ...message,
      to: '"Smith, Ana" <ana@example.com>, bo@example.com',
    }), true);
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, {
      ...message,
      to: 'Jane <ana@example.com> (assistant), bo@example.com',
    }), true);
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, {
      ...message,
      to: '=?utf-8?Q?Ana_Smith?= <ana@example.com>',
    }), true);
    // A `=?` whose terminator lies past a space is not an encoded word.
    // Reading it as one blanked its way across the opening quote, which both
    // dropped the recipient that quote belonged to and left the display text
    // behind it standing as an address.
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, {
      ...message,
      to: '=?a?b? " ?= ana@example.com" <impostor@evil.example>',
    }), false);
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, {
      ...message,
      to: '=?utf-8?q?x <ana@example.com>, =?utf-8?q?y?= <bo@example.com>',
    }), true);
    // Same escaped-backslash walk-out on the recipient side.
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, {
      ...message,
      to: '"a\\\\"ana@example.com" <impostor@evil.example>',
    }), false);
    // Dropping the entry that ran out must not drop the ones that parsed.
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, {
      ...message,
      to: 'ana@example.com, "unterminated <bo@example.com>',
    }), true);
    // Group syntax, with and without the space a group label usually has after
    // it, and the semicolon some clients use to separate recipients outright.
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, {
      ...message,
      to: 'Team:ana@example.com,bob@example.com;',
    }), true);
    assert.equal(mailRuleMatches({ to: 'bob@example.com' }, {
      ...message,
      to: 'Team: ana@example.com, bob@example.com;',
    }), true);
    assert.equal(mailRuleMatches({ to: 'ana@example.com' }, {
      ...message,
      to: 'ana@example.com; bob@example.com',
    }), true);
  });

  it('keeps a stored free-text recipient rule firing while refusing to create another', () => {
    const stored = parseMailRule({
      match: { to: 'Anthropic' },
      action: { type: 'forward' },
      destination: { type: 'email', email: 'person@example.com' },
    });
    assert.equal(mailRuleMatches(stored.match, {
      from: 'alerts@example.com',
      to: 'Anthropic Billing <billing@anthropic.com>',
      subject: 'Invoice',
      snippet: '',
      bodyText: '',
      hasAttachment: false,
    }), true);
    // Still `To` alone, though. A free-text rule is the loosest shape in the
    // system, and letting it start reading three more headers would widen a
    // rule nobody asked to change.
    assert.equal(mailRuleMatches(stored.match, {
      from: 'alerts@example.com',
      to: 'someone@example.com',
      cc: 'Anthropic Billing <billing@anthropic.com>',
      subject: 'Invoice',
      snippet: '',
      bodyText: '',
      hasAttachment: false,
    }), false);
    // Tightening how a rule is written must not stop the rules already written.
    assert.equal(mailRuleMatchSchema.safeParse({ to: 'Anthropic' }).success, false);
  });

  it('refuses a match that names no message and one that invents a field', () => {
    // Forwards every message carrying a file, including every signature logo.
    assert.equal(mailRuleMatchSchema.safeParse({ hasAttachment: true }).success, false);
    assert.equal(
      mailRuleMatchSchema.safeParse({ subjectContains: 'Invoice', hasAttachment: true }).success,
      true,
    );
    // Previously stripped, leaving a rule that matched `from` alone and
    // reported success — the narrowing the user asked for silently gone.
    assert.equal(
      mailRuleMatchSchema.safeParse({ from: '@x.example', cc: 'finance@y.example' }).success,
      false,
    );
  });

  it('tells the member which way out of a collision applies to them', async () => {
    const toolFor = (outcome: string) => createMailAutomationsTool({
      runtime: { pubsubConfigured: true, workersEnabled: true },
      repo: {
        replaceRule: async () => ({ ok: true, value: outcome }),
        listRulesForUser: async () => ({ ok: true, value: [] }),
      } as any,
      resolveConnection: async () => ({
        status: 'resolved',
        connectionId,
        mailboxEmail: 'user@example.com',
      }),
    });
    const args = {
      operation: 'update' as const,
      ruleId: '22222222-2222-4222-8222-222222222222',
      connectionId,
      name: 'Forward OTP',
      match: { subjectContains: 'otp' },
      destination: { type: 'email' as const, email: 'owner@example.com' },
    };
    const ctx = () => makeCtx('mailAutomations', ['update', 'execute']);

    const live = await toolFor('duplicate').execute(args, ctx());
    assert.equal(live.ok, false);
    // Two live rules on one key forward twice; the fix is to archive one.
    assert.match(!live.ok ? live.error.message : '', /twice/);
    assert.match(!live.ok ? live.error.message : '', /archive/i);

    const archived = await toolFor('duplicate_archived').execute(args, ctx());
    assert.equal(archived.ok, false);
    // An archived rule forwards nothing, so saying "twice" would be untrue and
    // archiving it again is not a way out. Recreating it is.
    assert.doesNotMatch(!archived.ok ? archived.error.message : '', /twice/);
    assert.match(!archived.ok ? archived.error.message : '', /Create the rule/);
  });

  it('gives one rule one identity however the request was written', () => {
    const identity: MailRuleIdentity = {
      companyId: 'company-1',
      userId: 'user-1',
      connectionId: 'connection-1',
      match: { from: 'alerts@example.com', subjectContains: 'OTP' },
      action: { type: 'forward' },
      destination: { type: 'email', email: 'person@example.com' },
    };

    // Matching is case-insensitive, so these two rules watch exactly the same
    // mail. Keying them apart made both active and forwarded every matching
    // message twice.
    assert.equal(
      mailRuleDedupeKey({
        ...identity,
        match: { from: 'Alerts@Example.com', subjectContains: 'otp' },
        destination: { type: 'email', email: 'Person@Example.com' },
      }),
      mailRuleDedupeKey(identity),
    );
    assert.equal(
      mailRuleDedupeKey({
        ...identity,
        match: { subjectContains: 'OTP', from: 'alerts@example.com' },
      }),
      mailRuleDedupeKey(identity),
    );
    // A Lark chat ID is opaque: two IDs differing in case are two chats.
    const chat = { ...identity, action: { type: 'deliver' as const } };
    assert.notEqual(
      mailRuleDedupeKey({ ...chat, destination: { type: 'lark_chat', chatId: 'oc_A' } }),
      mailRuleDedupeKey({ ...chat, destination: { type: 'lark_chat', chatId: 'oc_a' } }),
    );
    // And a rule that watches something else is still a different rule.
    assert.notEqual(
      mailRuleDedupeKey({ ...identity, match: { from: 'alerts@example.com' } }),
      mailRuleDedupeKey(identity),
    );
  });

  it('starts deferred OAuth and ends the run contract when no owned account exists', async () => {
    let authorizationInput: any;
    const tool = createMailAutomationsTool({
      runtime: { pubsubConfigured: true, workersEnabled: true },
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
    const result = await tool.execute({
      operation: 'create',
      name: 'Forward login OTP',
      match: { subjectContains: 'OTP' },
      destination: { type: 'current_lark_chat' },
    }, makeCtx('mailAutomations', ['create', 'execute'], {
      channel: 'lark',
      chatId: 'oc_current',
      runtimeRunId: 'run-1',
    }));

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.value.code,
      'google_workspace_authorization_pending',
    );
    assert.equal(authorizationInput.toolId, 'mailAutomations');
    // The tool's only job here is to hand the live run context over intact.
    // Whether an authorization can actually be started from it is decided by
    // createBeginGoogleAuthorization, and is asserted against the real closure
    // in begin-google-authorization.test.ts — this test used to hand-build the
    // precondition production never supplied, and stayed green over dead code.
    assert.equal(authorizationInput.runContext.runtimeRunId, 'run-1');
  });

  it('lets a member stop a rule they are no longer allowed to edit', async () => {
    // pause shares the update action group with editing, so revoking update to
    // stop members rewriting rules also took away the ability to stop a live
    // one. Anyone who can archive a rule can certainly pause it.
    const tool = createMailAutomationsTool({
      runtime: { pubsubConfigured: true, workersEnabled: true },
      repo: {} as any,
      resolveConnection: async () => ({ status: 'unavailable', reason: 'unused' }),
    });

    const deleteOnly = {
      allowedActionsByTool: new Map([
        ['mailAutomations', new Set(['read', 'delete'])],
      ]),
    } as any;

    assert.equal(
      tool.permissionCheck({ operation: 'pause', ruleId: 'r' } as any, deleteOnly).ok,
      true,
    );
    // Editing still needs update: this is not a general widening.
    assert.equal(
      tool.permissionCheck({
        operation: 'update',
        ruleId: 'r',
        connectionId: 'c',
        name: 'n',
        match: {},
        destination: { type: 'current_lark_chat' },
      } as any, deleteOnly).ok,
      false,
    );
  });

  it('will not create a rule on a connection whose owner gates background execution', async () => {
    // Approval is asked per interactive call. A rule makes calls nobody is
    // present for, so the moment to honour an `execute` policy is the moment
    // the rule is created — and it must use the resolved connection, since
    // omitting connectionId is exactly how the gateway's own check was dodged.
    let created = 0;
    let asked: any;
    const tool = createMailAutomationsTool({
      runtime: { pubsubConfigured: true, workersEnabled: true },
      repo: { createRuleForMailbox: async () => { created++; return { ok: true, value: {} }; } } as any,
      resolveConnection: async () => ({
        status: 'resolved',
        connectionId: '11111111-1111-4111-8111-111111111111',
        mailboxEmail: 'owner@example.com',
      }),
      connectionApproval: async input => { asked = input; return { kind: 'required' }; },
    });

    const result = await tool.execute({
      operation: 'create',
      name: 'Forward invoices',
      match: { subjectContains: 'Invoice' },
      destination: { type: 'email', email: 'finance@example.com' },
    }, makeCtx('mailAutomations', ['create', 'execute'], { channel: 'lark', chatId: 'oc_here' }));

    assert.equal(result.ok, false);
    assert.equal(created, 0);
    assert.deepEqual(asked, {
      companyId: 'co-test',
      connectionId: '11111111-1111-4111-8111-111111111111',
      action: 'execute',
    });
  });

  it('refuses a named Lark chat that belongs to another company', async () => {
    // destinationSchema accepted any chatId string, and the rule that a chat
    // must be discovered through governed means was prompt text only. Anything
    // the bot could post to was a legal destination.
    let created = 0;
    const tool = createMailAutomationsTool({
      runtime: { pubsubConfigured: true, workersEnabled: true },
      repo: { createRuleForMailbox: async () => { created++; return { ok: true, value: {} }; } } as any,
      resolveConnection: async () => ({
        status: 'resolved',
        connectionId: '11111111-1111-4111-8111-111111111111',
        mailboxEmail: 'owner@example.com',
      }),
      authorizeLarkChat: async () => ({ status: 'other_company' }),
    });

    const result = await tool.execute({
      operation: 'create',
      name: 'Forward invoices',
      match: { subjectContains: 'Invoice' },
      destination: { type: 'lark_chat', chatId: 'oc_someone_elses' },
    }, makeCtx('mailAutomations', ['create', 'execute'], { channel: 'lark', chatId: 'oc_here' }));

    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error.message : '', /different company/);
    assert.equal(created, 0);
  });

  it('tells a member how to ground a chat Divo has never seen', async () => {
    const tool = createMailAutomationsTool({
      runtime: { pubsubConfigured: true, workersEnabled: true },
      repo: {} as any,
      resolveConnection: async () => ({
        status: 'resolved',
        connectionId: '11111111-1111-4111-8111-111111111111',
        mailboxEmail: 'owner@example.com',
      }),
      authorizeLarkChat: async () => ({ status: 'unknown_chat' }),
    });

    const result = await tool.execute({
      operation: 'create',
      name: 'Forward invoices',
      match: { subjectContains: 'Invoice' },
      destination: { type: 'lark_chat', chatId: 'oc_unknown' },
    }, makeCtx('mailAutomations', ['create', 'execute'], { channel: 'lark', chatId: 'oc_here' }));

    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.error.message : '', /Add Divo to the chat/);
  });

  it('does not re-ground the conversation the request already came from', async () => {
    // current_lark_chat resolves to the chat on the signed run context, which
    // arrived on a real inbound event for this company. Demanding a room record
    // for it would break every DM, which never has one.
    let checked = 0;
    let created: any;
    const tool = createMailAutomationsTool({
      runtime: { pubsubConfigured: true, workersEnabled: true },
      repo: {
        createRuleForMailbox: async (input: any) => {
          created = input;
          return { ok: true, value: { ruleId: 'rule-1', status: 'active', createdAt: new Date() } };
        },
      } as any,
      resolveConnection: async () => ({
        status: 'resolved',
        connectionId: '11111111-1111-4111-8111-111111111111',
        mailboxEmail: 'owner@example.com',
      }),
      authorizeLarkChat: async () => { checked++; return { status: 'unknown_chat' }; },
    });

    const result = await tool.execute({
      operation: 'create',
      name: 'Forward invoices',
      match: { subjectContains: 'Invoice' },
      destination: { type: 'current_lark_chat' },
    }, makeCtx('mailAutomations', ['create', 'execute'], { channel: 'lark', chatId: 'oc_here' }));

    assert.equal(result.ok, true);
    assert.equal(checked, 0);
    assert.equal(created.destination.chatId, 'oc_here');
  });

  it('names the actual remedy for each way a Google account can be unusable', () => {
    // One shared sentence used to send a member with a scope-limited account to
    // connect an account they already had, and a member with no account to
    // grant scopes on one that did not exist.
    const noAccount = mailOpsConnectionUnavailableMessage('none_accessible');
    const scopeLimited = mailOpsConnectionUnavailableMessage('insufficient_access');
    const wrongAccount = mailOpsConnectionUnavailableMessage('requested_not_accessible');

    assert.notEqual(noAccount, scopeLimited);
    assert.notEqual(noAccount, wrongAccount);
    assert.notEqual(scopeLimited, wrongAccount);
    assert.match(scopeLimited, /Reconnect/);
    assert.match(noAccount, /Connect Google/);
    assert.match(wrongAccount, /connectionId/);
  });

  it('tells an off-Lark member how to connect Google themselves', async () => {
    // No beginAuthorization means no card can be sent — a desktop run has no
    // conversation to put one in. Returning only the connection problem read as
    // a dead end; the member can connect Google perfectly well on their own.
    const tool = createMailAutomationsTool({
      runtime: { pubsubConfigured: true, workersEnabled: true },
      repo: {} as any,
      resolveConnection: async () => ({
        status: 'unavailable',
        connectionState: 'none_accessible',
        reason: 'Mail Ops needs a Google account you own.',
      }),
    });

    const result = await tool.execute({
      operation: 'create',
      name: 'Forward invoices',
      match: { subjectContains: 'Invoice' },
      destination: { type: 'email', email: 'finance@example.com' },
    }, makeCtx('mailAutomations', ['create', 'execute'], { channel: 'desktop' }));

    assert.equal(result.ok, false);
    assert.match(
      !result.ok ? result.error.message : '',
      /Connected apps/,
    );
  });

  it('replaces an owned rule without creating a second rule', async () => {
    let replaced: any;
    const tool = createMailAutomationsTool({
      runtime: { pubsubConfigured: true, workersEnabled: true },
      repo: {
        createRuleForMailbox: async () => {
          throw new Error('Update must not create another rule.');
        },
        replaceRule: async input => {
          replaced = input;
          return { ok: true, value: 'replaced' };
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
      runtime: { pubsubConfigured: true, workersEnabled: true },
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
      runtime: { pubsubConfigured: true, workersEnabled: true },
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
      runtime: { pubsubConfigured: false, workersEnabled: true },
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

  it('refuses to create a rule in an environment that runs no background work', async () => {
    // The defect this covers: Pub/Sub configured and autonomous workers off is
    // exactly how a cloned environment boots, and `create` used to answer
    // "Mail automation is active" for a rule nothing would ever pick up. The
    // tool could see one flag and not the other.
    let created = 0;
    const tool = createMailAutomationsTool({
      runtime: { pubsubConfigured: true, workersEnabled: false },
      repo: {
        createRuleForMailbox: async () => {
          created += 1;
          return { ok: true, value: { ruleId: 'rule-1', subscriptionId: 'mailbox-1' } };
        },
      } as any,
      resolveConnection: async () => ({
        status: 'resolved',
        connectionId,
        mailboxEmail: 'user@example.com',
      }),
    });

    const result = await tool.execute({
      operation: 'create',
      connectionId,
      name: 'Forward login OTP',
      match: { subjectContains: 'OTP' },
      destination: { type: 'email', email: 'owner@example.com' },
    }, makeCtx('mailAutomations', ['create', 'execute']));

    assert.equal(result.ok, true);
    assert.equal(
      result.ok && result.value.code,
      'mail_ops_configuration_required',
    );
    // Named separately from the Pub/Sub case: the fix is a different one, and
    // no amount of Google configuration would change this answer.
    assert.match(
      result.ok ? result.value.message ?? '' : '',
      /does not run background automations/,
    );
    assert.equal(created, 0);
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
    assert.match(
      mailOps.markdown,
      /preserves the original Gmail MIME content.*attachments/i,
    );
    assert.match(mailOps.markdown, /never convert a brand, display name, or loose word/i);
    assert.match(mailOps.markdown, /Ask whether subject narrowing is wanted/i);
  });

  it('never claims a capability the runtime does not implement', () => {
    const surfaces = [
      ...MAIL_OPS_SYSTEM_SKILLS.map(skill => skill.markdown),
      createMailAutomationsTool({
        repo: {} as any,
        runtime: { pubsubConfigured: true, workersEnabled: true },
        resolveConnection: async () => ({ status: 'unavailable', reason: '' }),
      }).parameterDocs ?? '',
    ];

    for (const surface of surfaces) {
      // No extractor exists: every action forwards or posts the whole message.
      assert.doesNotMatch(surface, /otp extraction/i);
      assert.doesNotMatch(surface, /extract(s|ing)? (the )?(otp|code)/i);
    }

    const mailOps = MAIL_OPS_SYSTEM_SKILLS.find(skill => skill.slug === 'mail-ops')!;
    // Constraints a user hits in practice must be stated where the model reads.
    assert.match(mailOps.markdown, /Gmail only/i);
    assert.match(mailOps.markdown, /delivers the whole message/i);
    assert.match(mailOps.markdown, /does \*\*not\*\* match \\?`?alerts@mail\.example\.com/i);
    assert.match(mailOps.markdown, /invalidReason/);
    assert.match(mailOps.markdown, /includeInactive/);
    assert.match(mailOps.markdown, /google_workspace_connection_selection_required/);
    assert.match(mailOps.markdown, /rejected on desktop and web/i);
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
