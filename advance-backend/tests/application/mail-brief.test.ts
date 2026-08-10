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
    mailboxActive: true,
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

  /*
   * The first brief that ever reached a real Lark DM arrived reading
   * `**Your mail** · 16:36–04:36`, asterisks and all, because the composer
   * produced markdown and the delivery path sent it as `msg_type: 'text'` —
   * which Lark does not interpret. The card is what makes the bold mean bold,
   * so it is asserted on rather than trusted.
   */
  const readCard = (payload: string) => {
    const envelope = JSON.parse(payload) as { msg_type: string; card: string };
    assert.equal(envelope.msg_type, 'interactive');
    return JSON.parse(envelope.card) as {
      schema: string;
      config: { summary?: { content: string } };
      header: {
        template?: string;
        title?: { content: string };
        subtitle?: { content: string };
        text_tag_list?: Array<{ text: { content: string } }>;
      };
      body: {
        elements: Array<{
          tag: string;
          content?: string;
          text?: { content: string };
          behaviors?: Array<{ type: string; default_url?: string }>;
        }>;
      };
    };
  };

  /** The bold line the body opens on: the verdict, without its asterisks. */
  const cardVerdict = (payload: string): string =>
    String(readCard(payload).body.elements[0]?.content ?? '').replace(/^\*\*|\*\*$/g, '');

  const cardMarkdown = (payload: string): string =>
    readCard(payload).body.elements
      .filter(e => e.tag === 'markdown')
      .map(e => e.content)
      .join('\n\n');

  it('sends a card, so Lark renders the brief instead of printing its markup', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[]}') as never,
    });

    const card = readCard((await compose(window)).card);
    assert.equal(card.schema, '2.0');
    assert.ok(
      card.body.elements.some(e => e.tag === 'markdown'),
      'the brief must reach Lark as markdown elements',
    );
    assert.match(
      cardMarkdown((await compose(window)).card),
      /\*\*Vendor invoices → Finance\*\*/,
      'what the rules did must survive into the card',
    );
  });

  /*
   * The verdict is the line a reader decides on, so it opens the body in bold
   * and it is the notification preview. It appears in neither twice. Earlier
   * cards spent the subtitle on a timestamp and the header on a block of blue,
   * and put the one sentence that mattered in body grey underneath.
   */
  it('opens the body on the verdict, and carries it into the notification', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[]}') as never,
    });

    const brief = await compose(window);
    const card = readCard(brief.card);
    assert.equal(cardVerdict(brief.card), 'Nothing is waiting on you');
    assert.match(card.config.summary?.content ?? '', /Nothing is waiting on you/);
    assert.equal(
      (cardMarkdown(brief.card).match(/Nothing is waiting on you/g) ?? []).length,
      1,
      'the verdict is stated once',
    );
  });

  /*
   * Lark already prints the sender's name and its Agent tag above every card,
   * so a title band is the third line in a row that says who is talking. The
   * badge names the report and gives the width back; the mailbox and window are
   * provenance, so they stay in the footer.
   */
  it('names itself with a badge rather than a title band', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[]}') as never,
    });

    const brief = await compose(window);
    const card = readCard(brief.card);
    assert.equal(card.header.template, 'default');
    assert.equal(card.header.title, undefined);
    assert.equal(card.header.subtitle, undefined);
    assert.deepEqual(
      card.header.text_tag_list?.map(chip => chip.text.content),
      ['Divo Mailer'],
    );
    assert.match(card.config.summary?.content ?? '', /^Divo Mailer — /);
    assert.match(cardMarkdown(brief.card), /04:00–09:00 · rahul@emiactech\.com/);
  });

  /*
   * The model is shown the sixty newest messages. On a mailing-list morning
   * that is a fraction of what arrived, and "Nothing is waiting on you" — read
   * off a phone notification, with no body under it — would be a false
   * all-clear about mail nobody looked at.
   */
  it('does not call it all clear over mail it never read', async () => {
    const many = Array.from({ length: 90 }, (_, i) => ({
      from: `Sender ${i} <s${i}@list.com>`, subject: `Subject ${i}`, snippet: '…',
      occurredAt: at(`2026-08-10T02:00:0${i % 10}.000Z`),
    }));
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[]}') as never,
    });

    const brief = await compose({ ...window, messages: many, handled: [] });
    const card = readCard(brief.card);

    assert.equal(cardVerdict(brief.card), 'Nothing waiting in your newest 60');
    assert.doesNotMatch(card.config.summary?.content ?? '', /Nothing is waiting on you/);
    assert.match(
      cardMarkdown(brief.card),
      /90 messages arrived in all; Divo read the 60 newest\./,
      'the count is what arrived, not what was read',
    );
  });

  /*
   * A brief whose model call failed read nothing at all, so it must not also
   * claim to have read the sixty newest — that is precisely the "Divo checked
   * and you are clear" reading the degraded verdict exists to refuse.
   */
  it('does not claim to have read anything when it could not read', async () => {
    const many = Array.from({ length: 90 }, (_, i) => ({
      from: `Sender ${i} <s${i}@list.com>`, subject: `Subject ${i}`, snippet: '…',
      occurredAt: at(`2026-08-10T02:00:0${i % 10}.000Z`),
    }));
    const compose = createMailBriefComposer({
      model: modelReturning('I could not do that.') as never,
    });

    const markdown = cardMarkdown(
      (await compose({ ...window, messages: many, handled: [] })).card,
    );
    assert.match(markdown, /90 messages arrived\./);
    assert.doesNotMatch(markdown, /Divo read the/);
  });

  /*
   * With mail named and mail unread, the two counts have to agree: "58 others
   * needed nothing" is a claim about what Divo read, and it cannot stand as
   * the only number on a card where ninety arrived.
   */
  it('states both what it read and what arrived when they differ', async () => {
    const many = Array.from({ length: 90 }, (_, i) => ({
      from: `Sender ${i} <s${i}@list.com>`, subject: `Subject ${i}`, snippet: '…',
      // Descending, so index 0 and 1 are the two newest and survive the cut.
      occurredAt: new Date(Date.parse('2026-08-10T03:00:00.000Z') - i * 60_000),
    }));
    const compose = createMailBriefComposer({
      model: modelReturning(JSON.stringify({
        wants: [{ index: 0, want: 'Needs a decision.' }, { index: 1, want: 'Needs another.' }],
      })) as never,
    });

    const markdown = cardMarkdown(
      (await compose({ ...window, messages: many, handled: [] })).card,
    );
    assert.match(markdown, /58 other messages arrived and needed nothing from you\./);
    assert.match(markdown, /90 messages arrived in all; Divo read the 60 newest\./);
  });

  /*
   * Nothing limits how many rules a member writes, and they all render into
   * one card element. A card over Lark's size ceiling is rejected outright,
   * which costs the member the whole brief rather than the footnote's tail.
   */
  it('caps the rule footnote too, and counts what it left out', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[]}') as never,
    });

    const brief = await compose({
      ...window,
      handled: Array.from({ length: 30 }, (_, i) => ({
        ruleName: `Rule number ${i} with a fairly long descriptive name`,
        delivered: 2, held: 1, blocked: 0, failed: 0,
      })),
    });

    const markdown = cardMarkdown(brief.card);
    assert.match(markdown, /\+22 other rules also ran\./);
    assert.equal((markdown.match(/Rule number/g) ?? []).length, 8);

    // The boundary, where a count that is always plural reads as broken.
    const one = await compose({
      ...window,
      handled: Array.from({ length: 9 }, (_, i) => ({
        ruleName: `Rule ${i}`, delivered: 1, held: 0, blocked: 0, failed: 0,
      })),
    });
    assert.match(cardMarkdown(one.card), /\+1 other rule also ran\./);
    for (const element of readCard(brief.card).body.elements) {
      assert.ok(
        String(element.content ?? '').length <= 1200,
        'no element may exceed what Lark renders in one block',
      );
    }
  });

  /*
   * The quietest possible brief: no mail, no rules, nothing between the verdict
   * and the footer. The verdict is always present now, so the card can never
   * open on a horizontal rule — which used to read as one whose top half had
   * failed to render, in precisely the case that means "all clear".
   */
  it('is a verdict and a footer when there is nothing else to say', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[]}') as never,
    });

    const brief = await compose({ ...window, messages: [], handled: [] });
    const card = readCard(brief.card);
    assert.equal(cardVerdict(brief.card), 'No mail arrived in this window');
    assert.deepEqual(card.body.elements.map(e => e.tag), ['markdown', 'hr', 'markdown']);
  });

  /*
   * `text` is built by stripping the colour out of the card's own blocks, so
   * the two cannot disagree by construction and asserting they match proves
   * nothing. What is worth asserting is the part that is not structural: that
   * the stripping is complete, so nothing carried to a surface without cards
   * arrives wearing card markup.
   */
  it('carries no card markup into the text rendering', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning(JSON.stringify({
        wants: [{ index: 0, want: 'Wants the revised cap confirmed before Friday.' }],
      })) as never,
    });

    const brief = await compose(window);
    assert.doesNotMatch(brief.text, /<\/?font/);
    assert.match(brief.text, /Wants the revised cap confirmed before Friday\./);
    assert.match(brief.text, /\*\*Vendor invoices → Finance\*\* — 3 passed on/);
    // The opening line is the one thing the text says that the card wears as a
    // badge instead. The verdict is not part of it: that is a body block now,
    // and stating it here too would say it twice.
    assert.equal(brief.text.split('\n\n')[0], '**Divo Mailer**');
    assert.equal(brief.text.split('\n\n')[1], '**1 message needs you**');
    assert.equal(cardVerdict(brief.card), '1 message needs you');
  });

  /*
   * The degraded verdict is the one a member most needs to read without
   * opening anything: it is the difference between "you are up to date" and
   * "Divo did not look". It reaches them through the opening line and the phone
   * notification, so both are asserted rather than the text alone.
   */
  it('carries the degraded verdict into the opening line and the notification', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('I could not do that.') as never,
    });

    const brief = await compose(window);
    const card = readCard(brief.card);
    assert.equal(cardVerdict(brief.card), 'Divo could not read your mail this time');
    assert.match(card.config.summary?.content ?? '', /could not read your mail/);
    assert.doesNotMatch(card.config.summary?.content ?? '', /Nothing is waiting/);
  });

  /*
   * Every question this card raises is answered on the rules page and nowhere
   * else: why a rule held something, why a mailbox is paused, how to stop being
   * told about newsletters. Without the button the brief names the problem and
   * leaves the member to go looking for where to fix it.
   */
  it('offers a way through to the rules page', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[]}') as never,
      appBaseUrl: 'https://divo.example.com',
    });

    const brief = await compose(window);
    const elements = readCard(brief.card).body.elements;
    const button = elements.find(e => e.tag === 'button');
    assert.equal(button?.text?.content, 'Manage mail');
    assert.equal(
      button?.behaviors?.[0]?.default_url,
      'https://divo.example.com/me/mail',
    );
    assert.equal(
      elements.at(-1)?.tag,
      'button',
      'a door out of the card sits below what the card says',
    );
    // The text rendering has no buttons, so the link has to survive as a link —
    // otherwise a surface without cards is told everything except where to act.
    assert.match(brief.text, /\[Manage mail\]\(https:\/\/divo\.example\.com\/me\/mail\)/);
  });

  /*
   * A brief with a dead button is worse than one with none: this is a standing
   * report read twice a day, and a button that goes nowhere teaches a member to
   * stop pressing the ones that work. A base URL is deployment configuration,
   * so getting it wrong must cost a button rather than the whole brief.
   */
  it('drops the button rather than pointing it somewhere useless', async () => {
    for (const appBaseUrl of [undefined, '', '   ', 'not a url', 'javascript:alert(1)']) {
      const compose = createMailBriefComposer({
        model: modelReturning('{"wants":[]}') as never,
        ...(appBaseUrl === undefined ? {} : { appBaseUrl }),
      });

      const brief = await compose(window);
      assert.equal(
        readCard(brief.card).body.elements.some(e => e.tag === 'button'),
        false,
        `${JSON.stringify(appBaseUrl)} must not produce a button`,
      );
      assert.doesNotMatch(brief.text, /Manage mail/);
      // Still a brief. The mail is the point; the button is a convenience.
      assert.match(cardMarkdown(brief.card), /Vendor invoices → Finance/);
    }
  });

  /*
   * A paused mailbox syncs nothing, so its window is empty — and "No mail
   * arrived in this window" is indistinguishable from a quiet Tuesday. Read off
   * a phone twice a day, that is a member concluding their inbox is calm while
   * Divo has stopped looking at it. It is the same false all-clear the degraded
   * verdict exists to refuse, arriving through a different door.
   */
  it('does not call a mailbox nobody is watching a quiet one', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[]}') as never,
    });

    const brief = await compose({
      ...window, mailboxActive: false, messages: [],
    });
    const card = readCard(brief.card);
    assert.equal(cardVerdict(brief.card), 'Divo is not watching this mailbox');
    assert.doesNotMatch(cardMarkdown(brief.card), /No mail arrived/);
    assert.doesNotMatch(card.config.summary?.content ?? '', /No mail arrived/);
    // What to do about it, not only what happened: this state does not heal
    // itself, and a verdict with no remedy is half a message.
    assert.match(cardMarkdown(brief.card), /Resume it to start getting briefs again\./);
    // The rules still ran before it was paused, so what they did stays on.
    assert.match(cardMarkdown(brief.card), /Vendor invoices → Finance/);
  });

  /*
   * The paused verdict outranks every other one, including the model's. A
   * mailbox nobody is reading cannot have three messages waiting in it, and
   * naming any would be reporting stale mail as though it had just arrived.
   */
  it('says nobody is watching even when the model named mail', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning(
        '{"wants":[{"index":0,"want":"Needs a decision."}]}',
      ) as never,
    });

    const brief = await compose({ ...window, mailboxActive: false });
    assert.equal(cardVerdict(brief.card), 'Divo is not watching this mailbox');
  });

  /*
   * A subject is written by whoever sent the mail, and this card is
   * unambiguously from Divo. A link in a subject would arrive bolded, in
   * Divo's own message, with anchor text of the sender's choosing — the mail
   * preview path strips URLs for exactly this reason.
   */
  it('takes a link in a subject down to the words, and drops where it pointed', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning(JSON.stringify({
        wants: [{ index: 0, want: 'Needs a decision.' }],
      })) as never,
    });

    const brief = await compose({
      ...window,
      messages: [{
        from: '"[Divo Security](https://evil.example/p)" <ops@vendor.com>',
        subject: '[Verify your mailbox](https://evil.example/phish) or www.evil.example/x',
        snippet: '…',
        occurredAt: at('2026-08-10T02:00:00.000Z'),
      }],
    });

    const markdown = cardMarkdown(brief.card);
    assert.match(markdown, /Verify your mailbox/, 'what it said survives');
    for (const rendering of [markdown, brief.text]) {
      assert.doesNotMatch(rendering, /evil\.example/, 'where it pointed does not');
      assert.doesNotMatch(rendering, /\]\(/, 'and no link syntax is left to rebuild it');
    }
  });

  /*
   * Unwrapping the inner link of a nested one re-forms the outer link behind
   * the regex, which never looks back. A single pass therefore handed back
   * `[Click here](//evil.example)` — a live link, from a stripper whose whole
   * purpose was that it could not produce one. A schemeless target also slips
   * past any rule that only knows `https://`.
   */
  it('cannot be defeated by nesting the link or dropping its scheme', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[{"index":0,"want":"Needs a decision."}]}') as never,
    });

    for (const subject of [
      '[[Click here](/a)](//evil.example/phish)',
      '[[[x](1)](2)](lark://applink.feishu.cn/client/web_url/open)',
      // Characters that hide the link from every pass — until the pass that
      // deletes them puts the link back together.
      '[Verify your mailbox]<(ht<tps://evil.example/x)',
      '[Verify your mailbox]*(https*://evil.example/x)',
    ]) {
      const brief = await compose({
        ...window,
        messages: [{
          from: 'Vendor <v@vendor.com>', subject, snippet: '…',
          occurredAt: at('2026-08-10T02:00:00.000Z'),
        }],
      });
      const markdown = cardMarkdown(brief.card);
      assert.doesNotMatch(markdown, /\]\(/, `link syntax survived: ${subject}`);
      assert.doesNotMatch(markdown, /evil\.example|applink/, `a target survived: ${subject}`);
    }
  });

  /*
   * A subject is not markup just because it contains an angle bracket. The
   * stripper matched every `<…>` pair and deleted the middle of this one,
   * which is a subject rewritten to say something the sender did not.
   */
  it('leaves ordinary punctuation in a subject alone', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[{"index":0,"want":"Needs a decision."}]}') as never,
    });

    const brief = await compose({
      ...window,
      messages: [{
        from: 'Vendor <v@vendor.com>',
        subject: 'Renewal: <500 USD, needs sign-off > today',
        snippet: '…',
        occurredAt: at('2026-08-10T02:00:00.000Z'),
      }],
    });

    const markdown = cardMarkdown(brief.card);
    assert.match(markdown, /500 USD/);
    assert.match(markdown, /needs sign-off/);
    assert.match(markdown, /today/);
  });

  /*
   * A URL is bounded by the characters a URL can hold, not by the next space.
   * Chinese and Japanese subjects contain no spaces, so a rule that ran to the
   * next whitespace deleted everything after the link — on a Feishu install,
   * for most of the mail.
   */
  it('removes a link from a subject without spaces without eating the subject', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[{"index":0,"want":"Needs a decision."}]}') as never,
    });

    const brief = await compose({
      ...window,
      messages: [{
        from: 'Vendor <v@vendor.com>',
        subject: '请批准www.example.com/invoice上的发票，金额为12万元',
        snippet: '…',
        occurredAt: at('2026-08-10T02:00:00.000Z'),
      }],
    });

    const markdown = cardMarkdown(brief.card);
    assert.match(markdown, /请批准/);
    assert.match(markdown, /上的发票/);
    assert.match(markdown, /12万元/, 'the amount survives the link removal');
    assert.doesNotMatch(markdown, /example\.com/);
  });

  /*
   * Truncation cuts code points, not UTF-16 code units. A lone surrogate in a
   * card element is at best a replacement glyph and at worst a card Lark
   * refuses — which costs the member the entire brief.
   */
  it('never truncates through an emoji', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[{"index":0,"want":"Needs a decision."}]}') as never,
    });

    const brief = await compose({
      ...window,
      messages: [{
        from: 'Vendor <v@vendor.com>',
        subject: `Q3 board pack ${'🔥'.repeat(60)}`,
        snippet: '…',
        occurredAt: at('2026-08-10T02:00:00.000Z'),
      }],
    });

    const markdown = cardMarkdown(brief.card);
    assert.match(markdown, /…/, 'it did truncate, so the check is meaningful');
    for (const unit of markdown) {
      const code = unit.charCodeAt(0);
      assert.ok(
        code < 0xd800 || code > 0xdfff || unit.length === 2,
        'no unpaired surrogate may reach the card',
      );
    }
  });

  /*
   * The footnote exists so a member can see which rules are working. A row
   * naming no rule defeats it, and a rule name is member-authored — it can be
   * nothing but markup.
   */
  it('names a rule whose name is nothing but markup', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning('{"wants":[]}') as never,
    });

    const brief = await compose({
      ...window,
      handled: [{ ruleName: '***', delivered: 3, held: 0, blocked: 0, failed: 0 }],
    });

    const markdown = cardMarkdown(brief.card);
    assert.doesNotMatch(markdown, /\*\*\*\*/);
    assert.match(markdown, /\*\*Unnamed rule\*\* — 3 passed on/);
  });

  /*
   * A subject is written by whoever sent the mail, and it lands inside markup
   * the card opened — a `<` closes the grey font tag it sits in and takes the
   * rest of the card's structure with it, and an asterisk opens a bold the
   * card never closes.
   */
  it('cannot have its markup broken by a subject line', async () => {
    const compose = createMailBriefComposer({
      model: modelReturning(JSON.stringify({
        wants: [{ index: 0, want: 'Needs a decision.' }],
      })) as never,
    });

    const brief = await compose({
      ...window,
      messages: [{
        from: '"Ops <hostile>" <ops@vendor.com>',
        subject: 'Re: </font>**everything** <b>now</b>',
        snippet: '…',
        occurredAt: at('2026-08-10T02:00:00.000Z'),
      }],
    });

    const markdown = cardMarkdown(brief.card);
    // Exactly the tags the card opened for itself, and no stray asterisks that
    // could swallow the sender's name into a bold run.
    assert.equal(
      (markdown.match(/<font color='grey'>/g) ?? []).length,
      (markdown.match(/<\/font>/g) ?? []).length,
      'every font tag the card opens must be one it closes',
    );
    assert.doesNotMatch(markdown, /<b>|<\/b>/);
    assert.match(markdown, /Re: everything now/);
  });

  /*
   * The model may name up to forty messages. Forty entries is not a brief, and
   * a card over Lark's element or size ceiling is rejected outright — which
   * would cost the member the whole brief rather than its tail. What is cut is
   * said out loud rather than dropped.
   */
  it('caps how many messages it names, and says how many it left out', async () => {
    // `Sender 0` is the newest, `Sender 19` the oldest.
    const many = Array.from({ length: 20 }, (_, i) => ({
      from: `Sender ${i} <s${i}@client.com>`,
      subject: `Subject ${i}`,
      snippet: '…',
      occurredAt: at(`2026-08-10T02:${String(59 - i).padStart(2, '0')}:00.000Z`),
    }));
    // Oldest named first. Nothing in the prompt or the schema makes the model's
    // order recency, so the composer must not inherit it — slicing it directly
    // showed the twelve oldest and hid every one of the newest eight.
    const compose = createMailBriefComposer({
      model: modelReturning(JSON.stringify({
        wants: [...many.keys()].reverse().map(i => ({
          index: i, want: `Needs a decision ${i}.`,
        })),
      })) as never,
    });

    const brief = await compose({ ...window, messages: many, handled: [] });
    const card = readCard(brief.card);
    const markdown = cardMarkdown(brief.card);

    assert.equal(brief.wantCount, 20, 'the count is what the model found, not what fit');
    assert.deepEqual(
      markdown.match(/Sender \d+/g),
      Array.from({ length: 12 }, (_, i) => `Sender ${i}`),
      'the twelve newest, newest first — the cut falls on the oldest',
    );
    assert.match(markdown, /8 more are waiting in your mail\./);
    assert.ok(
      card.body.elements.length <= 20,
      `a card Lark will accept, got ${card.body.elements.length} elements`,
    );
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
