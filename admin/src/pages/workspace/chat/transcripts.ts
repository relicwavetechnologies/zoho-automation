/**
 * Scripted runs.
 *
 * This file is the mock — and it is the ONLY mock. Everything that renders
 * `/chat` reads a run from here and knows nothing else, so wiring the real
 * Cloud-Pi backend later means replacing the source of these beats, not
 * rewriting the surface.
 *
 * That is why the beat shape mirrors the run lifecycle the runtime already
 * emits rather than being convenient for the UI: a step opens, tools report
 * lines while it is live, the step settles into one summary sentence, an
 * approval blocks until a person answers, and only then does the answer
 * stream. A backend that pushes `step.started` / `tool.result` /
 * `approval.requested` / `text.delta` / `artifact.created` maps onto this
 * one-for-one.
 *
 * Nothing here calls the network. Every number below is invented.
 */
import type { ToolKey } from './tools'

/** A line the step reports while it is running. */
export type StepLine = {
  text: string
  /** `add` is a write that landed, `warn` is something the reader should see. */
  tone?: 'add' | 'warn' | 'mono'
}

export type TableBlock = {
  kind: 'table'
  caption: string
  columns: string[]
  /** Right-aligned columns, by index — money and counts. */
  numeric?: number[]
  rows: string[][]
  footer?: string
}

export type ChartBlock =
  | {
      kind: 'chart'
      variant: 'line'
      caption: string
      unit: 'money' | 'count'
      series: { label: string; color: string; values: number[] }[]
      labels: string[]
    }
  | {
      kind: 'chart'
      variant: 'bars'
      caption: string
      unit: 'money' | 'count'
      bars: { label: string; value: number; tone?: 'bad' | 'warn' }[]
    }
  | {
      kind: 'chart'
      variant: 'split'
      caption: string
      segments: { label: string; value: number; hint: string; color: string }[]
    }

export type ArtifactBlock = {
  kind: 'artifact'
  tool: ToolKey
  title: string
  meta: string
}

export type Block = TableBlock | ChartBlock | ArtifactBlock

export type Beat =
  /** A tool step. Runs for `ms`, showing `lines`, then folds to `done`. */
  | {
      t: 'step'
      tool: ToolKey
      title: string
      /** The mono chip beside the title — the actual query, file, or target. */
      chip?: string
      mono?: boolean
      ms: number
      lines: StepLine[]
      done: string
      /**
       * The call is still open.
       *
       * Which row shimmers used to be decided by position — the last beat in
       * the list was the live one — and position is not the same fact. A run
       * that narrates after starting a tool pushes a `say` on the end, and the
       * tool that is genuinely still working goes quiet while a finished
       * sentence takes its place. The stream reports each call's own status, so
       * that is what this carries.
       */
      running?: boolean
    }
  /** Blocks the run until a person answers. Nothing after it has happened. */
  | {
      t: 'approve'
      tool: ToolKey
      title: string
      body: string
      facts: { k: string; v: string }[]
      confirm: string
      /** What the run reports if the reader declines. */
      declined: string
    }
  /**
   * Prose the model wrote.
   *
   * `narration` marks the kind that arrived *during* the work — an aside, not
   * a reply — which the thread files inside the work log rather than printing
   * beside the answer. Without the mark the two are indistinguishable by the
   * time they reach a component, and the surface prints the run's thinking-out-
   * loud and its conclusion at identical weight, one after the other.
   */
  | { t: 'say'; text: string; narration?: boolean }
  /** A result rendered under the answer. */
  | { t: 'block'; block: Block }

export type Transcript = {
  id: string
  /** The nav label on the scenario switcher. */
  name: string
  /** What the reader "typed". */
  prompt: string
  /** The apps this run touches, for the scenario switcher. */
  apps: ToolKey[]
  beats: Beat[]
}

/* Chart colours are the workspace's own tokens, so a run replays correctly in
   dark mode and no chart introduces a colour the app does not already use.

   The lead series is `--cur-accent` — blue. cursor.css reserves blue for
   progress and completion and keeps orange for the one promoted action on a
   page, so a chart line drawn in the brand colour would be claiming an
   emphasis it has not earned. The comparison series is drawn in muted ink:
   last month is context, not a second subject. */
