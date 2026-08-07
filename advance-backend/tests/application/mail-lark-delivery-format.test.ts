/**
 * What a mail rule says in a Lark chat.
 *
 * The format used to paste the whole plain-text body in, up to twenty thousand
 * characters. Against a real marketing mail that is unreadable — the
 * plain-text twin of an HTML mail is its layout flattened into ragged half
 * sentences, and every link in it is a tracking URL a thousand characters
 * long. These hold the notification to being shorter and more useful than the
 * mail it announces.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatLarkDelivery } from '../../src/application/mail-ops/mail-ops.worker.ts';

const payload = (message: Record<string, unknown>) => ({
  companyId: 'c1',
  userId: 'u1',
  subscriptionId: 's1',
  connectionId: 'conn1',
  mailboxEmail: 'me@company.com',
  ruleId: 'rule-1',
  eventId: 'event-1',
  sourceMessageId: '19af23cd10',
  idempotencyKey: 'mail:abc',
  action: { type: 'deliver' as const },
  destination: { type: 'lark_chat' as const, chatId: 'oc_1' },
  message: {
    from: 'Naukri <naukritalentcloud@naukri.com>',
    to: 'me@company.com',
    subject: 'Post jobs, search CVs',
    snippet: '',
    bodyText: '',
    hasAttachment: false,
    ...message,
  },
}) as never;

describe('formatLarkDelivery', () => {
  it('drops the tracking URLs that made the old notification unreadable', () => {
    // Not shortened and not labelled: the host alone would still be a live
    // link in a chat that nobody meant to click, and the parameters are the
    // reason the message ran for a thousand characters.
    const url = `https://cm.naukri.com?data=%7B%22deviceType%22${'%3A%22WEB%22'.repeat(60)}`;
    const text = formatLarkDelivery(payload({
      bodyText: `One package. 2 job postings.\n\nBUY NOW\n<${url}>\n\nTeam Naukri`,
    }));

    assert.equal(text.includes('cm.naukri.com'), false);
    assert.equal(text.includes('%22deviceType%22'), false);
    assert.match(text, /One package\. 2 job postings\./);
    assert.match(text, /Team Naukri/);
  });

  it('links to the real mail rather than trying to be it', () => {
    // A chat renders no HTML, no inline image and no attachment. The link is
    // the only honest answer for all three.
    const text = formatLarkDelivery(payload({ hasAttachment: true }));

    // Addressed by mailbox, not by `u/0` — the index is a position in whatever
    // order that person is signed into Google accounts, so for anyone with
    // more than one it opens the wrong mailbox.
    assert.match(
      text,
      /https:\/\/mail\.google\.com\/mail\/u\/me%40company\.com\/#all\/19af23cd10/,
    );
    assert.match(text, /Has attachments/);
  });

  it('leads with the subject and names the sender readably', () => {
    const text = formatLarkDelivery(payload({}));

    assert.match(text, /^Post jobs, search CVs\n/);
    assert.match(text, /^From: Naukri \(naukritalentcloud@naukri\.com\)$/m);
  });

  it('keeps a bare address when there is no name to show', () => {
    const text = formatLarkDelivery(payload({ from: 'billing@acme.com' }));
    assert.match(text, /^From: billing@acme\.com$/m);
  });

  it('stays short enough to read in a chat', () => {
    // The old format allowed twenty thousand characters, which is a screenful
    // of chat for one notification.
    const text = formatLarkDelivery(payload({ bodyText: 'x'.repeat(20_000) }));

    assert.ok(text.length < 1_000, `notification was ${text.length} characters`);
    assert.match(text, /…/);
  });

  it('collapses the blank lines that an HTML mail plain twin is mostly made of', () => {
    const text = formatLarkDelivery(payload({
      bodyText: 'Hi there.\n\n\n\nGreetings.\n   \n\nFrom us.',
    }));

    assert.match(text, /Hi there\.\nGreetings\.\nFrom us\./);
  });

  it('says so rather than going blank when there is no body left', () => {
    // A mail whose body was nothing but a tracking link still has a subject
    // and a sender, and those are what the notification is for.
    const text = formatLarkDelivery(payload({
      bodyText: 'https://cm.naukri.com?data=x',
    }));

    assert.match(text, /^Post jobs, search CVs\n/);
    assert.match(text, /mail\.google\.com/);
  });
});
