/**
 * A step that farmed its work out, drawn as the agents doing it — ported from
 * the desktop's `SubagentRunCard`.
 *
 * The rule the rest of the log follows still holds: expanded while it is
 * happening, quiet once it is not. What is different is what "expanded" shows.
 * Every other row's detail is a result; this row's detail is a list of *other
 * runs*, each with its own name, its own job and its own clock, and all of them
 * changing while you watch. So it is the one place in the log that draws a
 * multi-line row.
 *
 * Deliberately unboxed. It sits between plain tool rows, and a bordered card
 * there reads as a different kind of object — the agents are just a nested list
 * of the same running steps.
 */
import { Bot } from 'lucide-react'
import { DotsLoader } from './loader'
import { agentRunStatus, type Agent, type AgentRun } from './agents'

/**
 * A per-agent identity mark.
 *
 * Four agents is four rows of near-identical grey text, and the only thing
 * telling "scout" from "scribe" is the word itself — so finding one again means
 * re-reading every row. A small coloured glyph gives each a shape you can find
 * without reading.
 *
 * DERIVED, never assigned: the same role always hashes to the same shape and
 * hue, across runs and across sessions. That stability is the whole point — a
 * mark that shuffled per render would be decoration rather than identity. Two
 * agents genuinely sharing a role share a mark, which is correct: they are the
 * same kind of worker.
 *
 * Abstract on purpose. A literal icon per role needs a taxonomy of roles nobody
 * maintains, and is wrong the moment someone spawns an agent we have no art for.
 */
function hash(value: string): number {
  // FNV-1a. Small, dependency-free, and well spread for short strings — "scout"
  // and "scribe" must not collide onto one mark for sharing a prefix.
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/* Hues that stay legible on both themes at 14px, stay separable from each
   other, and stay out of the log's existing colour vocabulary — where red
   already means failure. Written as raw oklch rather than palette tokens: these
   are identity, not meaning, and a token would invite someone to reuse one and
   accidentally give it a job. */
const HUES = [8, 300, 250, 155, 70, 330]

/* Dot clusters on a 24×24 grid. Distinct in silhouette, not just in hue — a
   plain circle beside a plain hexagon says nothing, and leaves colour carrying
   the whole distinction. Keep new shapes on this spacing: packed tighter they
   close into a blob at render size, which is what makes a mark look cheap. */
const SHAPES: string[][] = [
  ['8,8', '16,8', '8,16', '16,16'],                          // Clover
  ['12,6', '7,17', '17,17'],                                 // Triad
  ['12,5', '5,12', '19,12', '12,19', '12,12'],               // Compass
  ['12,5', '18,8.5', '18,15.5', '12,19', '6,15.5', '6,8.5'], // Hex ring
  ['7,7', '12,12', '17,17', '17,7'],                         // Diagonal pair
  ['12,6', '12,12', '12,18', '18,12'],                       // Column plus satellite
]

function AgentMark({ seed, dim }: { seed: string; dim: boolean }) {
  const h = hash(seed.trim().toLowerCase() || 'agent')
  const dots = SHAPES[h % SHAPES.length]!
  // Off a different slice of the hash than the shape, so shape and colour vary
  // independently instead of moving in lockstep.
  const hue = HUES[(h >>> 8) % HUES.length]!

  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={`size-3.5 shrink-0 ${dim ? 'opacity-70' : ''}`}
      style={{ fill: `oklch(0.68 0.15 ${hue})` }}
    >
      {dots.map(dot => {
        const [cx, cy] = dot.split(',')
        return <circle key={dot} cx={cx} cy={cy} r="3.1" />
      })}
    </svg>
  )
}

/**
 * The settled state, as a dot.
 *
 * A check on every finished agent made success the loudest thing in the card —
 * four ticks shouting about work nobody doubted, drowning the one row that
 * needed attention. Completion is the expected outcome, so it earns a quiet
 * neutral dot; only failure keeps a colour, and it then reads as the single
 * exception rather than as one tick among four.
 */
function StateDot({ failed }: { failed: boolean }) {
  return (
    <span
      aria-hidden
      className="size-1.5 shrink-0 rounded-full"
      style={{ background: failed ? 'var(--bui-red)' : 'var(--bui-ink-3)' }}
    />
  )
}

/**
 * One agent: a glyph, its role, and what it is doing underneath.
 *
 * The mark sits beside the ROLE rather than in the status slot on the left,
 * because that slot belongs to the run's state and has to stay free for the
 * loader while the agent works. Identity and progress are two different
 * questions, so they answer from two different places.
 */
function AgentRow({ agent }: { agent: Agent }) {
  const working = agent.state === 'working'

  return (
    <div className="flex items-start gap-2.5 rounded-control px-1 py-1.5 text-left">
      {/* A fixed line box so the glyph centres on the row's FIRST line rather
          than on the whole two-line block. Both branches share it, so settling
          never nudges the text sideways or down. */}
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        {working
          ? <DotsLoader variant="scatter" className="text-ink-2" />
          : <StateDot failed={agent.state === 'failed'} />}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <AgentMark seed={agent.role} dim={!working} />
          <span className={`truncate text-[13px] capitalize ${working ? 'text-ink' : 'text-ink-2'}`}>
            {agent.role}
          </span>
          {/* The clock, beside the name and a weight down. Only while the agent
              is going: a finished agent's duration is a number nobody asked
              for, and the run's own header already reports the turn. */}
          {agent.elapsed && (
            <span className="shrink-0 font-mono text-[11px] text-ink-3 tabular-nums">
              {agent.elapsed}
            </span>
          )}
        </span>

        {/* The task, verbatim and never title-cased — it is the instruction the
            run wrote, and tidying it corrupts what it says.

            Not shimmered, though the desktop shimmers the line in this slot.
            The desktop's line is a live activity label that genuinely changes;
            ours is the fixed instruction the agent was given, and shimmering
            text that will read the same in a minute claims a liveness it does
            not have. The dots already say the agent is working, and four
            shimmering lines under four loaders is motion competing with
            itself. */}
        {agent.task && (
          <span className="mt-0.5 block truncate text-[12px] text-ink-3">{agent.task}</span>
        )}
      </span>
    </div>
  )
}

export function AgentRunView({ run }: { run: AgentRun }) {
  return (
    <section className="flex flex-col">
      <div className="flex items-center gap-2.5 py-0.5 text-[13px] text-ink-2">
        {run.running
          ? <DotsLoader variant="scatter" className="text-ink-2" />
          : <Bot size={14} strokeWidth={1.5} className="mx-[3px] shrink-0 text-ink-3" />}
        <span className={`shrink-0 ${run.running ? 'bui-shimmer' : ''}`}>
          {run.running ? 'Running' : 'Ran'} subagents
        </span>
        <span className="min-w-0 truncate text-ink-3">{agentRunStatus(run)}</span>
      </div>

      <div className="mt-0.5 flex flex-col pl-[7px]">
        {run.agents.map((agent, index) => (
          /* Keyed by role and position together. Role alone is not unique — two
             workers of the same kind is the ordinary case, and the fan-out this
             card exists to show is usually four of them. */
          <AgentRow key={`${agent.role}:${index}`} agent={agent} />
        ))}
        {run.agents.length === 0 && (
          <p className="px-1 py-1.5 text-[12px] text-ink-3">Preparing subagents…</p>
        )}
      </div>
    </section>
  )
}
