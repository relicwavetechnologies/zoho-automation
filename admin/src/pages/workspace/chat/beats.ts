/**
 * A run, in the vocabulary the surface draws.
 *
 * `live.ts` builds these from the neutral timeline the backend sends, and every
 * component below reads them and nothing else. The shape follows the run
 * lifecycle rather than what is convenient to render: a step opens and settles,
 * a call that farms work out reports the agents doing it, the model thinks and
 * talks on the way, and the reply is the thing it landed on.
 *
 * This file used to be called `transcripts.ts`, and it opened by declaring
 * itself "the mock — and the ONLY mock", holding three hand-written runs that
 * `/chat` replayed on a timer because there was no backend to ask. The backend
 * arrived, `live.ts` produced this same shape from a real stream, and the three
 * scripts stopped being played by anything — but they stayed, and everything
 * they alone exercised stayed with them. The vocabulary is the part that was
 * load-bearing, so it is the part that is still here.
 */
import type { ToolKey } from './tools'
import type { AgentRun } from './agents'

/**
 * Which beat this is, for as long as the run remembers it.
 *
 * Carried from the ledger row it was built from, so a beat keeps one identity
 * across every snapshot of a run. Position cannot do this job: a snapshot can
 * insert a beat above another — a sentence being reclassified does exactly that
 * — and a renderer keyed on position then rebuilds every row below the change,
 * replaying arrival animations on rows that never moved.
 */
type Identified = { id?: string }

export type Beat =
  /** A tool call, expanded while it runs and folded to `done` once it settles. */
  | (Identified & {
      t: 'step'
      tool: ToolKey
      title: string
      /** The mono chip beside the title — the actual query, file, or target. */
      chip?: string
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
    })
  /**
   * A step that farmed its work out to other agents.
   *
   * Its own variant rather than a `step` with children, because the two are
   * read differently: a step folds to one sentence about what it produced, and
   * this one has no single sentence — it is several runs happening at once, and
   * the list IS the content. Flattened into a step's generic detail lines it
   * lost every agent's state, task and clock, and the row was captioned by the
   * fallback tool mark.
   */
  | (Identified & { t: 'agents'; run: AgentRun })
  /**
   * Prose the model wrote.
   *
   * `narration` marks the kind that arrived *during* the work — an aside, not
   * a reply — which the thread files inside the work log rather than printing
   * beside the answer. Without the mark the two are indistinguishable by the
   * time they reach a component, and the surface prints the run's thinking-out-
   * loud and its conclusion at identical weight, one after the other.
   */
  | (Identified & { t: 'say'; text: string; narration?: boolean })
  /**
   * The model reasoning to itself, not addressing anyone.
   *
   * Its own kind rather than another flag on `say`, because the two are read
   * differently: a thought folds to the single word "Thought" and a sentence
   * does not, and one of them never leaves the container's own surface.
   */
  | (Identified & { t: 'think'; text: string; running?: boolean })
