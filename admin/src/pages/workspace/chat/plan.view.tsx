/**
 * The plan, as a panel beside the conversation.
 *
 * Everything a run does already appears in the work log, in the order it
 * happened. This is the other question — *how far through is it* — and that one
 * cannot be answered by a list that only grows. The log is a history; this is a
 * shape, declared up front and ticked off.
 *
 * So it does not live in the thread. A thread scrolls, and a progress display
 * that scrolls out of view is a progress display you have to go looking for. It
 * is pinned at the top-right of the conversation, over it rather than in it,
 * and it comes and goes with the run — see `plan.ts` for why a checklist is a
 * live thing and never part of the record.
 *
 * Three states, three readings, and the distinction is the whole design:
 *
 *   done    — struck through and dimmed. Deliberately still legible: the plan is
 *             what was promised, and a finished step that disappears takes the
 *             promise with it.
 *   active  — the one step being worked on, boxed and lit. Exactly one can exist
 *             because `plan.ts` decides that, not this file.
 *   pending — a dashed ring and nothing else. Not yet a fact.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Minus, Plus, X } from 'lucide-react'
import type { Plan, PlanStep } from './plan'
import { fitsBesideThread, planStatus } from './plan'
import '@/styles/beautiful.css'

/**
 * How much of the plan is behind us, drawn as a ring.
 *
 * A ring rather than the reference's spinner, and it is a deliberate departure:
 * a spinner says "something is happening", which the boxed active step below it
 * already says, and says better because it names what. The ring answers the
 * question the panel exists for — how far through — at a glance and without
 * reading a word.
 *
 * A failed step is counted as resolved but never as done, so the ring stops
 * short of full on a run that lost a step. It closing all the way is a claim
 * that the plan was carried out.
 */
function PlanRing({ plan }: { plan: Plan }) {
  const fraction = plan.total === 0 ? 0 : plan.done / plan.total
  /* r=7 in a 18px box: circumference 43.98, so the dash array is the whole
     circle and the offset is what is left to do. */
  const circumference = 2 * Math.PI * 7

  return (
    <svg viewBox="0 0 18 18" aria-hidden className="size-[18px] shrink-0 -rotate-90">
      <circle cx="9" cy="9" r="7" fill="none" stroke="var(--bui-line-strong)" strokeWidth="2" />
      <circle
        cx="9" cy="9" r="7" fill="none"
        stroke="var(--bui-ink)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
        /* Transitioned, not animated: the value only moves when a step actually
           settles, and easing it there is what makes the panel feel like it is
           tracking the work rather than redrawing. */
        style={{ transition: 'stroke-dashoffset 420ms cubic-bezier(0.23,1,0.32,1)' }}
      />
    </svg>
  )
}

/** The mark at the head of a step, which is the step's whole state. */
function StepMark({ step }: { step: PlanStep }) {
  if (step.active) return <span className="bui-spinner" />

  if (step.state === 'done' || step.state === 'skipped') {
    return (
      <span
        className={`grid size-[18px] shrink-0 place-content-center rounded-full ${
          /* A skipped step is settled but was never carried out, so it gets the
             ring and not the tick. Ticking it would be the panel claiming work
             that nobody did. */
          step.state === 'done' ? 'bg-line-strong' : 'border border-line-strong'
        }`}
      >
        {step.state === 'done' && <Check size={11} strokeWidth={3} className="text-ink" />}
      </span>
    )
  }

  if (step.state === 'failed') {
    return (
      <span className="grid size-[18px] shrink-0 place-content-center rounded-full bg-rose-500/15">
        <X size={11} strokeWidth={3} className="text-rose-600 dark:text-rose-400" />
      </span>
    )
  }

  /* Pending, and on a settled run also a step marked running that never
     finished — both are "this did not happen", and a dashed ring is the only
     mark that says so without claiming it went wrong. */
  return <span className="size-[18px] shrink-0 rounded-full border border-dashed border-line-strong" />
}

