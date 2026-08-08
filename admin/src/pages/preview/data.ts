/**
 * Fixtures for the Mail preview.
 *
 * Everything here is invented. Nothing in `src/pages/preview` talks to the
 * backend — the point of this route is to argue for a product before any of it
 * is built, and a prototype that half-fetches is a prototype that breaks in the
 * room where you are trying to show it.
 *
 * The shapes deliberately mirror the real ones (`MailRuleMatch`,
 * `MailRuleAction`, `MailRuleDestination`, `MailDelivery`) so that when this
 * becomes real, the argument is about wiring rather than about redesigning.
 */

export type Mode = 'first-run' | 'running' | 'trouble'

/* ── People ─────────────────────────────────────────── */
export const ME = {
  name: 'Rahul Sharma',
  email: 'rahul@emiactech.com',
  initials: 'RS',
  company: 'EmiacTech',
  title: 'Finance',
  timeZone: 'Asia/Kolkata',
}

/* ── Mail ───────────────────────────────────────────── */
export type Attachment = { name: string; size: string; kind: 'pdf' | 'xlsx' | 'img' }

export type Link = { text: string; href: string }

export type Message = {
  id: string
  fromName: string
  fromEmail: string
  to: string
  at: string
  body: string[]
  links?: Link[]
  attachments?: Attachment[]
}

/**
 * A thread, as the message view renders it.
 *
 * There is no list of these anywhere in the product — see the header of
 * `reader.tsx`. A thread is only ever reached by opening one specific row in
 * Caught or one line in the brief, which is why it carries no preview text, no
 * unread flag and no bucket: nothing here is ever browsed.
 */
export type Thread = {
  id: string
  subject: string
  fromName: string
  fromEmail: string
  at: string
  /** Set when a rule acted on this thread — the reader shows it as a chip. */
  handledBy?: { rule: string; outcome: string; tone: 'ok' | 'held' | 'fail' }
  messages: Message[]
}

