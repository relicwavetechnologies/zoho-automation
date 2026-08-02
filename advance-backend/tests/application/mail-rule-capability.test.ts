import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mailRuleMatchSchema,
  mailRuleMatches,
  parseMailRule,
} from '../../src/application/mail-ops/mail-rule.matcher.ts';
import { mailRuleDedupeKey } from '../../src/application/mail-ops/mail-ops.types.ts';
import type {
  MailMessageMetadata,
  MailRuleMatch,
} from '../../src/application/mail-ops/mail-ops.types.ts';
import { dryRunMailRule } from '../../src/application/mail-ops/mail-rule-dry-run.ts';

const message = (over: Partial<MailMessageMetadata> = {}): MailMessageMetadata => ({
  from: 'alerts@example.com',
  to: 'me@company.com',
  subject: 'Invoice 42',
  snippet: '',
  bodyText: 'body',
  hasAttachment: false,
  ...over,
});

// A Tuesday, 14:30 UTC.
const TUESDAY_AFTERNOON = new Date('2026-08-04T14:30:00.000Z');

const matches = (
  match: MailRuleMatch,
  over: Partial<MailMessageMetadata> = {},
  at: Date = TUESDAY_AFTERNOON,
): boolean => mailRuleMatches(match, message(over), at);

describe('exclusions', () => {
  it('drops a message from the excluded sender and keeps the rest', () => {
    const match: MailRuleMatch = {
      subjectContains: 'Invoice',
      notFrom: 'noreply@example.com',
    };
    assert.equal(matches(match), true);
    assert.equal(matches(match, { from: 'noreply@example.com' }), false);
  });

  it('excludes a whole domain, one mailbox at a time', () => {
    const match: MailRuleMatch = {
      subjectContains: 'Invoice',
      notFrom: '@spam.example',
    };
    assert.equal(matches(match, { from: 'anyone@spam.example' }), false);
    assert.equal(matches(match, { from: 'anyone@notspam.example' }), true);
  });

  it('refuses to fire when the sender cannot be read at all', () => {
    // Not evidence that the sender is somebody else. Losing the match is the
    // direction every other decision in the matcher leans; the alternative
    // forwards mail the member explicitly excluded, hiding behind a malformed
    // header.
    assert.equal(
      matches(
        { subjectContains: 'Invoice', notFrom: 'noreply@example.com' },
        { from: 'a@b.example c@d.example' },
      ),
      false,
    );
  });

  it('excludes on subject text without touching the body', () => {
    const match: MailRuleMatch = {
      from: '@example.com',
      notSubjectContains: 'reminder',
    };
    assert.equal(matches(match, { subject: 'Invoice 42' }), true);
    assert.equal(matches(match, { subject: 'Invoice 42 reminder' }), false);
    assert.equal(matches(match, { bodyText: 'reminder' }), true);
  });

  it('rejects a rule made of exclusions alone', () => {
    assert.equal(
      mailRuleMatchSchema.safeParse({ notFrom: 'a@example.com' }).success,
      false,
    );
  });

  it('rejects an exclusion that cancels its own match', () => {
    assert.equal(
      mailRuleMatchSchema.safeParse({
        from: 'billing@acme.com',
        notFrom: '@acme.com',
      }).success,
      false,
    );
    assert.equal(
      mailRuleMatchSchema.safeParse({
        subjectContains: 'Invoice reminder',
        notSubjectContains: 'reminder',
      }).success,
      false,
    );
    // Overlapping without cancelling is a legitimate rule.
    assert.equal(
      mailRuleMatchSchema.safeParse({
        from: '@acme.com',
        notFrom: 'noreply@acme.com',
      }).success,
      true,
    );
  });
});

