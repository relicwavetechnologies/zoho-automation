import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  composeHealthCard,
  composeNumberCard,
  sortForDigest,
  DIGEST_ITEMS_PER_CARD,
  type DigestItem,
} from '../../src/application/follow-ups/follow-up-digest.ts';

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-08-25T09:00:00Z');

const item = (over: Partial<DigestItem> = {}): DigestItem => ({
  id: 'f-1',
  title: 'Send Priya the Q3 invoice',
  owner: 'us',
  counterparty: 'Priya',
  chatName: 'Venue — Taj',
  dueDate: null,
  urgency: 'medium',
  ...over,
});

describe('composeNumberCard', () => {
  it('speaks as a team, never as a person', () => {
    const card = composeNumberCard(
      { sessionId: 's1', label: 'Bookings desk', items: [item()], withheld: 0 }, TZ, NOW,
    );
    assert.ok(card);
    assert.match(card.markdown, /\*\*We owe\*\*/);
    assert.doesNotMatch(card.markdown, /\byou\b/i);
  });

  it('names the counterparty when we are the ones waiting', () => {
    const card = composeNumberCard(
      { sessionId: 's1', label: 'Bookings desk', items: [item({ owner: 'them' })], withheld: 0 },
      TZ, NOW,
    );
    assert.ok(card);
    assert.match(card.markdown, /Waiting on Priya/);
  });

  it('sends nothing when a number has nothing outstanding', () => {
    // Ten "nothing to report" cards twice a day is twenty messages of noise, and
    // the group stops reading all of them — including the ones that matter.
    const card = composeNumberCard(
      { sessionId: 's1', label: 'Bookings desk', items: [], withheld: 0 }, TZ, NOW,
    );
    assert.equal(card, null);
  });

  it('says how many it withheld rather than truncating silently', () => {
    const many = Array.from({ length: DIGEST_ITEMS_PER_CARD + 3 }, (_, i) =>
      item({ id: `f-${i}`, title: `Item ${i}` }));
    const card = composeNumberCard(
      { sessionId: 's1', label: 'Bookings desk', items: many, withheld: 0 }, TZ, NOW,
    );
    assert.ok(card);
    assert.match(card.markdown, /…and 3 more/);
    // The count in the title is the real total, not what fitted.
    assert.match(card.title, new RegExp(`${DIGEST_ITEMS_PER_CARD + 3} open`));
    assert.equal(card.itemCount, DIGEST_ITEMS_PER_CARD + 3);
  });

  it('flags high urgency and carries a stated due date', () => {
    const card = composeNumberCard({
      sessionId: 's1', label: 'Bookings desk', withheld: 0,
      items: [item({ urgency: 'high', dueDate: new Date('2026-08-28T09:00:00Z') })],
    }, TZ, NOW);
    assert.ok(card);
    assert.match(card.markdown, /🔴/);
    assert.match(card.markdown, /due 28 Aug/);
  });
});

describe('sortForDigest', () => {
  it('puts urgent first, then soonest due', () => {
    const sorted = sortForDigest([
      item({ id: 'low', urgency: 'low' }),
      item({ id: 'later', urgency: 'high', dueDate: new Date('2026-09-01T00:00:00Z') }),
      item({ id: 'sooner', urgency: 'high', dueDate: new Date('2026-08-26T00:00:00Z') }),
      item({ id: 'medium', urgency: 'medium' }),
    ]);
    assert.deepEqual(sorted.map(i => i.id), ['sooner', 'later', 'medium', 'low']);
  });
});

describe('composeHealthCard', () => {
  it('is its own card, because a dark number sends nothing', () => {
    // Without this the number is simply absent from the digest — and absent
    // reads exactly like "nothing outstanding".
    const card = composeHealthCard(
      [{ label: 'Bookings desk', darkSince: new Date('2026-08-23T11:30:00Z') }], TZ,
    );
    assert.ok(card);
    assert.equal(card.sessionId, null);
    assert.match(card.title, /1 number not reporting/);
    assert.match(card.markdown, /Bookings desk/);
    assert.match(card.markdown, /23 Aug/);
  });

  it('says so when a number never connected at all', () => {
    const card = composeHealthCard([{ label: 'Sales 2', darkSince: null }], TZ);
    assert.ok(card);
    assert.match(card.markdown, /never connected/);
  });

  it('sends nothing when every number is healthy', () => {
    assert.equal(composeHealthCard([], TZ), null);
  });
});

// ── Lark card ────────────────────────────────────────────────────────────