const C = {
  lead: 'var(--cur-accent)',
  ink: 'var(--cur-muted-soft)',
  green: 'var(--cur-success)',
  red: 'var(--cur-error)',
}

/* ── 1 — Gmail → Google Sheet ───────────────────────────────
   The export story. It is the most-asked-for thing Divo does, and it is the
   run where the approval gate matters most: everything before it is reading,
   everything after it writes into someone's Drive. */
const EXPORT: Transcript = {
  id: 'export',
  name: 'Inbox → Sheet',
  prompt: "Pull July's Menhood purchase orders out of my inbox and put them in a clean Google Sheet",
  apps: ['gmail', 'terminal', 'sheets'],
  beats: [
    {
      t: 'step',
      tool: 'think',
      title: 'Planning',
      chip: 'Export, not a summary',
      ms: 2100,
      lines: [
        { text: 'Orders arrive as PDF attachments on the supplier thread, so the rows have to be extracted before anything can be written.' },
        { text: 'The Sheet is the artifact. Raw rows stay out of chat — 312 lines of order data is a file, not a message.' },
      ],
      done: 'Decided on a Sheet artifact with extraction first',
    },
    {
      t: 'step',
      tool: 'gmail',
      title: 'Searched Gmail',
      chip: 'from:orders@menhood.in after:2026/07/01',
      mono: true,
      ms: 2600,
      lines: [
        { text: 'Matched 34 threads carrying 41 attachments' },
        { text: 'Dropped 3 duplicate sends by message-id' },
      ],
      done: '34 threads, 41 attachments',
    },
    {
      t: 'step',
      tool: 'gmail',
      title: 'Read attachments',
      chip: '41 PDFs',
      ms: 3200,
      lines: [
        { text: 'Extracted PO number, line items, quantity and total' },
        { text: '2 scanned pages had no text layer — fell back to OCR', tone: 'warn' },
      ],
      done: '312 rows extracted from 41 files',
    },
    {
      t: 'step',
      tool: 'terminal',
      title: 'Normalised',
      chip: 'normalize_orders.py',
      mono: true,
      ms: 2400,
      lines: [
        { text: '+ 312 rows, 9 columns', tone: 'add' },
        { text: 'Currency normalised to INR; 4 rows were quoted in USD', tone: 'mono' },
        { text: '6 rows had no PO number and are flagged, not dropped', tone: 'warn' },
      ],
      done: '312 rows normalised, 6 flagged',
    },
    {
      t: 'approve',
      tool: 'sheets',
      title: 'Create a Google Sheet in your Drive',
      body: 'This is the first write of the run. Everything before it only read.',
      facts: [
        { k: 'Destination', v: 'My Drive → Menhood — July orders' },
        { k: 'Rows', v: '312 across 2 tabs' },
        { k: 'Scope used', v: 'drive.file — create and write, this file only' },
        { k: 'Sharing', v: 'Private to you' },
      ],
      confirm: 'Create the Sheet',
      declined: 'Nothing was written. The normalised rows are still in the run workspace if you want them another way.',
    },
    {
      t: 'step',
      tool: 'sheets',
      title: 'Wrote the Sheet',
      chip: 'Menhood — July orders',
      ms: 2800,
      lines: [
        { text: '+ Orders — 312 rows', tone: 'add' },
        { text: '+ Flagged — 6 rows', tone: 'add' },
        { text: 'Read back 312 rows; count matched what was written' },
      ],
      done: 'Sheet created and verified',
    },
    {
      t: 'say',
      text: "Done — 312 purchase orders from July are in a new Sheet in your Drive. I read them straight off the attachments rather than the mail bodies, because six of the threads had the totals only in the PDF.",
    },
    {
      t: 'say',
      text: 'Two things worth your eye. Six rows arrived without a PO number, so they are on a separate Flagged tab instead of being dropped or guessed. And four rows were quoted in USD — I converted them at the rate on the invoice date, and left the original figure in a note on the cell.',
    },
    {
      t: 'block',
      block: {
        kind: 'table',
        caption: 'First rows',
        columns: ['PO', 'Supplier', 'Placed', 'Qty', 'Value'],
        numeric: [3, 4],
        rows: [
          ['MH-4417', 'Menhood Retail', '02 Jul', '1,200', '₹4,18,400'],
          ['MH-4418', 'Menhood Retail', '04 Jul', '640', '₹2,21,880'],
          ['MH-4421', 'Nectar Supply Co', '07 Jul', '2,050', '₹7,04,150'],
          ['MH-4426', 'Menhood Retail', '11 Jul', '480', '₹1,66,320'],
          ['MH-4430', 'Vanta Distribution', '15 Jul', '1,775', '₹6,12,375'],
        ],
        footer: '307 more rows in the Sheet',
      },
    },
    {
      t: 'block',
      block: {
        kind: 'chart',
        variant: 'line',
        caption: 'Order value by week',
        unit: 'money',
        labels: ['Wk 27', 'Wk 28', 'Wk 29', 'Wk 30', 'Wk 31'],
        series: [
          { label: 'July', color: C.lead, values: [418000, 704000, 512000, 866000, 941000] },
          { label: 'June', color: C.ink, values: [389000, 402000, 455000, 431000, 468000] },
        ],
      },
    },
    {
      t: 'block',
      block: {
        kind: 'artifact',
        tool: 'sheets',
        title: 'Menhood — July orders',
        meta: 'Google Sheet · 2 tabs · 312 rows · private to you',
      },
    },
    {
      t: 'say',
      text: 'July finished 34% above June on order value, and almost all of the gap is the last two weeks. If you want, I can set this to run on the 1st of each month and drop the Sheet in the same folder.',
    },
  ],
}

