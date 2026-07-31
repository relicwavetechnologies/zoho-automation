/**
 * pitch-status-card — render the run status card into a real Lark chat.
 *
 * The card is only judgeable in the client: spacing, chip weight, how a folded
 * plan sits under an activity list, and whether anything reads as repeated are
 * all things a JSON snapshot hides. So this drives the real builder through the
 * real adapter, editing one message the way a live run does, rather than
 * printing a payload for inspection.
 *
 * It calls no model and starts no container — the timeline is scripted, so the
 * frames are stable and the same pitch can be re-run after a tweak.
 *
 * Usage:
 *   pnpm tsx scripts/pitch-status-card.ts                 # animate, settle on Done
 *   pnpm tsx scripts/pitch-status-card.ts --frame working # one frame, then stop
 *   pnpm tsx scripts/pitch-status-card.ts --list          # frame names
 *   pnpm tsx scripts/pitch-status-card.ts --chat-id oc_x  # must be allow-listed
 *   pnpm tsx scripts/pitch-status-card.ts --reply         # final-reply cards instead
 *   pnpm tsx scripts/pitch-status-card.ts --dry-run       # print JSON, send nothing
 */
import 'dotenv/config';
import { buildContainer } from '../src/composition';
import { loadAndValidateEnv } from '../src/config/env';
import { buildFinalCard, buildStatusCard } from '../src/infrastructure/channels/lark/lark-card.builder';
import type { StatusCardInput } from '../src/infrastructure/channels/lark/lark-card.builder';

const DM_CHAT_ID = 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50';
const FRAME_HOLD_MS = 2_600;

/**
 * Frames are written as offsets from "now" so the footer clock reads like a real
 * run at whatever moment the pitch is sent, rather than a frozen number.
 */
type Frame = { readonly name: string; readonly at: number; readonly build: (startedAtMs: number) => StatusCardInput };

const SUBJECT = 'Monday sales report for the leadership channel';

