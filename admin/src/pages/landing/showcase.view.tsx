/**
 * Divo working, beside the questions.
 *
 * A work log the way the chat draws one: the ask at the top, a tool mark per
 * step, and a plain sentence saying what that step did. The steps arrive one at
 * a time, because a list that is simply *there* reads as a screenshot and a
 * list that fills in reads as a thing that is running.
 *
 * Three of the four runs stop, and the panel does not apologise for that. The
 * stop is the feature.
 *
 * Nothing here is anybody's data — the header says so in as many words. A mock
 * dressed as a real workspace is a lie told to somebody who has not signed up
 * yet, and this panel's entire job is to be believed.
 */
import { useEffect, useState } from 'react'
import { Check, Lock, PauseCircle } from 'lucide-react'
import { ToolMark } from '@/pages/workspace/chat/tools'
import { tintFor } from '@/pages/workspace/chat/mentions'
import { RUNS, frameAt, stopOf, tickOf, type Step, type StepTone } from './showcase'

/** One step per second, which is about the pace of reading one. */
const TICK_MS = 1100

/**
 * A beat before the first step lands.
 *
 * The modal opens because somebody pressed send, and the first thing they
 * should read is the question being asked of them — not a log already halfway
 * through. Two seconds is long enough for the eye to reach the right-hand side
 * and come back, and short enough that the panel does not look broken.
 */
const WAKE_MS = 2000

export function Showcase() {
  const [tick, setTick] = useState(0)
  /* Nothing has run yet. The ask is on screen, waiting, like any run does for
     its first moment. */
  const [live, setLive] = useState(false)
  const still = usePrefersStill()

  useEffect(() => {
    const wake = window.setTimeout(() => setLive(true), WAKE_MS)
    return () => window.clearTimeout(wake)
  }, [])

  /*
   * Picking a run seeks to it and the reel keeps playing.
   *
   * It used to stop instead, on the reasoning that somebody who picked a run
   * wants to read it. That was wrong in the worst way: a seek lands on the
   * run's *first* frame, so stopping the clock froze it at one step and the
   * reader never saw the thing they had just asked to see. A run plays out in a
   * few seconds and then holds; that is the read window.
   */
  useEffect(() => {
    if (still || !live) return
    const timer = window.setInterval(() => setTick((t) => t + 1), TICK_MS)
    return () => window.clearInterval(timer)
  }, [still, live])

  const frame = frameAt(tick)
  const run = RUNS[frame.run]!
  /* Motion off means the whole run at once, immediately. The point is what Divo
     does, and that is legible without anything moving or waiting. */
  const shown = still ? run.steps.length : live ? frame.steps : 0
  const settled = shown >= run.steps.length && (still || live)
  const stop = stopOf(run)

  return (
    <aside className="lp-show" aria-label="How Divo works">
      <header className="lp-show-top">
        <span className="lp-show-tag">Example runs</span>
        <p>The same question, asked by three different people. Divo answers to whoever is asking.</p>
      </header>

      <div className="lp-show-body">
        <div className="lp-run" key={run.id}>
          <div className="lp-run-who">{run.who}</div>
          <p className="lp-run-ask">{run.ask}</p>

          <ol className="lp-run-log">
            {run.steps.slice(0, shown).map((step, index) => (
              <StepRow key={index} step={step} />
            ))}
          </ol>

          {/* Held back until the log has finished, so the verdict never
              arrives before the work it is a verdict on. */}
          <div className="lp-run-end" data-on={settled ? 'true' : undefined}>
            <span className="lp-run-outcome" data-tone={stop ?? 'ran'}>
              <OutcomeIcon tone={stop ?? 'ran'} />
              {run.outcome}
            </span>
            <p className="lp-run-lesson">{run.lesson}</p>
          </div>
        </div>
      </div>

      <nav className="lp-show-nav" aria-label="Pick a run">
        {RUNS.map((candidate, index) => (
          <button
            key={candidate.id}
            type="button"
            className="lp-show-dot"
            data-on={index === frame.run ? 'true' : undefined}
            aria-label={candidate.ask}
            aria-current={index === frame.run}
            onClick={() => { setLive(true); setTick(tickOf(index)) }}
          />
        ))}
      </nav>
    </aside>
  )
}

function StepRow({ step }: { step: Step }) {
  const tint = tintFor(step.tool)
  return (
    <li className="lp-step" data-tone={step.tone}>
      <span
        className="lp-step-mark"
        /* The tool's own colour behind its own mark, the same tint the composer
           puts behind a mention of it. One vocabulary, two places. */
        style={tint ? { ['--lp-tint' as string]: tint } : undefined}
      >
        <ToolMark name={step.tool} size={13} />
      </span>
      <span className="lp-step-text">
        {step.text}
        {step.note ? <em>{step.note}</em> : null}
      </span>
      <StepBadge tone={step.tone} />
    </li>
  )
}

function StepBadge({ tone }: { tone: StepTone }) {
  if (tone === 'ran') return <span className="lp-step-badge" data-tone="ran"><Check size={11} /></span>
  if (tone === 'held') {
    return <span className="lp-step-badge" data-tone="held">Waiting</span>
  }
  return <span className="lp-step-badge" data-tone="denied">No access</span>
}

function OutcomeIcon({ tone }: { tone: StepTone }) {
  if (tone === 'held') return <PauseCircle size={13} />
  if (tone === 'denied') return <Lock size={13} />
  return <Check size={13} />
}

/**
 * Whether this reader has asked for less movement.
 *
 * Read live rather than once, because it is a setting somebody can change while
 * the page is open — and the one reader who does that mid-session is exactly the
 * reader who wants it honoured immediately.
 */
function usePrefersStill(): boolean {
  const [still, setStill] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  )
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    const onChange = (): void => setStill(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return still
}