/* ── 2 — Zoho Books invoice chase ───────────────────────────
   The run that reads across two systems and then wants to send mail on
   somebody's behalf. The approval here guards an outbound action, which is a
   different risk from the export's write. */
const CHASE: Transcript = {
  id: 'chase',
  name: 'Overdue chase',
  prompt: 'Which Zoho invoices are overdue past 30 days, and draft a chase mail for each account owner',
  apps: ['zohoBooks', 'zohoCrm', 'gmail'],
  beats: [
    {
      t: 'step',
      tool: 'think',
      title: 'Planning',
      chip: 'Two systems, one list',
      ms: 1900,
      lines: [
        { text: 'Books has the invoice and the ageing; CRM has who owns the account. Neither alone can address a mail.' },
        { text: 'Drafting is safe, sending is not. I will stop before anything leaves.' },
      ],
      done: 'Books for ageing, CRM for owners, draft only',
    },
    {
      t: 'step',
      tool: 'zohoBooks',
      title: 'Read invoices',
      chip: 'status:overdue',
      mono: true,
      ms: 2700,
      lines: [
        { text: '47 overdue invoices, ₹18,42,600 outstanding' },
        { text: '18 of them are past 30 days' },
        { text: '3 carry a partial payment already', tone: 'mono' },
      ],
      done: '18 invoices past 30 days, ₹11,04,900',
    },
    {
      t: 'step',
      tool: 'zohoCrm',
      title: 'Matched owners',
      chip: '18 accounts',
      ms: 2300,
      lines: [
        { text: 'Matched 16 accounts by customer id' },
        { text: '2 accounts have no owner set in CRM — those are yours by default', tone: 'warn' },
      ],
      done: '16 matched, 2 unowned',
    },
    {
      t: 'step',
      tool: 'gmail',
      title: 'Drafted mail',
      chip: '16 drafts',
      ms: 3100,
      lines: [
        { text: 'One mail per account, not per invoice — three owners had two invoices each' },
        { text: 'Each draft quotes the invoice number, the amount and the days overdue' },
        { text: 'Tone matched the last thread with that account' },
      ],
      done: '16 drafts written, none sent',
    },
    {
      t: 'block',
      block: {
        kind: 'chart',
        variant: 'bars',
        caption: 'Outstanding by age',
        unit: 'money',
        bars: [
          { label: '0–30', value: 737700 },
          { label: '31–60', value: 486200 },
          { label: '61–90', value: 351400 },
          { label: '90+', value: 267300, tone: 'bad' },
        ],
      },
    },
    {
      t: 'approve',
      tool: 'gmail',
      title: 'Send 16 chase mails',
      body: 'These go out from your address to your customers. I have not sent anything.',
      facts: [
        { k: 'Recipients', v: '16 accounts, 18 invoices' },
        { k: 'From', v: 'you@emiactech.com' },
        { k: 'Total chased', v: '₹11,04,900' },
        { k: 'Unowned', v: '2 accounts default to you' },
      ],
      confirm: 'Send all 16',
      declined: 'Nothing sent. All 16 drafts are sitting in your Gmail drafts folder if you want to read them first.',
    },
    {
      t: 'say',
      text: 'Eighteen invoices are past 30 days, worth ₹11,04,900 — a little under two-thirds of everything outstanding. I have written one mail per account rather than one per invoice, so three owners get a single mail covering both of their overdue bills.',
    },
    {
      t: 'say',
      text: 'The 90-plus bucket is the one to look at: ₹2,67,300 across four accounts, and two of those have not replied to anything since April. Chasing those by mail again may not be the right move.',
    },
    {
      t: 'block',
      block: {
        kind: 'table',
        caption: 'Oldest first',
        columns: ['Invoice', 'Account', 'Owner', 'Days', 'Amount'],
        numeric: [3, 4],
        rows: [
          ['INV-2291', 'Rathi Textiles', 'Aleem', '118', '₹1,04,200'],
          ['INV-2304', 'Sunbeam Traders', '—', '96', '₹78,500'],
          ['INV-2318', 'Kavi Exports', 'Priya', '91', '₹52,300'],
          ['INV-2333', 'Lodha Interiors', 'Aleem', '74', '₹47,900'],
          ['INV-2340', 'Nectar Supply Co', 'Priya', '61', '₹1,12,400'],
        ],
        footer: '13 more in the drafts',
      },
    },
    {
      t: 'block',
      block: {
        kind: 'artifact',
        tool: 'gmail',
        title: '16 chase drafts',
        meta: 'Gmail drafts · unsent · editable before you send',
      },
    },
  ],
}