describe('taking what people actually type', () => {
  const criterion = (raw: string): string | undefined => {
    const parsed = mailRuleMatchSchema.safeParse({ from: raw });
    return parsed.success ? parsed.data.from : undefined;
  };

  it('accepts a domain written without the @', () => {
    // The commonest thing anyone types. Refusing it over punctuation teaches
    // nobody anything.
    assert.equal(criterion('stripe.com'), '@stripe.com');
    assert.equal(criterion('@stripe.com'), '@stripe.com');
  });

  it('accepts a sender copied out of a mail client', () => {
    assert.equal(criterion('Alerts <alerts@stripe.com>'), 'alerts@stripe.com');
    assert.equal(criterion('<alerts@stripe.com>'), 'alerts@stripe.com');
    assert.equal(criterion('mailto:alerts@stripe.com'), 'alerts@stripe.com');
  });

  it('accepts a pasted URL and a fully-qualified trailing dot', () => {
    assert.equal(criterion('https://stripe.com/invoices'), '@stripe.com');
    assert.equal(criterion('stripe.com.'), '@stripe.com');
  });

  it('folds case, so one rule cannot become two', () => {
    assert.equal(criterion('  Alerts@Stripe.COM '), 'alerts@stripe.com');
  });

  it('still refuses a brand name rather than guessing a domain for it', () => {
    // `Stripe` → `@stripe.com` would be a guess, and the rule it builds is
    // wrong while being reported as right. That is the failure this whole
    // subsystem exists to stop, so the refusal has to say what to write.
    assert.equal(criterion('Stripe'), undefined);
    assert.equal(criterion('the finance team'), undefined);
    const refusal = mailRuleMatchSchema.safeParse({ from: 'Stripe' });
    assert.match(
      refusal.success ? '' : refusal.error.errors[0]!.message,
      /brand name on its own cannot be matched/i,
    );
  });
});

describe('@domain covers subdomains', () => {
  it('catches the sending subdomain a service actually mails from', () => {
    // The rule that used to be created, reported active, and never fire once.
    const match: MailRuleMatch = { from: '@stripe.com' };
    assert.equal(matches(match, { from: 'receipts@stripe.com' }), true);
    assert.equal(matches(match, { from: 'receipts@mail.stripe.com' }), true);
    assert.equal(matches(match, { from: 'x@a.b.stripe.com' }), true);
  });

  it('matches on label boundaries, never on string suffix', () => {
    // A plain `endsWith` hands anyone who registers a lookalike a rule that
    // was never meant for them.
    const match: MailRuleMatch = { from: '@example.com' };
    assert.equal(matches(match, { from: 'billing@notexample.com' }), false);
    assert.equal(matches(match, { from: 'billing@example.com.evil.tld' }), false);
  });

  it('reads a recipient criterion the same way', () => {
    assert.equal(
      matches(
        { to: '@company.com' },
        { to: 'team@eu.company.com' },
      ),
      true,
    );
  });

  it('excludes a subdomain when the exclusion names the parent', () => {
    const match: MailRuleMatch = {
      subjectContains: 'Invoice',
      notFrom: '@spam.example',
    };
    assert.equal(matches(match, { from: 'x@bulk.spam.example' }), false);
  });

  it('refuses a bare registry, which subdomains would make enormous', () => {
    for (const domain of ['@com', '@co.uk', '@com.au']) {
      assert.equal(
        mailRuleMatchSchema.safeParse({ from: domain }).success,
        false,
        domain,
      );
    }
    assert.equal(
      mailRuleMatchSchema.safeParse({ from: '@acme.co.uk' }).success,
      true,
    );
  });

  it('sees a contradiction that only exists once subdomains count', () => {
    // `from: @mail.acme.com` with `notFrom: @acme.com` cancels out completely
    // now. A contradiction check still using the old exact reading would accept
    // the rule and let it match nothing forever.
    assert.equal(
      mailRuleMatchSchema.safeParse({
        from: '@mail.acme.com',
        notFrom: '@acme.com',
      }).success,
      false,
    );
    // Still legitimate in the other direction: exclude one subdomain from a
    // rule watching the parent.
    assert.equal(
      mailRuleMatchSchema.safeParse({
        from: '@acme.com',
        notFrom: '@bounces.acme.com',
      }).success,
      true,
    );
  });
});

