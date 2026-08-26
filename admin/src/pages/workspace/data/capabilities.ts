/**
 * What the member may reach on the web, as action groups per capability.
 *
 * From GET /api/desktop/auth/me `capabilities`. Null when Divo could not work
 * them out — the shell then shows everything and lets each route answer for
 * itself, since hiding a tab somebody actually holds is the more expensive
 * mistake.
 */

export type Capabilities = Record<string, readonly string[]> | null

/**
 * The three states, and why an absent key is not the same as an empty one.
 *
 * A present array is an answer: `['read','send']` is a grant, `[]` is a
 * refusal. Null, and a key that is simply not there, are both "no answer" —
 * and both resolve to *show it*.
 *
 * That is not symmetry for its own sake. A gated surface added to the shell
 * before the server learns to report on it would send an empty key, and every
 * tab it names would silently vanish for everybody who does hold it — with
 * nothing on screen to discover, because the whole failure is an absence.
 * Offering a tab somebody may not use costs them one readable refusal instead.
 */
const answerFor = (
  capabilities: Capabilities,
  capability: string,
): readonly string[] | null => {
  if (capabilities === null) return null
  const actions = capabilities[capability]
  return Array.isArray(actions) ? actions : null
}

/** Whether the member holds `action` on `capability`. No answer shows it. */
export function holds(
  capabilities: Capabilities,
  capability: string,
  action: string,
): boolean {
  const answer = answerFor(capabilities, capability)
  return answer === null ? true : answer.includes(action)
}

/**
 * Whether the member holds *any* action on `capability`.
 *
 * What the shell's Watching group asks: an empty array means the tab is not
 * offered at all.
 */
export function hasCapability(
  capabilities: Capabilities,
  capability: string,
): boolean {
  const answer = answerFor(capabilities, capability)
  return answer === null ? true : answer.length > 0
}
