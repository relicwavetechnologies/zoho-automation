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
import { API_BASE_URL, type LedgerRow } from './stream'

/** What a run left behind, read back rather than watched live. */
export type ThreadRunRecord = {
  ledger: LedgerRow[]
  elapsedMs: number
  failure?: { code: string; message: string }
}

export type ThreadTurn = {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: string
  /** Present on an answer that came from a run with a work log. */
  run?: ThreadRunRecord
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

export type ThreadDetail = ThreadSummary & { turns: ThreadTurn[] }

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

export async function listThreads(token: string): Promise<ThreadSummary[]> {
  const body = await call<{ threads: ThreadSummary[] }>('/threads', token)
  return body?.threads ?? []
}

/**
 * One conversation, in full.
 *
 * `running` comes back when a run on this thread is still going, so the reader
 * who opens it can be shown the live view rather than a settled transcript that
 * happens to be missing its last answer.
 */
export async function getThread(
  threadId: string,
  token: string,
): Promise<{ thread: ThreadDetail; running?: { runId: string; prompt: string; startedAt: number } } | null> {
  return await call(`/threads/${encodeURIComponent(threadId)}`, token)
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
