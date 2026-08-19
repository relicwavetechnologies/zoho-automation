/**
 * A step that farmed its work out to other agents, read as what it is.
 *
 * `divo_subagents` is the one tool whose interesting content is *underneath* it.
 * Every other row in the log answers "what did Divo do" in its own label; this
 * one answers "who is doing it, and how far along are they", and the answer is
 * a list that changes while you watch.
 *
 * It used to be drawn as an ordinary tool row with its children flattened into
 * the generic detail list every step has — which threw the state away (four
 * agents, all just text), threw the task away (the renderer only drew a
 * child's label), and left the row captioned "Thinking" because that is what
 * the fallback tool mark is called. Four identical grey words under a chevron.
 *
 * So the run's own shape gets its own reading, here, in a module with no view
 * in it. What it produces is what the desktop's subagent card draws.
 */
import type { LedgerChild, LedgerRow } from './stream'

/** The tool that spawns agents. There is exactly one, and this is its name. */
const AGENTS_TOOL = 'divo_subagents'

export type AgentState = 'working' | 'done' | 'failed'

/** One agent, as much as crosses the wire about it. */
export type Agent = {
  /** Its role, which is its name on screen. */
  role: string
  /** What it was asked to do. */
  task?: string
  /** How long it has been going. Only while it is going. */
  elapsed?: string
  state: AgentState
}

export type AgentRun = {
  /** The run has agents still working. */
  running: boolean
  agents: Agent[]
  /**
   * How many finished the work, out of how many there are.
   *
   * Finished, not settled: an agent that failed has stopped, and counting it as
   * complete produces "3/3 complete · 1 failed" — a header that contradicts
   * itself inside one sentence.
   */
  done: number
  total: number
  /** How many are still going. */
  active: number
  failed: number
}

/**
 * Is this row the one that farms work out?
 *
 * Either question answers it, and both are asked. The name is the reliable one
 * on a live run; children are the reliable one on a record, because `toolName`
 * is newer than the ledger and a conversation from before it exists still has
 * its agents sitting right there in the row. Nothing else has ever put children
 * on a row — it is the agent tool's own detail shape — so a row with them is
 * this row whatever it says it is called.
 */
export function isAgentRow(row: LedgerRow): boolean {
  return row.toolName === AGENTS_TOOL || (row.children?.length ?? 0) > 0
}

/**
 * A child's state, narrowed to the three a reader acts on.
 *
 * `pending` and `running` are the same news — it has not finished — and the
 * card says so once, with a loader. `skipped` is what a cancelled agent
 * arrives as, and a cancelled agent did not do its work, so it reads as the
 * exception rather than as a quiet success.
 */
function stateOf(status: LedgerChild['status']): AgentState {
  if (status === 'failed' || status === 'skipped') return 'failed'
  if (status === 'done') return 'done'
  return 'working'
}

/**
 * The agents under one row.
 *
 * The parent's own status is not consulted. A parent marked done with a child
 * still marked running is a frame that genuinely happens — the container
 * settles the children on the way out, and the two facts can arrive in either
 * order — and taking the parent's word for it would show a finished card above
 * a row still claiming to work. Counting the children is the same question
 * asked of the things that actually know.
 */
export function agentRunOf(row: LedgerRow): AgentRun {
  const agents = (row.children ?? []).map((child): Agent => ({
    role: child.label,
    ...(child.outcome ? { task: child.outcome } : {}),
    ...(child.elapsed ? { elapsed: child.elapsed } : {}),
    state: stateOf(child.status),
  }))

  const active = agents.filter(a => a.state === 'working').length
  const failed = agents.filter(a => a.state === 'failed').length

  return {
    /* A row whose children have not arrived yet is still starting them, so it
       is working — otherwise the card would render "Ran subagents · 0/0" for
       the second before the first frame lands, which is the one moment it is
       most obviously wrong. */
    running: active > 0 || agents.length === 0,
    agents,
    done: agents.filter(a => a.state === 'done').length,
    total: agents.length,
    active,
    failed,
  }
}

/**
 * What the header says beside the title.
 *
 * A fraction while there is one to give, and nothing at all before the agents
 * exist — "0/0 complete" is a sentence about nothing.
 */
export function agentRunStatus(run: AgentRun): string {
  if (run.total === 0) return 'Starting'
  const fraction = `${run.done}/${run.total} complete`
  if (run.active > 0) return `${fraction} · ${run.active} active`
  if (run.failed > 0) return `${fraction} · ${run.failed} failed`
  return fraction
}