describe('activeWindow', () => {
  const officeHours = {
    subjectContains: 'Invoice',
    activeWindow: {
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '09:00',
      end: '18:00',
      timeZone: 'Asia/Kolkata',
    },
  } as const satisfies MailRuleMatch;

  it('is judged in the rule timezone, not the server one', () => {
    // 14:30 UTC is 20:00 in Kolkata — outside office hours there, inside them
    // in UTC. A rule read against the server clock would fire.
    assert.equal(matches(officeHours), false);
    // 06:00 UTC is 11:30 Kolkata, a Tuesday morning.
    assert.equal(
      matches(officeHours, {}, new Date('2026-08-04T06:00:00.000Z')),
      true,
    );
  });

  it('treats the window as half-open', () => {
    const window = {
      subjectContains: 'Invoice',
      activeWindow: { start: '09:00', end: '18:00', timeZone: 'UTC' },
    } as const satisfies MailRuleMatch;
    assert.equal(matches(window, {}, new Date('2026-08-04T09:00:00.000Z')), true);
    assert.equal(matches(window, {}, new Date('2026-08-04T17:59:00.000Z')), true);
    assert.equal(matches(window, {}, new Date('2026-08-04T18:00:00.000Z')), false);
  });

  it('keeps the days it was given', () => {
    // A Saturday, 11:00 UTC.
    assert.equal(
      matches(
        {
          subjectContains: 'Invoice',
          activeWindow: {
            days: ['mon', 'tue', 'wed', 'thu', 'fri'],
            start: '09:00',
            end: '18:00',
            timeZone: 'UTC',
          },
        },
        {},
        new Date('2026-08-08T11:00:00.000Z'),
      ),
      false,
    );
  });

  it('bills an overnight window to the day it opened on', () => {
    const overnight = {
      subjectContains: 'Invoice',
      activeWindow: {
        days: ['fri'],
        start: '22:00',
        end: '02:00',
        timeZone: 'UTC',
      },
    } as const satisfies MailRuleMatch;
    // Friday 23:00 — inside, plainly.
    assert.equal(matches(overnight, {}, new Date('2026-08-07T23:00:00.000Z')), true);
    // Saturday 01:00 — still Friday's window. Reading the calendar day would
    // make an overnight window ask for the wrong day at the hours it exists for.
    assert.equal(matches(overnight, {}, new Date('2026-08-08T01:00:00.000Z')), true);
    // Saturday 23:00 — Saturday's window, which this rule does not have.
    assert.equal(matches(overnight, {}, new Date('2026-08-08T23:00:00.000Z')), false);
  });

  it('refuses a timezone this runtime cannot resolve, at write and at read', () => {
    const bad = {
      subjectContains: 'Invoice',
      activeWindow: { start: '09:00', end: '18:00', timeZone: 'Mars/Olympus' },
    };
    assert.equal(mailRuleMatchSchema.safeParse(bad).success, false);
    // A stored rule fails the same way, so it reports itself broken rather
    // than silently matching everything or nothing.
    assert.throws(() => parseMailRule({
      match: bad,
      action: { type: 'forward' },
      destination: { type: 'email', email: 'x@example.com' },
    }));
  });

  it('refuses a window with no duration', () => {
    assert.equal(
      mailRuleMatchSchema.safeParse({
        subjectContains: 'Invoice',
        activeWindow: { start: '09:00', end: '09:00', timeZone: 'UTC' },
      }).success,
      false,
    );
  });
});

describe('organize rules', () => {
  it('takes no destination', () => {
    assert.throws(() => parseMailRule({
      match: { subjectContains: 'Invoice' },
      action: { type: 'organize', archive: true },
      destination: { type: 'email', email: 'x@example.com' },
    }));
    const parsed = parseMailRule({
      match: { subjectContains: 'Invoice' },
      action: { type: 'organize', label: 'Receipts', archive: true },
      destination: { type: 'none' },
    });
    assert.deepEqual(parsed.action, {
      type: 'organize',
      label: 'Receipts',
      archive: true,
    });
  });

  it('refuses an organize rule that does nothing', () => {
    assert.throws(() => parseMailRule({
      match: { subjectContains: 'Invoice' },
      action: { type: 'organize', archive: false, markRead: false },
      destination: { type: 'none' },
    }));
  });
});