export const THREADS: Thread[] = [
  {
    id: 't-invoice-4471',
    subject: 'Invoice #4471 — due 14 Aug',
    fromName: 'Acme Billing',
    fromEmail: 'billing@acme-supplies.com',
    at: '09:14',
    handledBy: { rule: 'Vendor invoices → Finance', outcome: 'Forwarded to finance@emiactech.com', tone: 'ok' },
    messages: [
      {
        id: 'm1',
        fromName: 'Acme Billing',
        fromEmail: 'billing@acme-supplies.com',
        to: 'rahul@emiactech.com',
        at: 'Today, 09:14',
        body: [
          'Hi Rahul,',
          'Please find attached the invoice for July services. Payment terms are net 14, so this one falls due on 14 August.',
          'If anything on it looks wrong, reply here and we will re-issue rather than credit-note.',
          'Thanks,\nPriya — Acme Supplies',
        ],
        links: [
          { text: 'View and pay online', href: 'pay.acme-billing-portal.net/i/4471' },
          { text: 'acme-supplies.com', href: 'acme-supplies.com' },
        ],
        attachments: [{ name: 'invoice-4471.pdf', size: '1.2 MB', kind: 'pdf' }],
      },
    ],
  },
  {
    id: 't-renewal',
    subject: 'Re: Renewal terms for the Q3 contract',
    fromName: 'Meera Iyer',
    fromEmail: 'meera@northbridge.co',
    at: '08:02',
    messages: [
      {
        id: 'm1',
        fromName: 'Rahul Sharma',
        fromEmail: 'rahul@emiactech.com',
        to: 'meera@northbridge.co',
        at: 'Mon, 16:40',
        body: ['Meera — attaching the revised terms. The cap moves to 1.2× and the notice period stays at 30 days.'],
      },
      {
        id: 'm2',
        fromName: 'Meera Iyer',
        fromEmail: 'meera@northbridge.co',
        to: 'rahul@emiactech.com',
        at: 'Today, 08:02',
        body: [
          'That works on our side.',
          'Can you confirm the revised cap in writing before Friday? Our legal will not counter-sign without it and we lose the week otherwise.',
          'Meera',
        ],
        links: [{ text: 'northbridge.co/terms', href: 'northbridge.co/terms' }],
      },
    ],
  },
  {
    id: 't-otp',
    subject: 'Your verification code is 448120',
    fromName: 'Zoho Accounts',
    fromEmail: 'no-reply@accounts.zoho.com',
    at: '08:44',
    handledBy: { rule: 'Login codes → my Lark DM', outcome: 'Sent the code only, to your Lark DM', tone: 'ok' },
    messages: [
      {
        id: 'm1',
        fromName: 'Zoho Accounts',
        fromEmail: 'no-reply@accounts.zoho.com',
        to: 'rahul@emiactech.com',
        at: 'Today, 08:44',
        body: ['Use this code to finish signing in:', '448120', 'It expires in 10 minutes. If this was not you, change your password.'],
      },
    ],
  },
  {
    id: 't-webinar',
    subject: 'Last chance: the 2026 FinOps benchmark webinar',
    fromName: 'Ledgerly',
    fromEmail: 'growth@ledgerly.io',
    at: '07:20',
    handledBy: { rule: 'Vendor invoices → Finance', outcome: 'Held back — Divo read it as marketing', tone: 'held' },
    messages: [
      {
        id: 'm1',
        fromName: 'Ledgerly',
        fromEmail: 'growth@ledgerly.io',
        to: 'rahul@emiactech.com',
        at: 'Today, 07:20',
        body: [
          'Only 40 seats left.',
          'Join 3,000 finance leaders this Thursday for the 2026 FinOps benchmark. We will cover close cycles, spend visibility and the three metrics your board asks about.',
          'Save your seat below.',
        ],
        links: [{ text: 'Save my seat', href: 'click.ledgerly.io/r/9f2b3?u=rahul%40emiactech.com' }],
      },
    ],
  },
  {
    id: 't-gst',
    subject: 'GSTR-1 filing acknowledgement — July 2026',
    fromName: 'GST Portal',
    fromEmail: 'donotreply@gst.gov.in',
    at: 'Yesterday',
    messages: [
      {
        id: 'm1',
        fromName: 'GST Portal',
        fromEmail: 'donotreply@gst.gov.in',
        to: 'rahul@emiactech.com',
        at: 'Yesterday, 19:31',
        body: ['Your return for the period 07/2026 has been filed.', 'ARN: AA2907260041827', 'This is a system-generated message. Do not reply.'],
        attachments: [{ name: 'GSTR1-ack-072026.pdf', size: '84 KB', kind: 'pdf' }],
      },
    ],
  },
  {
    id: 't-payroll',
    subject: 'Payroll run needs your sign-off before 18:00',
    fromName: 'Aleem Khan',
    fromEmail: 'aleem@emiactech.com',
    at: 'Yesterday',
    messages: [
      {
        id: 'm1',
        fromName: 'Aleem Khan',
        fromEmail: 'aleem@emiactech.com',
        to: 'rahul@emiactech.com',
        at: 'Yesterday, 15:02',
        body: [
          'Rahul — I have loaded August payroll. Two new joiners and one correction carried over from July.',
          'It needs your sign-off before 18:00 today or it slips to the next cycle.',
        ],
        attachments: [{ name: 'august-payroll.xlsx', size: '312 KB', kind: 'xlsx' }],
      },
    ],
  },
  {
    id: 't-newsletter',
    subject: 'The Monday Memo — what changed in Indian tax this week',
    fromName: 'TaxWire',
    fromEmail: 'memo@taxwire.in',
    at: 'Mon',
    messages: [
      {
        id: 'm1',
        fromName: 'TaxWire',
        fromEmail: 'memo@taxwire.in',
        to: 'rahul@emiactech.com',
        at: 'Mon, 06:00',
        body: ['Three notifications, one circular, and the one deadline nobody has diarised.', 'Read the full memo on the web.'],
        links: [{ text: 'Read on the web', href: 'links.taxwire.in/c/8812/rahul' }],
      },
    ],
  },
]

