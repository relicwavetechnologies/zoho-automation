/**
 * "Ask me before Divo does this" — the reader's own gate, chosen per action.
 *
 * It began as one boolean, and one boolean was the wrong shape. Switching it on
 * stopped every non-read action, so the honest choice on offer was between
 * being interrupted by nothing and being interrupted by everything. Nobody
 * wants either. What people actually want is a short list: check with me before
 * you send mail or move money, and get on with the rest.
 *
 * So the personal gate is a selection, the same shape as the department policy
 * that sits beside it. Two owners, one shape: a manager writes what the team
 * must show them, a person writes what they want shown to themselves.
 *
 * `all` is a real mode rather than sugar for "tick everything". A list built by
 * enumerating today's tools would quietly fail to cover the tool added next
 * week, which is the opposite of what somebody asking for everything meant.
 *
 * Pure. Every function here is total: a stored value written by an older
 * version, or by hand, reads as the nearest valid gate rather than throwing.
 */

export interface PersonalGateEntry {
  readonly toolId: string;
  readonly actions: readonly string[];
}

export interface PersonalGate {
  /** Confirm every non-read action, including on tools that do not exist yet. */
  readonly all: boolean;
  readonly actions: readonly PersonalGateEntry[];
}

/** Nobody has chosen anything. The state everyone starts in. */
export const NO_PERSONAL_GATE: PersonalGate = { all: false, actions: [] };

/**
 * Does this person want to be asked before this particular call runs?
 *
 * The one predicate. The runtime asks it to decide whether to raise a
 * confirmation, the forecast asks it to decide what to print on a row, and
 * because it is the same call both times the page cannot promise a stop the
 * runtime will not make.
 */
export function personallyGated(
  gate: PersonalGate | null | undefined,
  toolId: string,
  action: string,
): boolean {
  if (!gate || action === 'read') return false;
  if (gate.all) return true;
  return gate.actions.some((entry) => entry.toolId === toolId && entry.actions.includes(action));
}

/** How many actions are named. `all` is not a count, so it is not counted here. */
export function personalGateSize(gate: PersonalGate): number {
  return gate.actions.reduce((total, entry) => total + entry.actions.length, 0);
}

/**
 * Build a gate from loose pairs: merged per tool, deduplicated, reads dropped.
 *
 * Both ways in go through here — parsing what the database holds and
 * normalising what a person just saved — so a gate can only ever exist in one
 * arrangement. Without that, `{gmail: [send]}` and `{gmail: [send, send]}` are
 * different values meaning the same thing, and every comparison downstream has
 * to know it.
 *
 * Reads are dropped rather than rejected. Reading is never gated by anybody, so
 * storing one would render as a tick that does nothing, which is worse than
 * having no tick at all.
 */
export function personalGateFrom(
  all: boolean,
  pairs: Iterable<readonly [toolId: string, action: string]>,
): PersonalGate {
  const byTool = new Map<string, Set<string>>();
  for (const [toolId, action] of pairs) {
    const tool = toolId.trim();
    const verb = action.trim();
    if (!tool || !verb || verb === 'read') continue;
    const existing = byTool.get(tool);
    if (existing) existing.add(verb);
    else byTool.set(tool, new Set([verb]));
  }
  return {
    all,
    /* Sorted so two gates holding the same choices are the same value, which
       makes them comparable and makes a stored gate diffable by eye. */
    actions: [...byTool.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([toolId, actions]) => ({ toolId, actions: [...actions].sort() })),
  };
}

/** What a caller just sent, reduced to the one valid arrangement of itself. */
export function normalisePersonalGate(gate: PersonalGate): PersonalGate {
  return personalGateFrom(gate.all, pairsOf(gate.actions));
}

/** Whatever the database holds, read as a gate. Never throws. */
export function parsePersonalGate(value: unknown): PersonalGate {
  if (!isRecord(value)) return NO_PERSONAL_GATE;
  const raw = Array.isArray(value['actions']) ? value['actions'] : [];
  const pairs: [string, string][] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const toolId = entry['toolId'];
    const actions = entry['actions'];
    if (typeof toolId !== 'string' || !Array.isArray(actions)) continue;
    for (const action of actions) {
      if (typeof action === 'string') pairs.push([toolId, action]);
    }
  }
  return personalGateFrom(value['all'] === true, pairs);
}

/** Flip one action, returning the gate that results. */
export function togglePersonalAction(
  gate: PersonalGate,
  toolId: string,
  action: string,
): PersonalGate {
  const already = gate.actions.some((e) => e.toolId === toolId && e.actions.includes(action));
  const kept = [...pairsOf(gate.actions)].filter(
    ([tool, verb]) => !(tool === toolId && verb === action),
  );
  return personalGateFrom(gate.all, already ? kept : [...kept, [toolId, action]]);
}

function* pairsOf(
  entries: readonly PersonalGateEntry[],
): Generator<readonly [string, string]> {
  for (const entry of entries) {
    for (const action of entry.actions) yield [entry.toolId, action] as const;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
