/**
 * Four runs, playing beside the signup questions.
 *
 * Somebody filling in an email has nothing to look at and no reason yet to
 * believe the thing they are signing up for. The left half of the modal is that
 * reason: Divo actually working, with the part nobody advertises put first.
 *
 * The part nobody advertises is what happens when Divo *cannot* do something.
 * Every agent demo shows the happy path, so the happy path proves nothing — of
 * course it worked, it was chosen. What a buyer cannot tell from a demo is
 * whether the thing will quietly email a customer, or read a payroll ledger the
 * person asking has no business seeing. So three of these four runs stop, and
 * each stops for a different reason.
 *
 * The four outcomes are not invented for the reel. They are the four cases in
 * `domain/approval/gate-forecast.ts`, which is the rule the runtime actually
 * executes: it runs, you confirm, your approver confirms, or it is blocked
 * because the tool was never yours. If that rule changes, this reel is wrong
 * and should be changed with it.
 *
 * These are illustrations, not recordings. The names are invented and the view
 * labels the panel as an example, because a mock dressed as somebody's real
 * data is a lie told to a person who has not signed up yet.
 */
import type { ToolKey } from '@/pages/workspace/chat/tools'

/**
 * What became of one step.
 *
 * `denied` and `held` both stop the run and are deliberately distinct. Held
 * means Divo can do this and is waiting to be told yes. Denied means the tool
 * is not in this person's hands at all, so there is nothing to say yes to —
 * and a reader who cannot tell those apart will read every refusal as a bug.
 */
export type StepTone = 'ran' | 'held' | 'denied'

export type Step = {
  readonly tool: ToolKey
  readonly text: string
  readonly tone: StepTone
  /** Why it stopped, in the words the product would use. Only on a stop. */
  readonly note?: string
}

export type Run = {
  readonly id: string
  /** Whose seat this is. RBAC is meaningless without somebody to apply it to. */
  readonly who: string
  readonly ask: string
  readonly steps: readonly Step[]
  readonly outcome: string
  /** The one sentence this run exists to prove. */
  readonly lesson: string
}

export const RUNS: readonly Run[] = [
  {
    id: 'runs',
    who: 'Priya · Finance',
    ask: 'Pull last month’s invoices into a sheet',
    steps: [
      { tool: 'zohoBooks', text: 'Read 128 invoices from March', tone: 'ran' },
      { tool: 'sheets', text: 'Wrote 128 rows to “Q1 invoices”', tone: 'ran' },
    ],
    outcome: 'Done in 14 seconds.',
    lesson: 'Looking something up never stops to ask. Divo just does it.',
  },
  {
    id: 'you',
    who: 'Priya · Finance',
    ask: 'Clear the duplicate events off my calendar',
    steps: [
      { tool: 'calendar', text: 'Found 3 duplicates this week', tone: 'ran' },
      {
        tool: 'calendar',
        text: 'Delete 3 events',
        tone: 'held',
        note: 'You asked to be checked with before Divo deletes anything.',
      },
    ],
    outcome: 'Waiting for you.',
    lesson: 'You pick which actions stop for you. Per app, per verb, in one screen.',
  },
  {
    id: 'approver',
    who: 'Arjun · Sales',
    ask: 'Send the renewal quote to Northwind',
    steps: [
      { tool: 'drive', text: 'Opened “Northwind renewal.pdf”', tone: 'ran' },
      { tool: 'gmail', text: 'Draft ready, 1 attachment', tone: 'ran' },
      {
        tool: 'gmail',
        text: 'Send to procurement@northwind.co',
        tone: 'held',
        note: 'Sales gates outgoing mail. Meera is asked before it leaves.',
      },
    ],
    outcome: 'Waiting for Meera.',
    lesson: 'Your team decides what needs a second pair of eyes before it leaves the building.',
  },
  {
    id: 'blocked',
    who: 'Sam · Support',
    ask: 'Pull the payroll ledger and email it to me',
    steps: [
      {
        tool: 'zohoBooks',
        text: 'Read the payroll ledger',
        tone: 'denied',
        note: 'Support has no Zoho Books. Divo cannot see it, so it cannot leak it.',
      },
    ],
    outcome: 'Nothing read. Nothing sent.',
    lesson: 'A tool your role does not have is a tool Divo does not have.',
  },
]

/** How long a finished run sits before the next one starts, in ticks. */
const HOLD = 4

/** Ticks one run occupies: one per step revealed, plus the hold. */
export function runLength(run: Run): number {
  return run.steps.length + HOLD
}

export const REEL_LENGTH = RUNS.reduce((total, run) => total + runLength(run), 0)

export type Frame = {
  /** Index into `RUNS`. */
  readonly run: number
  /** How many of that run's steps are showing. */
  readonly steps: number
}

/**
 * Where the reel is, `tick` ticks after it started.
 *
 * Total, and it wraps: there is no end state to get stuck in and no separate
 * "restart" path to get wrong. A caller can hand it any tick, including one
 * from a timer that kept running while the tab was hidden.
 */
export function frameAt(tick: number): Frame {
  if (!Number.isFinite(tick) || tick < 0) return { run: 0, steps: 0 }
  let left = Math.floor(tick) % REEL_LENGTH
  for (let run = 0; run < RUNS.length; run += 1) {
    const length = runLength(RUNS[run] as Run)
    if (left < length) {
      return { run, steps: Math.min(left + 1, (RUNS[run] as Run).steps.length) }
    }
    left -= length
  }
  return { run: 0, steps: 0 }
}

/** The tick a run starts on, so picking one by hand can jump straight to it. */
export function tickOf(index: number): number {
  let tick = 0
  for (let run = 0; run < index && run < RUNS.length; run += 1) {
    tick += runLength(RUNS[run] as Run)
  }
  return tick
}

/** Whether this run ends in a stop, and therefore in which kind of badge. */
export function stopOf(run: Run): StepTone | null {
  const last = run.steps[run.steps.length - 1]
  return last && last.tone !== 'ran' ? last.tone : null
}
