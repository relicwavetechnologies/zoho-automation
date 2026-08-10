/**
 * Where an authored agent lives — for now, in this browser.
 *
 * NOTHING HERE IS REAL. There is no agent-definition table in the backend, no
 * route that serves one, and no runtime that reads one. This store exists so the
 * screens can be *used* rather than described: you can create an agent, give it
 * tools, write its instructions, and see the map redraw around it. Reload and it
 * is still there, because it is in localStorage — which is exactly as durable as
 * this idea currently is.
 *
 * It is deliberately shaped like the table we would have to add. When the
 * backend catches up, this file is replaced by fetch calls and every screen
 * above it keeps working.
 *
 * ONE TOOL, ONE AGENT. An agent owns its tools exclusively. That is the whole
 * reason a tool picker can say "these are still free" — without exclusivity two
 * agents could both claim Gmail, and a request mentioning mail would have no
 * single answer to "who runs this". The orchestrator routes by tool, so the
 * tool has to point at exactly one agent.
 */
import { useSyncExternalStore } from 'react'

export type ContainerMode = 'dedicated' | 'shared' | 'ephemeral'
export type MemoryScope = 'agent' | 'user' | 'department' | 'company'

export type AgentDefinition = {
  id: string
  name: string
  /** Only meaningful for authored agents; a family agent's tools are derived. */
  toolIds: string[]
  systemPrompt: string
  modelId: string
  container: { mode: ContainerMode; cpu: number; memoryMb: number; idleStopMinutes: number }
  memory: { scope: MemoryScope; retentionDays: number | null; learning: boolean }
}

/** Family agents are addressed by their family; authored ones get an id. */
export const familyAgentId = (family: string) => `family:${family}`
export const isAuthored = (agentId: string) => agentId.startsWith('agent:')

const KEY = 'divo.admin.agentDrafts.v1'

type State = Record<string, AgentDefinition>

let state: State = load()
const listeners = new Set<() => void>()

function load(): State {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as State) : {}
  } catch {
    // A corrupt draft is not worth crashing a page over — start clean.
    return {}
  }
}

function commit(next: State) {
  state = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private mode, quota — the UI still works */ }
  listeners.forEach((fn) => fn())
}

const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

/** Every stored definition — authored agents plus edited family agents. */
export function useAgentDrafts(): State {
  return useSyncExternalStore(subscribe, () => state, () => state)
}

/** Just the ones an admin created, in creation order. */
export function useAuthoredAgents(): AgentDefinition[] {
  const all = useAgentDrafts()
  return Object.values(all).filter((a) => isAuthored(a.id))
}

export function saveAgent(agent: AgentDefinition) {
  commit({ ...state, [agent.id]: agent })
}

export function deleteAgent(id: string) {
  const next = { ...state }
  delete next[id]
  commit(next)
}

export const getAgent = (id: string): AgentDefinition | null => state[id] ?? null

/**
 * A new id.
 *
 * `crypto.randomUUID` is not available on http origins in every browser, so a
 * timestamp-and-random fallback keeps the mock usable over plain localhost.
 */
export function newAgentId(): string {
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  return `agent:${uuid}`
}

/** What a brand-new agent starts as — the real per-user container's shape. */
export const blankAgent = (): AgentDefinition => ({
  id: newAgentId(),
  name: '',
  toolIds: [],
  systemPrompt: '',
  modelId: 'deepseek-chat',
  container: { mode: 'dedicated', cpu: 2, memoryMb: 2048, idleStopMinutes: 45 },
  memory: { scope: 'agent', retentionDays: 90, learning: true },
})