function StepRow({ step }: { step: PlanStep }) {
  const settled = step.state === 'done' || step.state === 'skipped'

  return (
    <li
      className={`flex items-start gap-2.5 rounded-control transition-[background-color,box-shadow] duration-300 ${
        /* The active step is boxed, and that is the panel's one piece of
           emphasis. Everything else is a row of text; this is a thing being
           worked on. */
        step.active ? 'bg-fill px-2.5 py-2 shadow-hairline' : 'px-2.5 py-1.5'
      }`}
    >
      <StepMark step={step} />
      <span
        className={`min-w-0 flex-1 text-[13px] leading-snug ${
          step.active
            ? 'bui-shimmer'
            : settled
              ? 'bui-strike text-ink-3'
              : step.state === 'failed'
                ? 'text-ink-2'
                : 'text-ink-3'
        }`}
      >
        {step.title}
      </span>
    </li>
  )
}

/**
 * The panel itself.
 *
 * Collapsible, and it earns the control: this floats over the conversation, and
 * a twelve-step plan on a narrow window covers what the reader came to read.
 * Collapsed it keeps the ring and the count, which is the part you want at a
 * glance anyway.
 *
 * Nothing here decides *whether* to draw — the caller passes a plan or does
 * not. A panel that could render itself empty is a panel that will.
 */
export function PlanPanel({ plan }: { plan: Plan }) {
  const [open, setOpen] = useState(true)
  const frame = useRef<HTMLElement | null>(null)

  /* A new run reopens it — if there is room. Collapsing is a judgement about the
     plan in front of you, so carrying a manual one into the next run would mean
     a reader who tidied one plan away never sees another.

     The room test is what stops this covering the conversation. The thread is a
     720px column in the middle of the pane, so the panel only clears it when the
     gutter either side is wider than the panel and its margin; below that it
     sits over the text. Rather than overlap, it opens collapsed — the ring and
     the count still say how far through the run is, in the width of a word, and
     the reader can open it if they want the steps.

     Measured off the pane rather than the window, because the rail beside it
     takes a couple of hundred pixels and a window that looks wide enough often
     is not. Read once per plan, not on every resize: an observer here would
     fight the reader's own toggle every time they dragged the window. */
  useEffect(() => {
    const pane = frame.current?.parentElement?.clientWidth ?? 0
    // Nothing measured yet means nothing to be cautious about — open.
    setOpen(pane === 0 || fitsBesideThread(pane))
  }, [plan.total])

  return (
    <aside
      ref={frame}
      /* Positioned against the chat pane, under the header bar. `absolute`
         rather than `fixed` so it belongs to the conversation and cannot end up
         floating over the rail or another screen. */
      className="pointer-events-none absolute right-4 top-[52px] z-20 flex w-[264px] max-w-[calc(100%-2rem)] justify-end"
      style={{ animation: 'bui-fade-up 320ms cubic-bezier(0.23,1,0.32,1) both' }}
    >
      <div className="pointer-events-auto w-full overflow-hidden rounded-card bg-surface shadow-overlay">
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <PlanRing plan={plan} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
            {planStatus(plan)}
          </span>
          <button
            type="button"
            onClick={() => setOpen(current => !current)}
            aria-label={open ? 'Collapse the plan' : 'Expand the plan'}
            className="grid size-6 shrink-0 place-content-center rounded-control text-ink-3 transition-colors duration-150 hover:bg-fill hover:text-ink"
          >
            {open ? <Minus size={13} strokeWidth={2.5} /> : <Plus size={13} strokeWidth={2.5} />}
          </button>
        </div>

        {open && (
          /* Capped and scrollable. Twelve steps is the tool's own limit and
             twelve rows is taller than most of the answers this sits beside. */
          <ul className="flex max-h-[46vh] flex-col gap-1 overflow-y-auto px-1.5 pb-2.5">
            {plan.steps.map((step, index) => (
              /* Keyed by position, which is genuinely this list's identity: the
                 checklist is replaced whole on every call and its order is the
                 plan. Keying on the title would rebuild a row — and replay its
                 strike-through — the moment the model reworded a step. */
              <StepRow key={index} step={step} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}