/* ── Rules ──────────────────────────────────────────── */

/**
 * What the model is asked to do, when a rule uses one.
 *
 * Two modes, because the model is doing one of exactly two jobs: **gating** a
 * message (Judge) or **producing** something from it (Extract, and Draft on the
 * action side). A third mode, Classify, was designed and cut — a closed label
 * list is only worth paying for if something downstream consumes the label, and
 * nothing does. Judge answers the same question for less.
 */
export type BrainMode = 'judge' | 'extract'

export type Brain = {
  mode: BrainMode
  /** Judge: the question. Extract: what to pull out. */
  prompt: string
  /** Extract only. Only these leave the message. */
  fields?: string[]
  /** What happens when the AI says no / when it errors. */
  onReject: 'stop' | 'continue'
  failure: 'open' | 'closed'
  /** Rupees per message, shown on the node so the cost is never a surprise. */
  costPerMessage: number
  monthlyCeiling: number
}

/**
 * What starts a rule.
 *
 * `arrival` is every rule that exists today: mail lands, the rule runs.
 *
 * `watch` is the one nobody else does — it fires on **absence**. "The GST
 * acknowledgement should be here by the 11th" cannot be expressed as a filter
 * in any mail client, because a filter needs a message to match and the whole
 * point is that there isn't one. It costs nothing (a scheduled search, no model)
 * and it is the only rule kind that can tell you about something that failed to
 * happen.
 */
export type RuleKind = 'arrival' | 'watch'

export type Rule = {
  id: string
  kind: RuleKind
  name: string
  state: 'working' | 'paused' | 'blocked' | 'broken' | 'over-budget'
  mailbox: string
  match: {
    from?: string
    subjectContains?: string
    hasAttachment?: boolean
    notFrom?: string
    window?: { days: string; start: string; end: string; timeZone: string }
  }
  /** `watch` only — when the expected mail stops being merely late. */
  deadline?: { by: string; repeats: string }
  brain?: Brain
  action: {
    type: 'forward' | 'deliver' | 'organize' | 'draft'
    rateLimitPerHour?: number
    label?: string
    /** `draft` only. The instruction the reply is written from. */
    instruction?: string
    costPerMessage?: number
  }
  destination: { type: 'email' | 'lark_dm' | 'lark_chat' | 'gmail_draft' | 'none'; value?: string }
  seen: number
  acted: number
  held: number
  failed: number
  lastAt: string
  external?: boolean
}

