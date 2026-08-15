/**
 * The checklist the model committed to, read as a plan.
 *
 * `divo_todos` is a declaration made for the person watching: the steps a long
 * request was broken into, and which one is in progress. It has been crossing
 * the wire since the tool existed — the reducer keeps it as `declared`, the Lark
 * card folds it under the status — and this surface has been receiving it and
 * drawing nothing. The whole of the live plan arrived in `Timeline` and stopped
 * at the type.
 *
 * Two rules the tool itself sets, which everything here follows:
 *
 *   - The list is replaced whole on every call. There is no add or complete, so
 *     there are no ids to keep and no merge to get wrong. What arrives is the
 *     plan; the previous one is gone.
 *   - It dies with the run. It grants nothing, stores nothing, and is not
 *     persisted with the conversation — `ThreadRunRecord` carries a ledger and
 *     no plan, on purpose. So this is a live reading, and a settled thread
 *     having no plan to show is correct rather than missing.
 *
 * No view in here. What it produces is what the plan panel draws.
 */
import type { Timeline } from './stream'

/**
 * A step's state, in the wire's own words.
 *
 * Deliberately not narrowed the way `agents.ts` narrows its five to three. An
 * agent is a worker and a reader only wants to know if it is still going; a plan
 * step is a *commitment*, and "did not happen" and "went wrong" are different
 * news about a commitment. Collapsing them would let a run that quietly dropped
 * half its plan look like a run that finished it.
 *
 * `failed` is not something `divo_todos` can produce — its own vocabulary is
 * pending/running/done/skipped — but the wire's status type is wider, and a
 * status this module cannot name is worse than one it can.
 */
export type PlanStepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export type PlanStep = {
  title: string
  state: PlanStepState
  /**
   * This is the step being worked on *right now*.
   *
   * Not the same question as `state === 'running'`, and the difference is the
   * whole reason it is decided here rather than in the panel. A run that was
   * stopped — or that dropped its connection — leaves a step marked running
   * forever, and a panel keying its loader off the state alone spins on a step
   * nothing is doing. One place decides what is live, so one loader can exist.
   */
  active: boolean
}

export type Plan = {
  steps: PlanStep[]
  /**
   * Steps that will not move again, out of how many were committed to.
   *
   * Counts `skipped` alongside `done`, which is the opposite of what `agents.ts`
   * does with a cancelled agent — and the difference is real. A cancelled agent
   * did not do its work, so counting it as complete produces a header that
   * contradicts itself. A skipped step is the model saying this turned out not
   * to be needed, which is a step of the plan disposed of. It is progress.
   */
  done: number
  total: number
  /** Index of the step being worked on, or null when none is. */
  current: number | null
  /** How many went wrong. Drawn apart from the count, never folded into it. */
  failed: number
  /** The run is over. Nothing in here will move again. */
  settled: boolean
}

const SETTLED_STATES: ReadonlySet<PlanStepState> = new Set(['done', 'skipped'])

/**
 * The plan for a run, or nothing.
 *
 * Nothing is the common case and the correct one: most asks are a single lookup
 * and the tool's own guidance is that a checklist for those "looks worse with
 * one". A panel that appears for every message would be furniture.
 *
 * `running` comes from the run, not from the timeline. The timeline is a
 * snapshot of what was true when it was sent, and the last one sent before a run
 * ends still has a step marked running in it — that is not a live step, it is
 * the last thing that was true.
 *
 * The counts are derived here rather than read from `declared.done` /
 * `declared.total`, which arrive on the same value. Two counts of one list is a
 * count that can disagree with the list drawn beside it, and a ring reading 4/5
 * above five ticked rows is the kind of wrong a reader notices immediately.
 */
export function planOf(timeline: Timeline | null | undefined, running: boolean): Plan | null {
  const items = timeline?.declared?.items
  if (!items?.length) return null

  /* At most one step is live, and it is the last one claiming to be.
     `divo_todos` already demotes earlier ones for exactly this reason, so this
     agrees with the tool rather than second-guessing it — and holds the line if
     a plan ever reaches this surface from somewhere that does not. */
  const lastRunning = items.map(item => item.status).lastIndexOf('running')

  const steps = items.map((item, index): PlanStep => ({
    title: item.title,
    state: item.status,
    active: !running ? false : index === lastRunning,
  }))

  return {
    steps,
    done: steps.filter(step => SETTLED_STATES.has(step.state)).length,
    total: steps.length,
    current: !running || lastRunning === -1 ? null : lastRunning,
    failed: steps.filter(step => step.state === 'failed').length,
    settled: !running,
  }
}

/**
 * What the panel says above the list.
 *
 * What is *left*, not what is done — the plan is the one place in a run where
 * that is answerable at all, because the model said up front how many steps
 * there would be. Everywhere else the total is unknowable mid-run, which is why
 * the work log counts actions and never offers a fraction.
 *
 * Counting down rather than up is the reference's own framing and it is the
 * right one: the reader is waiting, and "2 steps left" answers what they are
 * waiting for. "3/5" makes them do the subtraction.
 */
export function planStatus(plan: Plan): string {
  /* A failed step is resolved — nothing is going to come back to it — so it is
     out of the count rather than sitting in it forever as work still to do. It
     is reported separately instead, because a plan that lost a step is not the
     same news as a plan still working through one. */
  const left = plan.total - plan.done - plan.failed

  if (!plan.settled) {
    /* Every step settled and the run still open: the model finished the plan
       and is writing the answer. Not "Done" — saying that through the part the
       reader is actually waiting for is the panel lying at the one moment they
       are looking at it. */
    const base = left === 0 ? 'Finishing up' : `${left} step${left === 1 ? '' : 's'} left`
    return plan.failed > 0 ? `${base} · ${plan.failed} failed` : base
  }

  if (plan.failed > 0) return `${plan.failed} of ${plan.total} failed`
  /* Settled with steps still outstanding — stopped, or the connection dropped.
     Naming it beats leaving "2 steps left" above a plan nothing is working on. */
  return left === 0 ? 'Done' : `Stopped · ${left} left`
}

/**
 * Does the panel clear the conversation, in a pane this wide?
 *
 * The numbers mirror `screens-chat.tsx`: the thread is a 720px column centred in
 * the pane, with 20px of padding inside it — so the text stops 340px from the
 * centre, not 360. That padding is the whole reason this is a function rather
 * than a subtraction written inline; measuring to the column's edge instead of
 * its text collapses the panel on windows where it visibly fits fine.
 *
 * Duplicated rather than measured because the column is not this component's to
 * reach into, and a wrong answer costs a panel that opens collapsed — not a
 * broken layout.
 */
const THREAD_HALF = 720 / 2 - 20
const PANEL_WIDTH = 264
/** `right-4`. */
const PANEL_OFFSET = 16
/** Below this the two read as touching, which is what started all this. */
const MIN_GAP = 24

export function fitsBesideThread(paneWidth: number): boolean {
  return paneWidth / 2 - THREAD_HALF - PANEL_OFFSET - PANEL_WIDTH >= MIN_GAP
}

