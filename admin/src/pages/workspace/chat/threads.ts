/**
 * Conversations, as things that exist.
 *
 * The chat surface used to mint a thread id in a `useMemo` and keep it nowhere.
 * Every consequence of that followed from the same fact: the conversation had no
 * identity outside the component drawing it. Navigate away and it was gone;
 * reload and it was gone; two chats at once was not expressible; and the work
 * the backend was faithfully saving had no id to be looked up by.
 *
 * So an id is minted once, put in the URL, and everything else — history,
 * reconnection, the list in the sidebar — hangs off it.
 */
import type { SentFile } from './attach'
import type { LedgerRow } from './stream'
import { API_BASE_URL } from '@/lib/api-base'

/** What a run left behind, read back rather than watched live. */
export type ThreadRunRecord = {
  ledger: LedgerRow[]
  elapsedMs: number
  failure?: { code: string; message: string }
  interruption?: { message: string }
}

export type ThreadTurn = {
  id: string
  /** Where this turn sits in the thread. The cursor an earlier page is asked for by. */
  sequence: number
  role: 'user' | 'assistant'
  text: string
  at: string
  /** Present on an answer that came from a run with a work log. */
  run?: ThreadRunRecord
  /** Present on an ask that carried files. */
  attachments?: SentFile[]
}

export type ThreadSummary = {
  threadId: string
  title: string
  createdAt: string
  updatedAt: string
  preview: string
  messageCount: number
  /** True while a run on this thread is still going. */
  running?: boolean
}

export type ThreadDetail = ThreadSummary & {
  /** The most recent turns, oldest first — not the whole conversation. */
  turns: ThreadTurn[]
  /** There is older conversation above the first turn here. */
  hasEarlier: boolean
}

/**
 * A new conversation's id.
 *
 * Minted in the browser so that opening one costs no round trip — the URL is
 * right immediately and the thread comes into being when something is said in
 * it. The shape is asserted server-side; this is not a trusted value, it is a
 * convenient one.
 *
 * Underscore rather than a colon after the prefix because this id is a path
 * segment. A colon survives a URL but arrives percent-encoded in half the
 * places that handle it, and an id that is spelled two ways is an id that will
 * eventually be compared against itself and lose.
 */
export function newThreadId(): string {
  return `web_${crypto.randomUUID()}`
}

/** Whether a path segment is shaped like one of ours. */
export function isThreadId(value: string | undefined): value is string {
  return typeof value === 'string' && /^web_[A-Za-z0-9-]{8,64}$/.test(value)
}

/**
 * "The list of chats is now wrong."
 *
 * The sidebar lives above the router and the chat lives under it, so neither can
 * hold the other's state. What passes between them is one fact with no payload:
 * something changed, read it again. A thread acquires its name when its first
 * run finishes and loses its existence when it is deleted, and both happen
 * without the route changing — so nothing else would tell the rail to look.
 *
 * A plain callback set rather than a store, because there is no state here to
 * own. The server has it.
 */
const listeners = new Set<() => void>()

export function threadsChanged(): void {
  for (const listener of listeners) listener()
}

export function onThreadsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * A chat that exists here before it exists anywhere.
 *
 * Pressing Enter starts a run, and the run creates the thread — so for the
 * second or two either side of that round trip the server has never heard of
 * the conversation the reader is already in, and the rail could only show it by
 * guessing. It showed nothing instead: you asked Divo something and the list of
 * chats carried on as though you had not, until the answer came back.
 *
 * So the send says so, here, and the rail draws the row from this until the
 * server's own list catches up. This is a *claim*, not a cache: it holds the
 * one thing the browser genuinely knows that the server does not yet, and the
 * moment the server knows it too, the server's version wins.
 */
export type StartedThread = { threadId: string; title: string; startedAt: number }

const startedHere = new Map<string, StartedThread>()

/** A run has been asked for on this thread. `title` is the ask, for now. */
export function threadStarted(threadId: string, title: string): void {
  startedHere.set(threadId, { threadId, title, startedAt: Date.now() })
  threadsChanged()
}

