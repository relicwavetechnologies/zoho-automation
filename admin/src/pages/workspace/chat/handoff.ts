/**
 * A message begun on Home and finished in the thread.
 *
 * Home has the same composer `/chat` has, on purpose: the box you type into
 * must not change shape between asking and watching, or the navigation reads as
 * landing on a different product rather than the same sentence carrying on. So
 * whatever was typed — and now whatever was attached — has to survive one route
 * change.
 *
 * Two stores, and which one is used is decided by whether there are files.
 *
 * Words go through session storage, which survives a reload. A prompt is cheap
 * to restore and expensive to retype, so keeping it is right.
 *
 * A `File` cannot go through session storage at all — it is a handle to bytes
 * the page is holding, and there is nothing to serialize. It travels in memory
 * instead, which a client-side route change preserves and a reload does not. So
 * when there are files, the words travel with them in memory and *nothing* is
 * stored: after a reload the composer is empty and the person retypes. That is
 * the point. The alternative — words stored, files not — restores the message
 * with its attachments quietly missing, and sends it that way.
 */

const KEY = 'divo.chat.pendingPrompt'

export type Handoff = { prompt: string; files: readonly File[] }

const EMPTY: Handoff = { prompt: '', files: [] }

/** Set only while files are in flight; see the note above. */
let carried: Handoff | null = null

/** Hand a message to the thread screen. */
export function stageHandoff(prompt: string, files: readonly File[] = []): void {
  clearHandoff()
  if (files.length > 0) {
    carried = { prompt, files }
    return
  }
  try {
    window.sessionStorage.setItem(KEY, prompt)
  } catch { /* private mode — the prompt does not survive, and nothing else breaks */ }
}

/**
 * Read what Home staged, without consuming it.
 *
 * Reading and clearing in one step looked tidier and silently lost the handoff:
 * StrictMode mounts a component, unmounts it, and mounts it again, so the first
 * mount took the value and the second — the one that survives — found nothing
 * and rendered a blank composer. The clear happens at the only moment that
 * proves the message arrived somewhere, which is when the run starts.
 */
export function peekHandoff(): Handoff {
  if (carried) return carried
  try {
    const prompt = window.sessionStorage.getItem(KEY) ?? ''
    return prompt ? { prompt, files: [] } : EMPTY
  } catch {
    return EMPTY
  }
}

export function clearHandoff(): void {
  carried = null
  try {
    window.sessionStorage.removeItem(KEY)
  } catch { /* private mode — nothing was stored to begin with */ }
}
