/**
 * The panel beside the conversation, and what is open in it.
 *
 * Two stores, kept apart on purpose, exactly as the desktop app keeps them:
 *
 * **The shell** knows whether the panel is open and how wide it is. It knows
 * nothing about documents. **The tabs** know what is open. Neither knows how any
 * of it is drawn.
 *
 * That split is what lets a second kind of thing — a side chat, a browser, a
 * dataset — arrive as a new tab kind and a renderer, with nothing here changing.
 * The moment this file contains `if (kind === 'artifact')`, the seam has been
 * lost and the panel has become a document viewer with extra steps.
 *
 * Module-level rather than React state, because the panel outlives the component
 * that opened it: a reader switching threads and coming back should find their
 * document where they left it, and a document that arrives while the chat is
 * re-rendering must not be dropped.
 */
import { useSyncExternalStore } from 'react'

/**
 * What a document is assumed to be when nothing said.
 *
 * Only a fallback identity, not a claim about what can be drawn — `formats.tsx`
 * owns that, and a tab's `mime` is deliberately not narrowed to any union. The
 * store may hold a type a newer runtime filed and this build has no renderer
 * for, and the honest way to show that is the document's own source with a note
 * saying so — not to drop it.
 */
export const DEFAULT_MIME = 'text/markdown'

/** One thing open in the panel. Every kind carries these. */
type TabBase = {
  readonly id: string
  readonly title: string
  /** The conversation this came out of, when there was one. */
  readonly threadId?: string
}

export type ArtifactTab = TabBase & {
  readonly kind: 'artifact'
  readonly artifactId: string
  readonly mime: string
  readonly version: number
  readonly publishedUrl?: string
  /**
   * The body, once it has been fetched.
   *
   * A tab exists before its body does: the run announces a document and the
   * panel opens immediately, because the alternative is a panel that appears a
   * round trip after the sentence that mentioned it.
   */
  readonly body?: string
  readonly failed?: boolean
}

export type Tab = ArtifactTab

/** How many documents one reader may have open before the oldest gives way. */
const MAX_TABS = 8

const WIDTH_KEY = 'divo.artifacts.width'
const DEFAULT_WIDTH = 38
export const MIN_WIDTH = 24
export const MAX_WIDTH = 55

export function clampWidth(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_WIDTH
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(percent)))
}

type State = {
  readonly open: boolean
  readonly widthPercent: number
  readonly tabs: readonly Tab[]
  readonly activeId: string | null
}

function storedWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY)
    return raw ? clampWidth(Number(raw)) : DEFAULT_WIDTH
  } catch {
    // Private mode. A remembered width is a convenience, never a requirement.
    return DEFAULT_WIDTH
  }
}

let state: State = {
  // Closed on arrival. The panel opens because a document exists, not because
  // the reader once looked at one.
  open: false,
  widthPercent: storedWidth(),
  tabs: [],
  activeId: null,
}

const listeners = new Set<() => void>()