/**
 * The chat got its real name before the server row carrying it arrived.
 *
 * A claim is named with the raw ask, because at the moment it is made that is
 * the only thing anybody knows. A moment later a small model writes an actual
 * name and the header starts showing it — and until the renamed server row came
 * back, the rail went on showing the sentence. One chat, two names, a
 * centimetre apart, for exactly as long as the round trip took.
 *
 * A no-op once the server row exists, which is the ordinary case: `withStarted
 * Threads` drops the claim the moment a real row can answer for it.
 */
export function threadRenamed(threadId: string, title: string): void {
  const claim = startedHere.get(threadId)
  if (!claim) return
  startedHere.set(threadId, { ...claim, title })
  threadsChanged()
}

/** The run ended, so the server has the thread and everything about it. */
export function threadSettled(threadId: string): void {
  startedHere.delete(threadId)
  threadsChanged()
}

export function startedThreads(): StartedThread[] {
  return [...startedHere.values()]
}

/**
 * The rail's list, with the chats the server has not caught up on.
 *
 * A claim is only drawn while the server has nothing to say about that thread.
 * The moment its own row appears, that row is used unchanged — including its
 * `running` flag, which is the authority on whether work is still going and the
 * only one that survives a reload. Overriding it from here would keep a chat
 * marked as working long after it finished, on the strength of a browser tab
 * remembering that it once pressed send.
 */
export function withStartedThreads(
  threads: readonly ThreadSummary[],
  started: readonly StartedThread[],
): ThreadSummary[] {
  const known = new Set(threads.map(thread => thread.threadId))
  const pending = started
    .filter(claim => !known.has(claim.threadId))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(claim => {
      const at = new Date(claim.startedAt).toISOString()
      return {
        threadId: claim.threadId,
        title: claim.title,
        createdAt: at,
        updatedAt: at,
        preview: '',
        messageCount: 1,
        running: true,
      }
    })
  return [...pending, ...threads]
}

async function call<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T | null> {
  const response = await fetch(`${API_BASE_URL}/api/web-chat${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  }).catch(() => null)
  if (!response?.ok) return null
  return await response.json().catch(() => null) as T | null
}

/** How many chats the rail shows before asking, and how many each ask adds. */
export const THREAD_PAGE = 25

/**
 * The newest `limit` chats, and whether older ones exist.
 *
 * A window rather than a cursor. The rail is live — a chat renamed, deleted or
 * answered reorders the list under the reader — and a cursor followed through
 * a reorder shows one chat twice and skips another. Re-asking for the window
 * the reader is looking at is one query and cannot drift.
 */
export async function listThreads(
  token: string,
  limit = THREAD_PAGE,
): Promise<{ threads: ThreadSummary[]; hasMore: boolean }> {
  const body = await call<{ threads: ThreadSummary[]; hasMore?: boolean }>(
    `/threads?limit=${limit}`,
    token,
  )
  return { threads: body?.threads ?? [], hasMore: body?.hasMore ?? false }
}

/**
 * One conversation, in full.
 *
 * `running` comes back when a run on this thread is still going, so the reader
 * who opens it can be shown the live view rather than a settled transcript that
 * happens to be missing its last answer.
 *
 * Cancellable, and the caller passes a signal because it knows something this
 * cannot: that the reader has moved to a different conversation. It used to
 * take no signal at all, so switching threads discarded the result of a read
 * that carried on running to completion — a whole transcript fetched, parsed
 * and thrown away, while the thread the reader is actually looking at waits
 * behind it.
 */
export async function getThread(
  threadId: string,
  token: string,
  signal?: AbortSignal,
  /** The oldest turn already held. Omit for the newest page. */
  before?: number,
): Promise<{
  thread: ThreadDetail
  running?: { runId: string; prompt: string; attachments?: SentFile[]; startedAt: number }
} | null> {
  const cursor = before === undefined ? '' : `?before=${before}`
  return await call(`/threads/${encodeURIComponent(threadId)}${cursor}`, token, { signal })
}

export async function renameThread(
  threadId: string,
  title: string,
  token: string,
): Promise<boolean> {
  const body = await call<{ ok: boolean }>(`/threads/${encodeURIComponent(threadId)}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
  return body?.ok === true
}

export async function deleteThread(threadId: string, token: string): Promise<boolean> {
  const body = await call<{ ok: boolean }>(`/threads/${encodeURIComponent(threadId)}`, token, {
    method: 'DELETE',
  })
  return body?.ok === true
}