describe('rule identity', () => {
  const identity = (over: Record<string, unknown> = {}) => ({
    companyId: 'company-1',
    userId: 'user-1',
    connectionId: 'connection-1',
    match: { subjectContains: 'Invoice' },
    action: { type: 'forward' as const },
    destination: { type: 'email' as const, email: 'owner@example.com' },
    ...over,
  });

  it('separates rules that differ by an exclusion or a window', () => {
    const plain = mailRuleDedupeKey(identity());
    const excluded = mailRuleDedupeKey(identity({
      match: { subjectContains: 'Invoice', notFrom: 'noreply@example.com' },
    }));
    const windowed = mailRuleDedupeKey(identity({
      match: {
        subjectContains: 'Invoice',
        activeWindow: { start: '09:00', end: '18:00', timeZone: 'UTC' },
      },
    }));
    assert.notEqual(plain, excluded);
    assert.notEqual(plain, windowed);
    assert.notEqual(excluded, windowed);
  });

  it('reads a window written two ways as one rule', () => {
    // Days out of order, and "every day" spelled out in full, are the same
    // window — a member who lists all seven must not get a second rule.
    const scrambled = mailRuleDedupeKey(identity({
      match: {
        subjectContains: 'Invoice',
        activeWindow: {
          days: ['wed', 'mon', 'tue'],
          start: '09:00',
          end: '18:00',
          timeZone: 'UTC',
        },
      },
    }));
    const ordered = mailRuleDedupeKey(identity({
      match: {
        subjectContains: 'Invoice',
        activeWindow: {
          days: ['mon', 'tue', 'wed'],
          start: '09:00',
          end: '18:00',
          timeZone: 'UTC',
        },
      },
    }));
    assert.equal(scrambled, ordered);

    const everyDay = mailRuleDedupeKey(identity({
      match: {
        subjectContains: 'Invoice',
        activeWindow: { start: '09:00', end: '18:00', timeZone: 'UTC' },
      },
    }));
    const allSeven = mailRuleDedupeKey(identity({
      match: {
        subjectContains: 'Invoice',
        activeWindow: {
          days: ['sun', 'sat', 'fri', 'thu', 'wed', 'tue', 'mon'],
          start: '09:00',
          end: '18:00',
          timeZone: 'UTC',
        },
      },
    }));
    assert.equal(everyDay, allSeven);
  });

  it('does not let a throttle fork a rule in two', () => {
    // Two rules alike but for their ceiling are one rule with two opinions
    // about how fast it may go. Treating them as two leaves both running and
    // forwards everything twice.
    assert.equal(
      mailRuleDedupeKey(identity()),
      mailRuleDedupeKey(identity({
        action: { type: 'forward', rateLimitPerHour: 10 },
      })),
    );
  });

  it('separates organize rules that file mail differently', () => {
    const labelled = mailRuleDedupeKey(identity({
      action: { type: 'organize', label: 'Receipts' },
      destination: { type: 'none' },
    }));
    const archived = mailRuleDedupeKey(identity({
      action: { type: 'organize', label: 'Receipts', archive: true },
      destination: { type: 'none' },
    }));
    assert.notEqual(labelled, archived);
  });
});

describe('dry run', () => {
  const rule = {
    match: { subjectContains: 'Invoice' },
    action: { type: 'forward' },
    destination: { type: 'email', email: 'owner@example.com' },
    activatedAt: new Date('2026-08-01T00:00:00.000Z'),
  };

  it('reports what would have matched and sends nothing', () => {
    const outcome = dryRunMailRule({
      rule,
      events: [
        {
          eventId: 'event-1',
          occurredAt: new Date('2026-08-04T10:00:00.000Z'),
          metadata: message({ subject: 'Invoice 42' }),
        },
        {
          eventId: 'event-2',
          occurredAt: new Date('2026-08-04T11:00:00.000Z'),
          metadata: message({ subject: 'Newsletter' }),
        },
      ],
    });
    assert.equal(outcome.status, 'ran');
    assert.equal(outcome.status === 'ran' && outcome.consideredCount, 2);
    assert.deepEqual(
      outcome.status === 'ran' ? outcome.matched.map(hit => hit.eventId) : [],
      ['event-1'],
    );
  });

  it('marks a hit older than the rule rather than promising a backfill', () => {
    const outcome = dryRunMailRule({
      rule,
      events: [{
        eventId: 'event-old',
        occurredAt: new Date('2026-07-01T00:00:00.000Z'),
        metadata: message({ subject: 'Invoice 1' }),
      }],
    });
    assert.equal(outcome.status === 'ran' && outcome.predatingCount, 1);
    assert.equal(
      outcome.status === 'ran' && outcome.matched[0]?.predatesRule,
      true,
    );
  });

  it('skips mail Divo forwarded itself, exactly as the worker does', () => {
    const outcome = dryRunMailRule({
      rule,
      events: [{
        eventId: 'event-loop',
        occurredAt: new Date('2026-08-04T10:00:00.000Z'),
        metadata: message({ subject: 'Fwd: Invoice 42', forwardedByRuleId: 'rule-1' }),
      }],
    });
    assert.equal(outcome.status === 'ran' && outcome.matched.length, 0);
  });

  it('says a rule is broken instead of reporting a clean run', () => {
    const outcome = dryRunMailRule({
      rule: { ...rule, match: { hasAttachment: 'yes' } },
      events: [],
    });
    assert.equal(outcome.status, 'rule_invalid');
  });
});