export const RULES: Rule[] = [
  {
    id: 'r-invoices',
    kind: 'arrival',
    name: 'Vendor invoices → Finance',
    state: 'working',
    mailbox: 'rahul@emiactech.com',
    match: { subjectContains: 'invoice', hasAttachment: true, notFrom: 'no-reply@' },
    brain: {
      mode: 'judge',
      prompt: 'Is this a real invoice addressed to us, rather than marketing, a quote, or a payment reminder for something already paid?',
      onReject: 'stop',
      failure: 'open',
      costPerMessage: 0.04,
      monthlyCeiling: 400,
    },
    action: { type: 'forward', rateLimitPerHour: 20 },
    destination: { type: 'email', value: 'finance@emiactech.com' },
    seen: 412, acted: 96, held: 38, failed: 0, lastAt: '9 minutes ago',
    external: false,
  },
  {
    id: 'r-otp',
    kind: 'arrival',
    name: 'Login codes → my Lark DM',
    state: 'working',
    mailbox: 'rahul@emiactech.com',
    match: { subjectContains: 'verification code' },
    brain: {
      mode: 'extract',
      prompt: 'Pull the one-time code and who it is for.',
      fields: ['code', 'service', 'expiresIn'],
      onReject: 'stop',
      failure: 'closed',
      costPerMessage: 0.03,
      monthlyCeiling: 150,
    },
    action: { type: 'deliver' },
    destination: { type: 'lark_dm', value: 'Rahul Sharma' },
    seen: 88, acted: 84, held: 0, failed: 4, lastAt: '2 hours ago',
  },
  {
    id: 'r-complaints',
    kind: 'arrival',
    name: 'Unhappy customers → a reply, ready to send',
    state: 'working',
    mailbox: 'rahul@emiactech.com',
    match: { subjectContains: '', window: { days: 'Mon–Fri', start: '09:00', end: '19:00', timeZone: 'Asia/Kolkata' } },
    brain: {
      mode: 'judge',
      prompt: 'Is this customer reporting a problem with something we sold or delivered?',
      onReject: 'stop',
      failure: 'closed',
      costPerMessage: 0.04,
      monthlyCeiling: 300,
    },
    action: {
      type: 'draft',
      instruction: 'Acknowledge the specific problem in their own words, say what happens next, and give a date. Do not apologise twice or promise a refund.',
      costPerMessage: 0.11,
    },
    destination: { type: 'gmail_draft' },
    seen: 1_240, acted: 61, held: 402, failed: 0, lastAt: '4 hours ago',
  },
  {
    id: 'r-gst-watch',
    kind: 'watch',
    name: 'GST acknowledgement, if it does not come',
    state: 'working',
    mailbox: 'rahul@emiactech.com',
    match: { from: 'donotreply@gst.gov.in', subjectContains: 'acknowledgement' },
    deadline: { by: 'the 11th, 18:00', repeats: 'every month' },
    action: { type: 'deliver' },
    destination: { type: 'lark_dm', value: 'Rahul Sharma' },
    seen: 7, acted: 1, held: 0, failed: 0, lastAt: 'checked 20 minutes ago',
  },
  {
    id: 'r-newsletters',
    kind: 'arrival',
    name: 'Newsletters out of the way',
    state: 'working',
    mailbox: 'rahul@emiactech.com',
    match: { subjectContains: '' },
    action: { type: 'organize', label: 'Reading' },
    destination: { type: 'none' },
    seen: 903, acted: 611, held: 0, failed: 0, lastAt: '31 minutes ago',
  },
  {
    id: 'r-legal',
    kind: 'arrival',
    name: 'Contracts → outside counsel',
    state: 'paused',
    mailbox: 'rahul@emiactech.com',
    match: { subjectContains: 'contract', hasAttachment: true },
    action: { type: 'forward' },
    destination: { type: 'email', value: 'counsel@bhatia-partners.in' },
    seen: 54, acted: 12, held: 0, failed: 1, lastAt: '6 days ago',
    external: true,
  },
]

/* ── Caught feed ─────────────────────────────────────── */
export type Caught = {
  id: string
  at: string
  fromName: string
  fromEmail: string
  subject: string
  snippet: string
  rule: string
  ruleId: string
  verdict?: { mode: BrainMode; label: string; tone: 'pass' | 'reject' | 'error'; reason: string; confidence?: number }
  outcome: { label: string; tone: 'ok' | 'held' | 'fail' | 'blocked' }
  threadId?: string
}