function set(next: Partial<State>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

/**
 * The panel's state right now.
 *
 * The same snapshot `useArtifacts` subscribes to, exported because reading it
 * and subscribing to it are two different needs — a caller outside React (and a
 * test) wants the value, not a re-render.
 */
export function peek(): State {
  return state
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useArtifacts(): State {
  return useSyncExternalStore(subscribe, peek)
}

export function setOpen(open: boolean): void {
  set({ open })
}

export function setWidth(percent: number): void {
  const widthPercent = clampWidth(percent)
  set({ widthPercent })
  try { window.localStorage.setItem(WIDTH_KEY, String(widthPercent)) } catch { /* private mode */ }
}

/**
 * Drop the oldest tabs, but never the one being looked at.
 *
 * Trimming by age alone would close the document the reader is reading the
 * moment a ninth arrives — which is precisely when a long run is producing them.
 */
function trim(tabs: readonly Tab[], keepId: string): readonly Tab[] {
  if (tabs.length <= MAX_TABS) return tabs
  const keep = tabs.find(tab => tab.id === keepId)
  const rest = tabs.filter(tab => tab.id !== keepId)
  const trimmed = rest.slice(-(MAX_TABS - 1))
  return keep ? [...trimmed, keep] : trimmed.slice(-MAX_TABS)
}

export type OpenArtifactInput = {
  readonly artifactId: string
  readonly title: string
  readonly mime?: string
  readonly version?: number
  readonly publishedUrl?: string
  readonly threadId?: string
  readonly body?: string
}

/**
 * Show a document, or refresh the one already showing.
 *
 * Keyed on `artifactId`, which is the runtime's own key for the file. A model
 * revising a report re-badges the same path, so this is an update in place —
 * without it a long run leaves the reader eight tabs all called "Q3 review" and
 * no way to tell which is current.
 *
 * The body is deliberately dropped when a newer version arrives without one: the
 * tab must not keep drawing version 2's text under version 3's number while the
 * fetch is in flight.
 */
export function openArtifact(input: OpenArtifactInput): string {
  const existing = state.tabs.find(
    (tab): tab is ArtifactTab => tab.kind === 'artifact' && tab.artifactId === input.artifactId,
  )
  const next: ArtifactTab = {
    id: existing?.id ?? `artifact:${input.artifactId}`,
    kind: 'artifact',
    artifactId: input.artifactId,
    title: input.title.trim() || existing?.title || 'Document',
    mime: input.mime ?? existing?.mime ?? DEFAULT_MIME,
    version: input.version ?? existing?.version ?? 1,
    ...(input.publishedUrl ?? existing?.publishedUrl ? { publishedUrl: input.publishedUrl ?? existing?.publishedUrl } : {}),
    ...(input.threadId ?? existing?.threadId ? { threadId: input.threadId ?? existing?.threadId } : {}),
    ...(input.body !== undefined ? { body: input.body } : {}),
  }

  const tabs = existing
    ? state.tabs.map(tab => (tab.id === existing.id ? next : tab))
    : trim([...state.tabs, next], next.id)

  set({ open: true, tabs, activeId: next.id })
  return next.id
}

/**
 * Put a conversation's existing documents back, without taking the screen.
 *
 * Opening a thread from last week must not make a panel spring out at the
 * reader — they came back for the conversation. So the tabs exist and the panel
 * stays shut until they ask for it, which is the difference between "your
 * documents are here" and "look at this".
 *
 * Bodies are not fetched. A tab nobody opens should not cost a round trip, and
 * the surface fetches its own when it is first drawn.
 */
export function restoreArtifacts(
  summaries: readonly { artifactId: string; title: string; mime: string; version: number; publishedUrl?: string }[],
  threadId: string,
): void {
  const known = new Set(
    state.tabs.flatMap(tab => (tab.kind === 'artifact' ? [tab.artifactId] : [])),
  )
  const restored = summaries
    .filter(summary => !known.has(summary.artifactId))
    .map((summary): ArtifactTab => ({
      id: `artifact:${summary.artifactId}`,
      kind: 'artifact',
      artifactId: summary.artifactId,
      title: summary.title,
      mime: summary.mime,
      version: summary.version,
      ...(summary.publishedUrl ? { publishedUrl: summary.publishedUrl } : {}),
      threadId,
    }))
  if (restored.length === 0) return
  set({ tabs: trim([...restored, ...state.tabs], state.activeId ?? '') })
}

/** Attach a fetched body to a tab, if that tab is still open and still current. */
export function fillArtifact(artifactId: string, version: number, body: string, publishedUrl?: string): void {
  set({
    tabs: state.tabs.map(tab => (
      tab.kind === 'artifact' && tab.artifactId === artifactId && tab.version <= version
        ? { ...tab, body, version, failed: false, ...(publishedUrl ? { publishedUrl } : {}) }
        : tab
    )),
  })
}

/** The body could not be fetched. Said out loud rather than left blank forever. */
export function failArtifact(artifactId: string): void {
  set({
    tabs: state.tabs.map(tab => (
      tab.kind === 'artifact' && tab.artifactId === artifactId ? { ...tab, failed: true } : tab
    )),
  })
}

export function focusTab(id: string): void {
  if (!state.tabs.some(tab => tab.id === id)) return
  set({ open: true, activeId: id })
}

/**
 * Close one tab, and choose what the reader looks at next.
 *
 * The neighbour in the closed tab's own position, not the last tab: closing the
 * third of five and landing on the fifth is a jump the reader did not ask for.
 */
export function closeTab(id: string): void {
  const index = state.tabs.findIndex(tab => tab.id === id)
  if (index < 0) return
  const tabs = state.tabs.filter(tab => tab.id !== id)
  const activeId = state.activeId !== id
    ? state.activeId
    : tabs[Math.min(index, tabs.length - 1)]?.id ?? null
  // An empty panel holding the screen open is a panel in the way.
  set({ tabs, activeId, open: tabs.length > 0 && state.open })
}

/** Everything the reader has open, gone. Used when they leave the workspace. */
export function closeAll(): void {
  set({ tabs: [], activeId: null, open: false })
}

export function activeTab(current: State): Tab | null {
  const newest = current.tabs.length > 0 ? current.tabs[current.tabs.length - 1]! : null
  if (!current.activeId) return newest
  return current.tabs.find(tab => tab.id === current.activeId) ?? newest
}