/* ── 3 — Lark daily brief ───────────────────────────────────
   The parity run. It reads Lark and writes back to Lark, which is the point:
   this web surface and the Lark surface are two views of one runtime, and the
   brief exists in Lark whichever one you started it from. */
const BRIEF: Transcript = {
  id: 'brief',
  name: 'Daily brief',
  prompt: "What's on for me today — pull my Lark tasks and calendar, then post the brief back to Lark",
  apps: ['lark', 'lark', 'lark'],
  beats: [
    {
      t: 'step',
      tool: 'think',
      title: 'Planning',
      chip: 'Read both, then rank',
      ms: 1700,
      lines: [
        { text: 'A brief is only useful if it is ordered by what will actually bite today, not by start time.' },
        { text: 'Calendar first, because meetings are fixed and tasks have to fit around them.' },
      ],
      done: 'Calendar, then tasks, ranked by pressure',
    },
    {
      t: 'step',
      tool: 'lark',
      title: 'Read calendar',
      chip: 'today',
      ms: 2200,
      lines: [
        { text: '6 events, 4h 15m booked' },
        { text: '2 overlap between 14:00 and 14:30', tone: 'warn' },
        { text: 'One has no agenda and 9 attendees', tone: 'warn' },
      ],
      done: '6 events, one clash',
    },
    {
      t: 'step',
      tool: 'lark',
      title: 'Read tasks',
      chip: 'assigned to me',
      ms: 2400,
      lines: [
        { text: '11 open, 3 due today' },
        { text: '2 are blocked waiting on someone else', tone: 'warn' },
        { text: '1 has been rolled forward 4 times', tone: 'warn' },
      ],
      done: '11 open, 3 due today',
    },
    {
      t: 'block',
      block: {
        kind: 'chart',
        variant: 'split',
        caption: 'Where today goes',
        segments: [
          { label: 'Meetings', value: 4.25, hint: '6 events, one of them a clash you have not resolved', color: C.lead },
          { label: 'Focus', value: 2.5, hint: 'What is left between the 11:00 and the 15:30', color: C.green },
          { label: 'Blocked', value: 1.25, hint: 'Two tasks that cannot move until someone else replies', color: C.ink },
        ],
      },
    },
    {
      t: 'approve',
      tool: 'lark',
      title: 'Post the brief to Lark',
      body: 'This posts a card into your Lark chat with Divo. Your team does not see it.',
      facts: [
        { k: 'Channel', v: 'Direct message — Divo → you' },
        { k: 'Card', v: 'Daily brief · 6 events · 3 tasks due' },
        { k: 'Visible to', v: 'You only' },
      ],
      confirm: 'Post it',
      declined: 'Not posted. The brief is here in the thread either way.',
    },
    {
      t: 'step',
      tool: 'lark',
      title: 'Posted to Lark',
      chip: 'Daily brief card',
      ms: 1800,
      lines: [
        { text: '+ Interactive card delivered in 1.4s', tone: 'add' },
        { text: 'Buttons on the card run the same actions as this thread' },
      ],
      done: 'Delivered to your Lark DM',
    },
    {
      t: 'say',
      text: 'Four and a quarter hours of your day is already booked, and there is a clash at 14:00 — the vendor sync and the design review both start then. Neither has been moved, so one of them is going to be someone waiting in an empty call.',
    },
    {
      t: 'say',
      text: 'Three tasks are due today. Two of them are blocked on other people, which leaves exactly one you can actually finish: the Q3 spend note. It has also been rolled forward four times, which is usually the signal that it needs 20 minutes rather than another day.',
    },
    {
      t: 'block',
      block: {
        kind: 'table',
        caption: 'Due today',
        columns: ['Task', 'List', 'Due', 'State'],
        rows: [
          ['Q3 spend note', 'Finance', '18:00', 'Open'],
          ['Approve vendor SOW', 'Ops', '12:00', 'Blocked — waiting on Aleem'],
          ['Sign off brand kit', 'Design', '17:00', 'Blocked — waiting on Canva export'],
        ],
        footer: '8 more open, none due today',
      },
    },
    {
      t: 'block',
      block: {
        kind: 'artifact',
        tool: 'lark',
        title: 'Daily brief',
        meta: 'Lark card · delivered to your DM · buttons are live',
      },
    },
  ],
}

export const TRANSCRIPTS: Transcript[] = [EXPORT, CHASE, BRIEF]

/**
 * Picks the run a typed prompt should play.
 *
 * Scored rather than first-match, because the prompts overlap: "draft a chase
 * mail" contains "mail", which would hand the invoice run to the export
 * transcript if these were tested in order. Whichever run recognises the most
 * words wins, and the export run breaks ties as the most representative thing
 * Divo does.
 */
const SIGNALS: Record<string, RegExp[]> = {
  export: [/sheet/, /export/, /inbox/, /purchase order/, /spreadsheet/, /gmail/, /attachment/],
  chase: [/zoho/, /invoice/, /overdue/, /chase/, /books/, /crm/, /payment/, /outstanding/],
  brief: [/lark/, /brief/, /today/, /calendar/, /\btask/, /my day/, /schedule/, /meeting/],
}

export function transcriptFor(prompt: string): Transcript {
  const q = prompt.toLowerCase()
  let best = EXPORT
  let bestScore = 0
  for (const run of TRANSCRIPTS) {
    const score = SIGNALS[run.id].reduce((n, re) => n + (re.test(q) ? 1 : 0), 0)
    if (score > bestScore) {
      best = run
      bestScore = score
    }
  }
  return best
}