export const CAUGHT: Caught[] = [
  {
    id: 'c1', at: '09:14', fromName: 'Acme Billing', fromEmail: 'billing@acme-supplies.com',
    subject: 'Invoice #4471 — due 14 Aug',
    snippet: 'Please find attached the invoice for July services…',
    rule: 'Vendor invoices → Finance', ruleId: 'r-invoices',
    verdict: { mode: 'judge', label: 'Passed', tone: 'pass', confidence: 0.94, reason: 'A dated invoice with a total, an invoice number and a PDF attached. Addressed to EmiacTech, not a bulk send.' },
    outcome: { label: 'Forwarded to finance@emiactech.com', tone: 'ok' },
    threadId: 't-invoice-4471',
  },
  {
    id: 'c2', at: '08:44', fromName: 'Zoho Accounts', fromEmail: 'no-reply@accounts.zoho.com',
    subject: 'Your verification code is 448120',
    snippet: 'Use this code to finish signing in…',
    rule: 'Login codes → my Lark DM', ruleId: 'r-otp',
    verdict: { mode: 'extract', label: 'code · 448120', tone: 'pass', confidence: 0.99, reason: 'code=448120, service=Zoho Books, expiresIn=10 minutes.' },
    outcome: { label: 'Code sent to your Lark DM', tone: 'ok' },
    threadId: 't-otp',
  },
  {
    id: 'c3', at: '07:20', fromName: 'Ledgerly', fromEmail: 'growth@ledgerly.io',
    subject: 'Last chance: the 2026 FinOps benchmark webinar',
    snippet: 'Only 40 seats left — join 3,000 finance leaders…',
    rule: 'Vendor invoices → Finance', ruleId: 'r-invoices',
    verdict: { mode: 'judge', label: 'Rejected', tone: 'reject', confidence: 0.91, reason: 'A webinar promotion. No invoice number, no amount, and it carries an unsubscribe link — this is a bulk marketing send.' },
    outcome: { label: 'Held back, nothing forwarded', tone: 'held' },
    threadId: 't-webinar',
  },
  {
    id: 'c4', at: 'Yesterday, 22:06', fromName: 'Vertex Cloud', fromEmail: 'billing@vertexcloud.com',
    subject: 'Invoice VC-9920 for July',
    snippet: 'Your monthly statement is ready…',
    rule: 'Vendor invoices → Finance', ruleId: 'r-invoices',
    verdict: { mode: 'judge', label: 'Could not judge', tone: 'error', reason: 'The model did not answer in time. This rule fails open, so the mail was forwarded anyway.' },
    outcome: { label: 'Forwarded without a verdict', tone: 'ok' },
  },
  {
    id: 'c5', at: 'Yesterday, 18:40', fromName: 'Priya Nair', fromEmail: 'priya@quillsupply.in',
    subject: 'Invoice 118 — reminder',
    snippet: 'Following up on the invoice sent last week…',
    rule: 'Vendor invoices → Finance', ruleId: 'r-invoices',
    verdict: { mode: 'judge', label: 'Rejected', tone: 'reject', confidence: 0.72, reason: 'A chase for an invoice already sent, not the invoice itself. No attachment.' },
    outcome: { label: 'Held back, nothing forwarded', tone: 'held' },
  },
  {
    id: 'c6', at: 'Yesterday, 14:11', fromName: 'Stonepath Logistics', fromEmail: 'ap@stonepath.com',
    subject: 'Invoice SP-3311',
    snippet: 'Attached: freight for week 31…',
    rule: 'Vendor invoices → Finance', ruleId: 'r-invoices',
    verdict: { mode: 'judge', label: 'Passed', tone: 'pass', confidence: 0.88, reason: 'Freight invoice with a line-item breakdown and a due date.' },
    outcome: { label: 'Over the hourly ceiling — not sent', tone: 'blocked' },
  },
  {
    id: 'c-draft', at: '08:58', fromName: 'Nikhil Bose', fromEmail: 'nikhil@brightpath.in',
    subject: 'Order 44821 arrived damaged',
    snippet: 'The unit we received this morning has a cracked panel on the left side…',
    rule: 'Unhappy customers → a reply, ready to send', ruleId: 'r-complaints',
    verdict: { mode: 'judge', label: 'Passed', tone: 'pass', confidence: 0.96, reason: 'Customer describes physical damage to a delivered order and asks for a replacement.' },
    outcome: { label: 'Reply drafted — waiting in your Gmail drafts', tone: 'ok' },
  },
  {
    id: 'c-watch', at: 'Yesterday, 18:00', fromName: 'GST acknowledgement', fromEmail: 'expected from donotreply@gst.gov.in',
    subject: 'Nothing arrived by the 11th, 18:00',
    snippet: 'Divo watched for a filing acknowledgement all month and none came.',
    rule: 'GST acknowledgement, if it does not come', ruleId: 'r-gst-watch',
    outcome: { label: 'Told you in Lark that it is missing', tone: 'held' },
  },
  {
    id: 'c7', at: 'Yesterday, 11:02', fromName: 'Zoho Accounts', fromEmail: 'no-reply@accounts.zoho.com',
    subject: 'Your verification code is 771902',
    snippet: 'Use this code to finish signing in…',
    rule: 'Login codes → my Lark DM', ruleId: 'r-otp',
    verdict: { mode: 'extract', label: 'No code found', tone: 'error', reason: 'The mail was an alert about a failed sign-in, not a code. This rule fails closed, so nothing was sent.' },
    outcome: { label: 'Nothing sent', tone: 'fail' },
  },
]