const FRAMES: readonly Frame[] = [
  {
    name: 'thinking',
    at: 2_000,
    build: startedAtMs => ({
      timeline: {
        subject: SUBJECT,
        state: 'thinking',
        startedAtMs,
        actionCount: 0,
      },
    }),
  },
  {
    name: 'planning',
    at: 9_000,
    build: startedAtMs => ({
      timeline: {
        subject: SUBJECT,
        state: 'planning',
        startedAtMs,
        actionCount: 1,
        liveLabel: 'Checking which report you meant, and who is on the channel',
        declared: {
          done: 0,
          total: 4,
          current: 'Pull last week’s closed deals',
          items: [
            { title: 'Pull last week’s closed deals', status: 'running' },
            { title: 'Compare against the quarter target', status: 'pending' },
            { title: 'Draft the summary', status: 'pending' },
            { title: 'Post to the leadership channel', status: 'pending' },
          ],
        },
      },
    }),
  },
  {
    name: 'working',
    at: 48_000,
    build: startedAtMs => ({
      timeline: {
        subject: SUBJECT,
        state: 'working',
        startedAtMs,
        actionCount: 9,
        ledger: [
          { label: 'Zoho CRM', count: 3, outcome: '48 closed deals', status: 'done' },
          { label: 'Lark calendar', count: 1, outcome: 'Leadership sync at 09:30', status: 'done' },
          {
            label: 'Subagents',
            count: 1,
            outcome: '2 running',
            status: 'running',
            children: [
              { label: 'scout', count: 1, outcome: 'reading the pipeline export', status: 'running' },
              { label: 'reviewer', count: 1, outcome: 'checking last week’s numbers', status: 'running' },
            ],
          },
        ],
        declared: {
          done: 1,
          total: 4,
          current: 'Compare against the quarter target',
          items: [
            { title: 'Pull last week’s closed deals', status: 'done' },
            { title: 'Compare against the quarter target', status: 'running' },
            { title: 'Draft the summary', status: 'pending' },
            { title: 'Post to the leadership channel', status: 'pending' },
          ],
        },
      },
    }),
  },
  {
    name: 'recovering',
    at: 74_000,
    build: startedAtMs => ({
      timeline: {
        subject: SUBJECT,
        state: 'working',
        startedAtMs,
        actionCount: 14,
        ledger: [
          { label: 'Zoho CRM', count: 3, outcome: '48 closed deals', status: 'done' },
          { label: 'Lark calendar', count: 1, outcome: 'Leadership sync at 09:30', status: 'done' },
          {
            label: 'Subagents',
            count: 1,
            outcome: 'scout and reviewer agreed',
            status: 'done',
            children: [
              { label: 'scout', count: 1, outcome: 'pipeline export read', status: 'done' },
              { label: 'reviewer', count: 1, outcome: 'no discrepancy found', status: 'done' },
            ],
          },
          { label: 'Zoho Analytics', count: 2, outcome: 'quarter target unavailable', status: 'failed' },
          { label: 'Web search', count: 1, outcome: 'sourcing the target from the plan doc', status: 'running' },
        ],
        declared: {
          done: 2,
          total: 4,
          current: 'Draft the summary',
          items: [
            { title: 'Pull last week’s closed deals', status: 'done' },
            { title: 'Compare against the quarter target', status: 'done' },
            { title: 'Draft the summary', status: 'running' },
            { title: 'Post to the leadership channel', status: 'pending' },
          ],
        },
      },
    }),
  },
  {
    name: 'done',
    at: 96_000,
    build: startedAtMs => ({
      timeline: {
        subject: SUBJECT,
        state: 'done',
        startedAtMs,
        actionCount: 17,
        ledger: [
          { label: 'Zoho CRM', count: 3, outcome: '48 closed deals', status: 'done' },
          { label: 'Lark calendar', count: 1, outcome: 'Leadership sync at 09:30', status: 'done' },
          {
            label: 'Subagents',
            count: 1,
            outcome: 'scout and reviewer agreed',
            status: 'done',
            children: [
              { label: 'scout', count: 1, outcome: 'pipeline export read', status: 'done' },
              { label: 'reviewer', count: 1, outcome: 'no discrepancy found', status: 'done' },
            ],
          },
          { label: 'Zoho Analytics', count: 2, outcome: 'quarter target unavailable', status: 'failed' },
          { label: 'Web search', count: 1, outcome: 'target found in the FY plan', status: 'done' },
          { label: 'Lark message', count: 1, outcome: 'posted to #leadership', status: 'done' },
        ],
        declared: {
          done: 4,
          total: 4,
          items: [
            { title: 'Pull last week’s closed deals', status: 'done' },
            { title: 'Compare against the quarter target', status: 'done' },
            { title: 'Draft the summary', status: 'done' },
            { title: 'Post to the leadership channel', status: 'done' },
          ],
        },
      },
    }),
  },
];

/** Final-reply shapes, to check what the header does when the answer is short. */
const REPLY_SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ['plain', 'Hi there! How can I help you today?'],
  ['titled', '# Finance Update\n\nAll three invoices reconciled against the bank feed.\n\n| Customer | Amount | Status |\n|---|---:|---|\n| Acme Corp | 42,000 | Paid |\n| Northwind | 18,500 | Aging |'],
];

export interface PitchOptions {
  readonly chatId: string;
  readonly frames: readonly Frame[];
  readonly dryRun: boolean;
  readonly holdMs: number;
  readonly replies: boolean;
}

