/**
 * Automations — Divo's scheduled workflows.
 *
 * THE ROWS HERE ARE INVENTED. Read this before trusting anything on the screen.
 *
 * The domain is real and complete. `ScheduledWorkflow`, `ScheduledWorkflowRun`
 * and `ScheduledWorkflowMessage` are Prisma models, and
 * `ScheduledWorkflowControlService` is described in its own comment as the
 * "single write/read authority" for them, with create / list / pause / resume /
 * cancel / runNow already written and already used.
 *
 * What does not exist is any way to reach it from a browser. There is no HTTP
 * route for scheduled workflows anywhere in `src/http` — the service is wired
 * only to the agent's tool surface, so today an automation is created by asking
 * Divo in chat or in Lark and by no other means. Worse for a web client:
 * `create()` refuses any channel that is not `desktop` or `lark`, so even a
 * route added tomorrow has to decide what a browser counts as.
 *
 * So these types mirror the backend field for field, and the data behind them
 * is fabricated. When the routes land this file loses its fixtures and keeps
 * its shape.
 */
import { useEffect, useState } from 'react'

/** `ScheduledWorkflowStatus` — prisma/schema.prisma */
export type AutomationStatus =
  | 'draft' | 'published' | 'active' | 'scheduled_active' | 'paused' | 'archived'

/** `ScheduledWorkflowScheduleType` */
export type ScheduleType = 'one_time' | 'hourly' | 'daily' | 'weekly' | 'monthly'

/** `ScheduledWorkflowRunStatus` */
export type AutomationRunStatus =
  | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'blocked'

export type AutomationRun = {
  id: string
  status: AutomationRunStatus
  scheduledFor: string
  startedAt: string | null
  finishedAt: string | null
  /** Links a run to the trace under /ai-ops/runs/:id when one was produced. */
  executionRunId: string | null
  attemptNumber: number
  resultSummary: string | null
  errorSummary: string | null
}

export type Automation = {
  id: string
  name: string
  status: AutomationStatus
  /** What the person asked for, in their words. The body of the page. */
  userIntent: string
  /** What the backend compiled that into, and what actually runs. */
  compiledPrompt: string | null
  scheduleType: ScheduleType
  scheduleEnabled: boolean
  timezone: string
  nextRunAt: string | null
  lastRunAt: string | null
  createdByName: string
  departmentName: string | null
  updatedAt: string
  /** `capabilitySummaryJson` — which tools this workflow was compiled against. */
  capabilities: string[]
  /**
   * Every scheduled result is delivered to the creator's Lark DM. Not a
   * setting: `ScheduleCreateInput.delivery` is documented as "accepted and
   * ignored", so the rail states it rather than offering a choice.
   */
  delivery: 'creator_lark_dm'
  runs: AutomationRun[]
}

export const SCHEDULE_LABEL: Record<ScheduleType, string> = {
  one_time: 'Once',
  hourly: 'Every hour',
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
}

export const STATUS_LABEL: Record<AutomationStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  active: 'Active',
  scheduled_active: 'Scheduled',
  paused: 'Paused',
  archived: 'Archived',
}

const iso = (offsetMinutes: number) => new Date(Date.now() + offsetMinutes * 60_000).toISOString()

const FIXTURES: Automation[] = [
  {
    id: 'wf-morning-invoices',
    name: 'Morning invoice sweep',
    status: 'scheduled_active',
    userIntent:
      'Every weekday at 8am, check Zoho Books for invoices that went overdue yesterday, and send me a short list with the customer, the amount and how many days late it is.',
    compiledPrompt:
      'Read overdue invoices from Zoho Books for the previous business day. Group by customer. Report customer, amount outstanding and days overdue, sorted by days overdue descending. Do not send anything to customers.',
    scheduleType: 'daily',
    scheduleEnabled: true,
    timezone: 'Asia/Kolkata',
    nextRunAt: iso(60 * 14),
    lastRunAt: iso(-60 * 10),
    createdByName: 'Abhishek Verma',
    departmentName: 'Finance',
    updatedAt: iso(-60 * 26),
    capabilities: ['zohoBooks.read'],
    delivery: 'creator_lark_dm',
    runs: [
      { id: 'r1', status: 'succeeded', scheduledFor: iso(-60 * 10), startedAt: iso(-60 * 10), finishedAt: iso(-60 * 10 + 2), executionRunId: 'exec-8821', attemptNumber: 1, resultSummary: '6 overdue invoices, ₹4.2L outstanding', errorSummary: null },
      { id: 'r2', status: 'succeeded', scheduledFor: iso(-60 * 34), startedAt: iso(-60 * 34), finishedAt: iso(-60 * 34 + 3), executionRunId: 'exec-8790', attemptNumber: 1, resultSummary: '5 overdue invoices, ₹3.8L outstanding', errorSummary: null },
      { id: 'r3', status: 'failed', scheduledFor: iso(-60 * 58), startedAt: iso(-60 * 58), finishedAt: iso(-60 * 58 + 1), executionRunId: 'exec-8744', attemptNumber: 2, resultSummary: null, errorSummary: 'Zoho connection needed re-authorising' },
    ],
  },
  {
    id: 'wf-weekly-seo',
    name: 'Weekly SEO movers',
    status: 'paused',
    userIntent:
      'Every Monday morning, pull the keywords that moved more than five positions in either direction last week and tell me which pages they belong to.',
    compiledPrompt:
      'Query Semrush for ranking changes over the previous 7 days. Filter to absolute position change greater than 5. Join each keyword to its landing page. Report gains and losses separately.',
    scheduleType: 'weekly',
    scheduleEnabled: false,
    timezone: 'Asia/Kolkata',
    nextRunAt: null,
    lastRunAt: iso(-60 * 24 * 9),
    createdByName: 'Abhishek Verma',
    departmentName: 'Growth',
    updatedAt: iso(-60 * 24 * 8),
    capabilities: ['semrush.read', 'webSearch.read'],
    delivery: 'creator_lark_dm',
    runs: [
      { id: 'r4', status: 'succeeded', scheduledFor: iso(-60 * 24 * 9), startedAt: iso(-60 * 24 * 9), finishedAt: iso(-60 * 24 * 9 + 4), executionRunId: 'exec-8501', attemptNumber: 1, resultSummary: '14 movers — 9 up, 5 down', errorSummary: null },
    ],
  },
  {
    id: 'wf-standup',
    name: 'Standup digest',
    status: 'draft',
    userIntent:
      'Each morning before standup, summarise what changed in my Lark tasks and which meetings I have, so I can read it in one go.',
    compiledPrompt: null,
    scheduleType: 'daily',
    scheduleEnabled: false,
    timezone: 'Asia/Kolkata',
    nextRunAt: null,
    lastRunAt: null,
    createdByName: 'Abhishek Verma',
    departmentName: null,
    updatedAt: iso(-60 * 3),
    capabilities: [],
    delivery: 'creator_lark_dm',
    runs: [],
  },
]

/** Mirrors the shape a real query would have, so the swap is a swap. */
export function useAutomations() {
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setLoading(false), 320)
    return () => clearTimeout(t)
  }, [])
  return { automations: FIXTURES, loading }
}

export function useAutomation(id: string | undefined) {
  const { automations, loading } = useAutomations()
  return { automation: automations.find((a) => a.id === id) ?? null, loading }
}