const readCard = (payload: string) => {
  const envelope = JSON.parse(payload) as { msg_type: string; card: string };
  assert.equal(envelope.msg_type, 'interactive');
  return JSON.parse(envelope.card) as {
    schema: string;
    config: { summary?: { content: string } };
    header: {
      template?: string;
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

describe('composeNumberCard card', () => {
  it('sends a card, so Lark renders the digest instead of printing its markup', () => {
    const card = composeNumberCard(
      { sessionId: 's1', label: 'Bookings desk', items: [item()], withheld: 0 },
      TZ, NOW, 'https://divo.example.com',
    );
    assert.ok(card);
    // The card wrapper is what makes Lark render bold as bold, not as asterisks.
    const inner = readCard(card.card);
    assert.equal(inner.schema, '2.0');
    assert.ok(inner.body.elements.some(e => e.tag === 'markdown'), 'card must carry markdown elements');
    // markdown is for logs/cardText, card is what Lark sees — they must not be the same string
    assert.notEqual(card.card, card.markdown);
    assert.equal(card.card.includes('**We owe**'), true);
  });

  it('links the button to the number-scoped follow-ups URL', () => {
    const card = composeNumberCard(
      { sessionId: 's-99', label: 'Bookings desk', items: [item()], withheld: 0 },
      TZ, NOW, 'https://divo.example.com',
    );
    assert.ok(card);
    const inner = readCard(card.card);
    // badge stays in header, not in the body
    assert.deepEqual(inner.header.text_tag_list?.map(c => c.text.content), ['Divo Follow-ups']);
    const button = inner.body.elements.find(e => e.tag === 'button');
    assert.ok(button, 'card must have a button when appBaseUrl is present');
    assert.equal(button?.text?.content, 'Open follow-ups');
    assert.equal(button?.behaviors?.[0]?.type, 'open_url');
    assert.equal(button?.behaviors?.[0]?.default_url, 'https://divo.example.com/me/follow-ups?number=s-99');
    assert.equal(button?.type, 'default');
    assert.equal(button?.behaviors?.[0] ? (button as any).size : undefined, 'small');
    // The same link must survive into the markdown as a real link for surfaces without cards
    assert.match(card.markdown, /\[Open follow-ups\]\(https:\/\/divo\.example\.com\/me\/follow-ups\?number=s-99\)/);
    // Old wording "Open Bookings desk" or "Open abhishek" must not appear
    assert.doesNotMatch(card.card, /Open Bookings desk/);
    assert.doesNotMatch(card.card, /Open abhishek/);
    assert.doesNotMatch(card.markdown, /\[Open Bookings desk\]/);
  });

  it('drops the button rather than pointing it somewhere useless', () => {
    for (const appBaseUrl of [undefined, '', '   ', 'not a url', 'javascript:alert(1)'] as const) {
      const card = composeNumberCard(
        { sessionId: 's1', label: 'Bookings desk', items: [item()], withheld: 0 },
        TZ, NOW, appBaseUrl as unknown as string,
      );
      assert.ok(card, `${JSON.stringify(appBaseUrl)} must still produce a card`);
      const inner = readCard(card.card);
      assert.equal(
        inner.body.elements.some(e => e.tag === 'button'),
        false,
        `${JSON.stringify(appBaseUrl)} must not produce a button`,
      );
      assert.doesNotMatch(card.markdown, /Open follow-ups/);
    }
  });

  it('keeps the truncation line in the card body, not only in the markdown', () => {
    const many = Array.from({ length: DIGEST_ITEMS_PER_CARD + 3 }, (_, i) =>
      item({ id: `f-${i}`, title: `Item ${i}` }),
    );
    const card = composeNumberCard(
      { sessionId: 's1', label: 'Bookings desk', items: many, withheld: 0 },
      TZ, NOW, 'https://divo.example.com',
    );
    assert.ok(card);
    assert.match(card.markdown, /…and 3 more/);
    const inner = readCard(card.card);
    const markdownContents = inner.body.elements
      .filter(e => e.tag === 'markdown')
      .map(e => String(e.content))
      .join('\n');
    assert.match(markdownContents, /…and 3 more/, 'truncation must be a markdown element in the card, not only in the text');
    // Card and markdown are built from the same values in the same function — a drift would mean one knows about truncation and the other does not
    assert.ok(inner.body.elements.some(e => e.tag === 'button'), 'truncated card must still offer a button to see everything');
  });

  it('withholds carried in card and markdown when built from same values', () => {
    // withheld >0 supplied at input, not only via overflow
    const card = composeNumberCard(
      { sessionId: 's1', label: 'Bookings desk', items: [item()], withheld: 4 },
      TZ, NOW, 'https://divo.example.com',
    );
    assert.ok(card);
    assert.match(card.markdown, /…and 4 more/);
    const inner = readCard(card.card);
    const contents = inner.body.elements.filter(e => e.tag === 'markdown').map(e => String(e.content)).join('\n');
    assert.match(contents, /…and 4 more/);
  });
});

describe('composeHealthCard card', () => {
  it('also sends a card', () => {
    const card = composeHealthCard(
      [{ label: 'Bookings desk', darkSince: new Date('2026-08-23T11:30:00Z') }],
      TZ,
      'https://divo.example.com',
    );
    assert.ok(card);
    const inner = readCard(card.card);
    assert.equal(inner.schema, '2.0');
    assert.ok(inner.body.elements.some(e => String(e.content ?? '').includes('Bookings desk')));
  });

  it('drops its button when no appBaseUrl', () => {
    const card = composeHealthCard(
      [{ label: 'Sales 2', darkSince: null }],
      TZ,
    );
    assert.ok(card);
    const inner = readCard(card.card);
    assert.equal(inner.body.elements.some(e => e.tag === 'button'), false);
  });

  it('offers Open follow-ups when appBaseUrl is present', () => {
    const card = composeHealthCard(
      [{ label: 'Sales 2', darkSince: null }],
      TZ,
      'https://divo.example.com',
    );
    assert.ok(card);
    const inner = readCard(card.card);
    const button = inner.body.elements.find(e => e.tag === 'button');
    assert.ok(button);
    assert.equal(button?.text?.content, 'Open follow-ups');
    assert.equal(button?.behaviors?.[0]?.default_url, 'https://divo.example.com/me/follow-ups');
  });
});