export function parsePitchArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): PitchOptions {
  let chatId = env.HARNESS_LARK_CHAT_ID?.trim() || DM_CHAT_ID;
  let frames = FRAMES;
  let dryRun = false;
  let holdMs = FRAME_HOLD_MS;
  let replies = false;

  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--dry-run') { dryRun = true; continue; }
    if (value === '--reply') { replies = true; continue; }
    if (value === '--chat-id' || value === '--frame' || value === '--hold-ms') {
      const optionValue = args[++index]?.trim();
      if (!optionValue) throw new Error(`${value} requires a value`);
      if (value === '--chat-id') chatId = optionValue;
      if (value === '--hold-ms') {
        const parsed = Number(optionValue);
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error('--hold-ms must be a number');
        holdMs = parsed;
      }
      if (value === '--frame') {
        const picked = FRAMES.find(frame => frame.name === optionValue);
        if (!picked) {
          throw new Error(`Unknown frame ${optionValue}. Known: ${FRAMES.map(f => f.name).join(', ')}`);
        }
        frames = [picked];
      }
      continue;
    }
    throw new Error(`Unknown option: ${value}`);
  }

  // Same guard as the engine harness: a pitch writes into a real chat, so the
  // destination has to be one somebody already opted in.
  const allowed = new Set([
    DM_CHAT_ID,
    ...(env.HARNESS_LARK_ALLOWED_CHAT_IDS ?? '').split(',').map(value => value.trim()),
  ].filter(Boolean));
  if (!dryRun && !allowed.has(chatId)) {
    throw new Error(`Chat ${chatId} is not in HARNESS_LARK_ALLOWED_CHAT_IDS`);
  }

  return { chatId, frames, dryRun, holdMs, replies };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    console.log(FRAMES.map(frame => frame.name).join('\n'));
    return;
  }
  const options = parsePitchArgs(args);
  const now = Date.now();

  if (options.dryRun && options.replies) {
    for (const [name, markdown] of REPLY_SAMPLES) {
      const payload = JSON.parse(buildFinalCard({ markdown })) as { card: string };
      console.log(`\n─── reply:${name} ───`);
      console.log(JSON.stringify(JSON.parse(payload.card), null, 2));
    }
    return;
  }

  if (options.dryRun) {
    for (const frame of options.frames) {
      const payload = JSON.parse(buildStatusCard(frame.build(now - frame.at))) as { card: string };
      console.log(`\n─── ${frame.name} ───`);
      console.log(JSON.stringify(JSON.parse(payload.card), null, 2));
    }
    return;
  }

  const env = loadAndValidateEnv(process.env);
  const container = await buildContainer(env);
  const { larkAdapter } = container;

  if (options.replies) {
    // A headerless card is a shape Lark has never been sent before, so it is
    // worth putting in front of the client rather than trusting the schema.
    for (const [name, markdown] of REPLY_SAMPLES) {
      const sent = await larkAdapter.sendToChatId(options.chatId, buildFinalCard({ markdown }));
      if (!sent.ok) throw new Error(`reply ${name} failed: ${sent.error.message}`);
      console.log(`  reply:${name.padEnd(9)} sent    ${sent.value}`);
      await sleep(600);
    }
    await container.prisma.$disconnect();
    process.exit(0);
  }

  console.log(`pitching ${options.frames.length} frame(s) into ${options.chatId}`);

  let messageId: string | undefined;
  for (const frame of options.frames) {
    const content = buildStatusCard(frame.build(now - frame.at));

    if (!messageId) {
      const sent = await larkAdapter.sendToChatId(options.chatId, content);
      if (!sent.ok) throw new Error(`send failed on frame ${frame.name}: ${sent.error.message}`);
      messageId = sent.value;
      console.log(`  ${frame.name.padEnd(11)} sent    ${messageId}`);
    } else {
      const edited = await larkAdapter.updateMessageById(messageId, content);
      if (!edited.ok) throw new Error(`update failed on frame ${frame.name}: ${edited.error.message}`);
      console.log(`  ${frame.name.padEnd(11)} updated`);
    }

    if (frame !== options.frames[options.frames.length - 1]) await sleep(options.holdMs);
  }

  await container.prisma.$disconnect();
  process.exit(0);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error('PITCH FAILED:', error);
    process.exit(1);
  });
}
