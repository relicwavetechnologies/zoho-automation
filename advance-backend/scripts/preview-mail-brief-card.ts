/**
 * Send the real brief card to a Lark DM, built by the shipped composer.
 *
 * The model is stubbed and the window is mock, but everything below that is
 * production code: the same `createMailBriefComposer`, the same card JSON, the
 * same sanitiser. A card that Lark rejects is rejected for the same reason it
 * would be at 09:00, which is the only way to find that out before a member
 * does.
 *
 * Reads no mail, runs no rule, writes no row.
 *
 * Usage:
 *   MAIL_BRIEF_PREVIEW_CHAT_ID=oc_… pnpm tsx scripts/preview-mail-brief-card.ts
 *   pnpm tsx scripts/preview-mail-brief-card.ts --chat-id oc_…
 */
import 'dotenv/config';
import {
  createMailBriefComposer,
  type MailBriefWindow,
} from '../src/application/mail-ops/mail-brief';
import { LarkMessagingClient } from '../src/infrastructure/channels/lark/clients/lark-messaging.client';
import { ConsoleLogger } from '../src/shared/logger';

/** Returns whatever it is handed, so each state can be produced on demand. */
const modelReturning = (text: string) => ({
  specificationVersion: 'v2' as const,
  provider: 'preview',
  modelId: 'preview',
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

const at = (iso: string) => new Date(iso);

const message = (from: string, subject: string, snippet: string, iso: string) =>
  ({ from, subject, snippet, occurredAt: at(iso) });

const BASE: MailBriefWindow = {
  mailboxEmail: 'abhishek@emiactech.com',
  mailboxActive: true,
  from: at('2026-08-10T03:30:00.000Z'),
  to: at('2026-08-10T10:30:00.000Z'),
  timeZone: 'Asia/Kolkata',
  messages: [
    message('Priya Nair <priya@vendor.com>', 'Invoice #4821 — approval pending', 'Second reminder on the August invoice.', '2026-08-10T08:52:00.000Z'),
    message('Rohit Sharma <rohit@emiactech.com>', 'Re: Q3 content calendar', 'Both dates work on our side.', '2026-08-10T06:35:00.000Z'),
    message('Zoho Books <no-reply@zoho.com>', 'Reimbursement claim returned', 'A receipt is missing from claim R-2291.', '2026-08-10T05:11:00.000Z'),
    ...Array.from({ length: 9 }, (_, i) =>
      message(`Sender ${i} <s${i}@list.com>`, `Subject ${i}`, '…', '2026-08-10T04:00:00.000Z')),
  ],
  handled: [
    { ruleName: 'Forward to anishsuman2305', delivered: 4, held: 0, blocked: 0, failed: 0 },
    { ruleName: 'Judge test — urgent only', delivered: 0, held: 2, blocked: 1, failed: 0 },
  ],
};

const WANTS = JSON.stringify({
  wants: [
    { index: 0, want: 'Needs your sign-off before the vendor call at 3pm.' },
    { index: 1, want: 'Waiting on your pick between the two launch dates.' },
    { index: 2, want: 'Wants the missing receipt re-uploaded before Friday.' },
  ],
});

const STATES: ReadonlyArray<{
  label: string;
  modelText: string;
  window: MailBriefWindow;
}> = [
  { label: 'needs you', modelText: WANTS, window: BASE },
  { label: 'quiet', modelText: '{"wants":[]}', window: BASE },
  { label: 'degraded', modelText: 'I could not do that.', window: BASE },
  {
    label: 'paused mailbox',
    modelText: '{"wants":[]}',
    window: { ...BASE, mailboxActive: false, messages: [] },
  },
];

async function main() {
  const chatIdFlag = process.argv.indexOf('--chat-id');
  const chatId = chatIdFlag >= 0
    ? process.argv[chatIdFlag + 1]
    : process.env['MAIL_BRIEF_PREVIEW_CHAT_ID'];
  if (!chatId) {
    throw new Error('Pass --chat-id or set MAIL_BRIEF_PREVIEW_CHAT_ID.');
  }

  const client = new LarkMessagingClient({
    appId: process.env['LARK_APP_ID'] ?? '',
    appSecret: process.env['LARK_APP_SECRET'] ?? '',
    logger: new ConsoleLogger(),
    ...(process.env['LARK_API_BASE_URL']
      ? { apiBaseUrl: process.env['LARK_API_BASE_URL'] }
      : {}),
  });

  for (const state of STATES) {
    const compose = createMailBriefComposer({
      model: modelReturning(state.modelText) as never,
    });
    const brief = await compose(state.window);
    const sent = await client.sendCardToChat(chatId, brief.card);
    console.log(
      `${state.label.padEnd(16)} wants=${brief.wantCount} degraded=${brief.degraded} `
      + `message=${sent.messageId}`,
    );
  }
}

main().catch(error => { console.error('CRASH:', error); process.exit(1); });