/* ── Brief ──────────────────────────────────────────── */
export type BriefRow = { fromName: string; subject: string; want?: string; at: string; threadId?: string }

export const BRIEF = {
  sentAt: 'Today, 09:00',
  covers: 'since yesterday, 16:00',
  people: [
    { fromName: 'Meera Iyer', subject: 'Re: Renewal terms for the Q3 contract', want: 'Wants the revised cap confirmed in writing before Friday.', at: '08:02', threadId: 't-renewal' },
    { fromName: 'Aleem Khan', subject: 'Payroll run needs your sign-off before 18:00', want: 'Needs your sign-off on August payroll today.', at: 'Yesterday, 15:02', threadId: 't-payroll' },
  ] as BriefRow[],
  waiting: [
    { fromName: 'Sana Qureshi', subject: 'Re: Vendor onboarding for Stonepath', want: 'You replied 4 days ago and nobody has come back.', at: 'Mon' },
  ] as BriefRow[],
  handled: [
    { rule: 'Vendor invoices → Finance', acted: 3, held: 2 },
    { rule: 'Login codes → my Lark DM', acted: 1, held: 0 },
    { rule: 'Newsletters out of the way', acted: 11, held: 0 },
  ],
  notifications: 6,
  newsletters: 9,
}

export const CADENCE = [
  { id: 'twice', label: 'Twice a day', detail: '09:00 and 16:00, workdays', recommended: true },
  { id: 'once', label: 'Once a day', detail: '09:00, workdays' },
  { id: 'four', label: 'Every 4 hours', detail: 'Six a day. For support and ops rotas.' },
  { id: 'off', label: 'Off', detail: 'No brief. Rules keep running.' },
]

/* ── Admin: what is under the packaging ──────────────── */
export const ADMIN_ROWS = [
  { name: 'Rahul Sharma', dept: 'Finance', rules: 5, external: 1, aiRules: 3, spend: 214, state: 'ok' as const },
  { name: 'Aleem Khan', dept: 'Customer Service', rules: 3, external: 0, aiRules: 2, spend: 168, state: 'ok' as const },
  { name: 'Sana Qureshi', dept: 'Operations', rules: 2, external: 0, aiRules: 0, spend: 0, state: 'ok' as const },
  { name: 'Dev Menon', dept: 'Sales', rules: 4, external: 2, aiRules: 1, spend: 402, state: 'watch' as const },
  { name: 'Nikita Rao', dept: 'Finance', rules: 1, external: 0, aiRules: 1, spend: 61, state: 'ok' as const },
  { name: 'Imran Sheikh', dept: 'Operations', rules: 0, external: 0, aiRules: 0, spend: 0, state: 'none' as const },
]

