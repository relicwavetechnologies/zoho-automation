/**
 * "Ask me before Divo does this" — the reader's own picks, per action.
 *
 * Mirrors `advance-backend/src/domain/approval/personal-gate.ts`, the same
 * arrangement as `Decision` and as `forecast.ts` beside this file: two trees
 * that do not share types, kept honest by a backend test that walks both the
 * forecast and the live gating rule through the same cases.
 *
 * It replaced a single boolean. One boolean only ever offered a choice between
 * being interrupted by nothing and being interrupted by everything, so the
 * realistic setting was off, and the feature may as well not have existed.
 */

export type PersonalGateEntry = { toolId: string; actions: string[] }

export type PersonalGate = {
  /** Confirm every non-read action, including on tools that do not exist yet. */
  all: boolean
  actions: PersonalGateEntry[]
}

export const NO_PERSONAL_GATE: PersonalGate = { all: false, actions: [] }

export function personallyGated(
  gate: PersonalGate | null | undefined,
  toolId: string,
  action: string,
): boolean {
  if (!gate || action === 'read') return false
  if (gate.all) return true
  return gate.actions.some((entry) => entry.toolId === toolId && entry.actions.includes(action))
}

/** How many actions are named. `all` is a mode, not a count, so it is not one. */
export function personalGateSize(gate: PersonalGate): number {
  return gate.actions.reduce((total, entry) => total + entry.actions.length, 0)
}

/** Merged per tool, deduplicated, reads dropped, sorted. The one arrangement. */
export function personalGateFrom(all: boolean, pairs: Iterable<[string, string]>): PersonalGate {
  const byTool = new Map<string, Set<string>>()
  for (const [toolId, action] of pairs) {
    if (!toolId || !action || action === 'read') continue
    const existing = byTool.get(toolId)
    if (existing) existing.add(action)
    else byTool.set(toolId, new Set([action]))
  }
  return {
    all,
    actions: [...byTool.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([toolId, actions]) => ({ toolId, actions: [...actions].sort() })),
  }
}

/** Flip one action, returning the gate that results. Never touches `all`. */
export function togglePersonalAction(
  gate: PersonalGate,
  toolId: string,
  action: string,
): PersonalGate {
  const already = personallyPicked(gate, toolId, action)
  const pairs = gate.actions.flatMap(
    (entry) => entry.actions.map((verb) => [entry.toolId, verb] as [string, string]),
  )
  const kept = pairs.filter(([tool, verb]) => !(tool === toolId && verb === action))
  return personalGateFrom(gate.all, already ? kept : [...kept, [toolId, action]])
}

/**
 * Whether this exact action is named in the list.
 *
 * Distinct from `personallyGated`, which is also true for every action while
 * `all` is on. A tick box has to reflect the list it writes to, or turning off
 * "everything" would appear to un-tick rows nobody touched.
 */
export function personallyPicked(gate: PersonalGate, toolId: string, action: string): boolean {
  return gate.actions.some((entry) => entry.toolId === toolId && entry.actions.includes(action))
}
