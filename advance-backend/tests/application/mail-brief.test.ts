/**
 * When the brief fires, and what it is allowed to say.
 *
 * The schedule is the part that fails quietly: a brief an hour out, or one that
 * fires on a Saturday it was told to skip, is wrong in a way nobody reports as
 * a bug — they just stop trusting it. And the composer is the part where a
 * model could put words in a colleague's mouth, so what it may and may not
 * supply is pinned here rather than left to the prompt.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAIL_BRIEF_SCHEDULE,
  mailBriefScheduleSchema,
  mailBriefWindowStart,
  nextMailBriefRunAt,
} from '../../src/application/mail-ops/mail-brief.schedule.ts';
import {
  createMailBriefComposer, senderName,
} from '../../src/application/mail-ops/mail-brief.ts';

const IST = 'Asia/Kolkata';
/** 09:00 and 16:00 IST are 03:30 and 10:30 UTC. */
const at = (iso: string) => new Date(iso);

const modelReturning = (text: string) => ({
  specificationVersion: 'v2' as const,
  provider: 'test',
  modelId: 'test',
  supportedUrls: {},
  async doGenerate() {
    return {
      content: [{ type: 'text' as const, text }],
      finishReason: 'stop' as const,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      warnings: [],
    };
  },
  doStream() { throw new Error('not used'); },
});

describe('when a brief fires', () => {
  it('takes the next of the day’s times, in the member’s zone', () => {
    // Monday 2026-08-10, 01:00 UTC = 06:30 IST. Next slot is 09:00 IST.
    const next = nextMailBriefRunAt(
      DEFAULT_MAIL_BRIEF_SCHEDULE,
      at('2026-08-10T01:00:00.000Z'),
    );
    assert.equal(next?.toISOString(), '2026-08-10T03:30:00.000Z');
  });

  it('moves to the second time once the first has passed', () => {
    // 04:00 UTC = 09:30 IST, so 09:00 is gone and 16:00 is next.
    const next = nextMailBriefRunAt(
      DEFAULT_MAIL_BRIEF_SCHEDULE,
      at('2026-08-10T04:00:00.000Z'),
    );
    assert.equal(next?.toISOString(), '2026-08-10T10:30:00.000Z');
  });

  /*
   * Strictly after, never equal.
   *
   * This is called immediately after a run completes, with the slot that just
   * fired. An inclusive comparison would hand back the same instant and the
   * brief would send in a loop.
   */
  it('never returns the slot that just fired', () => {
    const slot = at('2026-08-10T03:30:00.000Z');
    const next = nextMailBriefRunAt(DEFAULT_MAIL_BRIEF_SCHEDULE, slot);
    assert.notEqual(next?.toISOString(), slot.toISOString());
    assert.equal(next?.toISOString(), '2026-08-10T10:30:00.000Z');
  });

  it('skips the days it was told to skip', () => {
    // Friday 2026-08-14, 11:00 UTC — past both of Friday's slots. The next
    // workday is Monday, not Saturday.
    const next = nextMailBriefRunAt(
      DEFAULT_MAIL_BRIEF_SCHEDULE,
      at('2026-08-14T11:00:00.000Z'),
    );
    assert.equal(next?.toISOString(), '2026-08-17T03:30:00.000Z');
  });

  /*
   * A late slot in a zone behind UTC resolves onto the next UTC day, so the
   * weekday has to be read off the resolved instant rather than off the day
   * being probed — otherwise a "weekdays only" brief fires on the Saturday.
   */
  it('reads the weekday from the resolved instant, not the probe', () => {
    const schedule = {
      times: ['23:30'], days: ['FR'] as const, timeZone: 'America/New_York',
    };
    const next = nextMailBriefRunAt(
      { ...schedule, days: [...schedule.days] },
      at('2026-08-10T12:00:00.000Z'),
    );
    // Friday 14 Aug, 23:30 in New York = Saturday 15 Aug 03:30 UTC.
    assert.equal(next?.toISOString(), '2026-08-15T03:30:00.000Z');
    const localDay = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short',
    }).format(next!);
    assert.equal(localDay, 'Fri');
  });

  it('refuses a schedule it cannot honour exactly', () => {
    assert.equal(mailBriefScheduleSchema.safeParse({
      times: ['9:00'], days: ['MO'], timeZone: IST,
    }).success, false);
    assert.equal(mailBriefScheduleSchema.safeParse({
      times: ['25:00'], days: ['MO'], timeZone: IST,
    }).success, false);
    assert.equal(mailBriefScheduleSchema.safeParse({
      times: [], days: ['MO'], timeZone: IST,
    }).success, false);
  });
});

