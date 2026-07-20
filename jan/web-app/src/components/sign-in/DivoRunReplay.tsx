import { motion, useReducedMotion } from 'framer-motion'
import { useEffect, useState } from 'react'

import { PiTraceTimeline } from '@/components/pi/PiTraceTimeline'
import type { PiTraceStep } from '@/lib/pi/split-trace-parts'

/**
 * A recorded Divo run, replayed through the REAL work log.
 *
 * The previous panel hand-drew miniatures of the timeline. That kept the gate
 * isolated from the chat, but it also meant the sign-in screen showed a drawing
 * of the product that drifted a little further from the truth with every change
 * to the real thing. This renders the actual `PiTraceTimeline`, so tool
 * coalescing, icon resolution, burst summaries and thought rows are not
 * imitated — they are the same code paths the app runs.
 *
 * THE CONSTRAINT THAT STILL HOLDS: the gate renders before any session exists,
 * so nothing here may touch a store, the gateway, or Tauri. That is affordable
 * only because the trace components are pure — `PiTraceTimeline`, `CommandGroup`
 * and `SubagentRunCard` take props and import no store. The steps below are a
 * static fixture, never a fetch.
 *
 * The trade this makes, knowingly: the sign-in screen is now coupled to the
 * chat's rendering. A breaking change to `PiTraceStep` or the tool-part shape
 * will surface here, which is why this file carries its own test.
 */

/** Beat duration. Slow enough to read a row, brisk enough to feel like work. */
const BEAT_MS = 1150
/** How long the finished run rests before starting over. */
const HOLD_MS = 3600

/**
 * Builds a gateway tool part in the exact shape the real chat emits, so
 * `resolveToolIdentity` resolves a brand mark and a readable label rather than
 * falling back to the raw tool name.
 */
function gatewayCall(
  partIndex: number,
  toolId: string,
  nativeTool: string
): PiTraceStep {
  return {
    kind: 'tool',
    partIndex,
    part: {
      type: 'tool-divo_gateway',
      toolCallId: `replay-${partIndex}`,
      state: 'output-available',
      input: {
        op: 'tools.invoke',
        payload: { toolId, args: { op: 'describe', nativeTool } },
      },
    },
  }
}

/**
 * One errand, told end to end.
 *
 * Deliberately spans three vendors: a single-tool run would look like a
 * shortcut, and the whole argument for an agent is that it crosses systems
 * nobody has wired together. Tool ids are the real canonical ones, so the
 * marks and labels here match what the app shows for the same call.
 */
export const REPLAY_QUESTION = 'Which invoices are overdue, and who do I chase?'

export const REPLAY_STEPS: PiTraceStep[] = [
  {
    kind: 'thought',
    partIndex: 0,
    text: 'Checking billing first, then matching each overdue account to an owner I can contact.',
  },
  gatewayCall(1, 'zohoBooks', 'list_invoices'),
  {
    kind: 'narration',
    partIndex: 2,
    text: 'Three invoices are past due — ₹4.2L across two accounts.',
  },
  gatewayCall(3, 'googleContacts', 'search_contacts'),
  {
    kind: 'narration',
    partIndex: 4,
    text: 'Both owners are in your contacts. Drafting a follow-up to each.',
  },
  gatewayCall(5, 'googleGmail', 'create_draft'),
]

export function DivoRunReplay() {
  const reduceMotion = useReducedMotion()
  // Counts steps revealed so far. The run accumulates rather than swapping,
  // which is what makes it read as one task instead of a carousel.
  const [visible, setVisible] = useState(reduceMotion ? REPLAY_STEPS.length : 0)

  useEffect(() => {
    // Reduced motion gets the finished state outright: the information is the
    // point, the animation is the garnish.
    if (reduceMotion) {
      setVisible(REPLAY_STEPS.length)
      return
    }

    const done = visible >= REPLAY_STEPS.length
    const timer = setTimeout(
      () => setVisible(done ? 0 : visible + 1),
      done ? HOLD_MS : BEAT_MS
    )
    return () => clearTimeout(timer)
  }, [visible, reduceMotion])

  const steps = REPLAY_STEPS.slice(0, visible)
  // Held streaming for the whole loop, including the rest at the end.
  // PiTraceTimeline folds a settled run down to a single "Worked for 6s" line
  // — correct in the app, where the work log is scaffolding you collapse once
  // you have the answer, but self-defeating on a panel whose entire job is to
  // show the tools. The replay never claims to be finished, so it never folds.
  const isStreaming = visible > 0

  return (
    <div className="flex w-full max-w-md flex-col gap-4">
      {/* Pinned request, then the log beneath it — the same direction as the
          real chat. */}
      <div className="flex justify-end">
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="max-w-[88%] rounded-2xl rounded-br-md bg-white/10 px-3.5 py-2 text-[13px] leading-snug text-white/85"
        >
          {REPLAY_QUESTION}
        </motion.div>
      </div>

      {/* Fixed height so the panel never reflows as rows land — a jumping card
          under a settling headline looks broken, not alive. */}
      <div className="min-h-[188px]">
        <PiTraceTimeline
          messageId="divo-sign-in-replay"
          steps={steps}
          isStreaming={isStreaming}
          awaitingApproval={false}
          // The gate shows the shape of the work, not its payloads: expanded
          // tool bodies would need output fixtures that add nothing here and
          // would be the first thing to rot.
          renderTool={() => null}
          renderNarration={(text) => (
            <span className="text-[13px] leading-relaxed">{text}</span>
          )}
        />
      </div>
    </div>
  )
}