/* ── The AI sidebar's script ──────────────────────────
   Canned, and honest about being canned. Each turn names the nodes it changes
   so the chain and the transcript never disagree. */
export type AiTurn = {
  /** What the member says — a chip, or typed. */
  ask: string
  /** What Divo replies, in order. */
  say: string[]
  /** Which nodes light up as changed. */
  touches: ('trigger' | 'match' | 'brain' | 'action' | 'destination')[]
  /** The patch applied to the draft rule. */
  patch: Partial<Rule>
}

export const AI_SCRIPT: AiTurn[] = [
  {
    ask: 'Forward vendor invoices to the finance team',
    say: [
      'Set up. It watches your Gmail for mail with “invoice” in the subject that carries an attachment, and forwards the whole message to finance@emiactech.com.',
      'One thing I have not added: a lot of what says “invoice” is marketing. Ask me to filter it and I will put an AI step in the middle.',
    ],
    touches: ['trigger', 'match', 'action', 'destination'],
    patch: {
      name: 'Vendor invoices → Finance',
      match: { subjectContains: 'invoice', hasAttachment: true },
      action: { type: 'forward' },
      destination: { type: 'email', value: 'finance@emiactech.com' },
    },
  },
  {
    ask: 'Skip anything that looks like marketing',
    say: [
      'Added an AI step between the match and the forward. It reads each matched message and answers one question: is this a real invoice addressed to us?',
      'Roughly ₹0.04 a message. On your last 30 days that is 134 messages — about ₹5.40 a month — and it would have held back 38 of them.',
    ],
    touches: ['brain'],
    patch: {
      brain: {
        mode: 'judge',
        prompt: 'Is this a real invoice addressed to us, rather than marketing, a quote, or a payment reminder for something already paid?',
        onReject: 'stop',
        failure: 'open',
        costPerMessage: 0.04,
        monthlyCeiling: 400,
      },
    },
  },
  {
    ask: 'Only during working hours',
    say: ['Narrowed it to Monday–Friday, 09:00 to 19:00, Asia/Kolkata. Mail outside that window is left alone rather than queued.'],
    touches: ['match'],
    patch: {
      match: {
        subjectContains: 'invoice',
        hasAttachment: true,
        window: { days: 'Mon–Fri', start: '09:00', end: '19:00', timeZone: 'Asia/Kolkata' },
      },
    },
  },
  {
    ask: 'Never from no-reply addresses',
    say: ['Added an exception. Anything from an address starting `no-reply@` is skipped before the AI step runs, so it costs nothing.'],
    touches: ['match'],
    patch: {
      match: {
        subjectContains: 'invoice',
        hasAttachment: true,
        notFrom: 'no-reply@',
        window: { days: 'Mon–Fri', start: '09:00', end: '19:00', timeZone: 'Asia/Kolkata' },
      },
    },
  },
  {
    ask: 'Draft a reply instead of forwarding',
    say: [
      'Changed the action. Divo now writes a reply and leaves it in your Gmail drafts — it never sends. You open Gmail, read it, change what you want, press send yourself.',
      'Drafting costs more than judging: about ₹0.11 a message, because it writes rather than answers. The recipient is fixed to whoever wrote to you — I cannot address a draft to anybody else.',
    ],
    touches: ['action', 'destination'],
    patch: {
      action: {
        type: 'draft',
        instruction: 'Acknowledge the specific problem in their own words, say what happens next, and give a date.',
        costPerMessage: 0.11,
      },
      destination: { type: 'gmail_draft' },
    },
  },
  {
    ask: 'Cap it at 20 an hour',
    say: [
      'Done. Past 20 in an hour Divo stops forwarding and records what it dropped — it does not queue them.',
      'You will see anything it dropped in Caught, marked “over the ceiling”.',
    ],
    touches: ['action'],
    patch: { action: { type: 'forward', rateLimitPerHour: 20 } },
  },
]