describe('what a brief covers', () => {
  it('starts where the last one stopped, so a missed run is not a gap', () => {
    const lastCovered = at('2026-08-10T03:30:00.000Z');
    const now = at('2026-08-10T10:30:00.000Z');
    assert.equal(
      mailBriefWindowStart(lastCovered, now).toISOString(),
      lastCovered.toISOString(),
    );
  });

  it('does not reach back further than three days', () => {
    // A mailbox not briefed since last month gets today's mail and a fresh
    // start, not four hundred messages in one Lark card.
    const now = at('2026-08-10T10:30:00.000Z');
    const start = mailBriefWindowStart(at('2026-07-01T00:00:00.000Z'), now);
    assert.equal(start.toISOString(), '2026-08-07T10:30:00.000Z');
  });

  it('a first-ever brief looks back twelve hours', () => {
    const now = at('2026-08-10T10:30:00.000Z');
    assert.equal(
      mailBriefWindowStart(null, now).toISOString(),
      '2026-08-09T22:30:00.000Z',
    );
  });
});

describe('composing a brief', () => {
  const message = (from: string, subject: string, hour: number) => ({
    from, subject, snippet: '…',
    occurredAt: at(`2026-08-10T0${hour}:00:00.000Z`),
  });

  const window = {
    mailboxEmail: 'rahul@emiactech.com',
    from: at('2026-08-09T22:30:00.000Z'),
    to: at('2026-08-10T03:30:00.000Z'),
    timeZone: IST,
    // Meera's is the newer of the two, because the composer shows the model its
    // newest messages first and resolves the indices it answers with against
    // that same order — so index 0 is deliberately hers.
    messages: [
      message('no-reply@newsletter.io', 'This week in FinOps', 1),
      message('Meera Iyer <meera@client.com>', 'Re: Renewal terms', 2),
    ],
    handled: [
      { ruleName: 'Vendor invoices → Finance', delivered: 3, held: 2, blocked: 0, failed: 0 },
      { ruleName: 'Newsletters out of the way', delivered: 0, held: 0, blocked: 0, failed: 0 },
    ],
  };

  it('names the sender from the stored row, never from the model', async () => {
    // The model is given a chance to supply a different sender and subject; only
    // its `want` sentence may reach the brief. Otherwise a hallucination puts
    // words in a colleague's mouth, in a message that looks like a real report.
    const compose = createMailBriefComposer({
      model: modelReturning(JSON.stringify({
        wants: [{
          index: 0,
          want: 'Wants the revised cap confirmed before Friday.',
          from: 'Somebody Else <nobody@example.com>',
          subject: 'An email that never arrived',
        }],
      })) as never,
    });

    const brief = await compose(window);
    assert.match(brief.text, /Meera Iyer/);
    assert.match(brief.text, /Re: Renewal terms/);
    assert.match(brief.text, /Wants the revised cap confirmed before Friday\./);
    assert.doesNotMatch(brief.text, /Somebody Else/);
    assert.doesNotMatch(brief.text, /never arrived/);
  });

  it('drops an index that does not exist rather than repairing it', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning(
        '{"wants":[{"index":99,"want":"Needs a decision."}]}',
      ) as never,
    });

    const brief = await compose(window);
    assert.equal(brief.wantCount, 0);
    assert.match(brief.text, /Nothing is waiting on you/);
  });

  it('says nothing needs you, rather than staying silent', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[]}') as never,
    });

    const brief = await compose(window);
    assert.equal(brief.degraded, false);
    assert.match(brief.text, /Nothing is waiting on you/);
    // Arithmetic, no model: the rules section is present either way.
    assert.match(brief.text, /\*\*Vendor invoices → Finance\*\* — 3 passed on, 2 held back/);
  });

  /*
   * An unreadable mailbox and an empty one must not look the same. One means
   * "you are up to date" and the other means "Divo could not check".
   */
  it('says so when the model could not be read, and still reports the rules', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('I could not do that.') as never,
    });

    const brief = await compose(window);
    assert.equal(brief.degraded, true);
    assert.match(brief.text, /could not read your mail/);
    assert.doesNotMatch(brief.text, /Nothing is waiting on you/);
    assert.match(brief.text, /Vendor invoices → Finance/);
  });

  it('leaves out rules that did nothing', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[]}') as never,
    });

    const brief = await compose(window);
    assert.doesNotMatch(brief.text, /Newsletters out of the way/);
  });
});

describe('reading a sender', () => {
  it('prefers the display name and falls back to the local part', () => {
    assert.equal(senderName('Meera Iyer <meera@client.com>'), 'Meera Iyer');
    assert.equal(senderName('"Acme, Billing" <ap@acme.com>'), 'Acme, Billing');
    assert.equal(senderName('billing@acme.com'), 'billing');
  });
});
