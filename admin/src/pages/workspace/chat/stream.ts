/**
 * The run, coming down a wire.
 *
 * `player.ts` turns a scripted transcript into beats on a clock. This turns a
 * real run into the same beats — so everything drawn on top of them is unchanged
 * whether the run is a demo or the actual agent. That was the seam
 * `screens-chat.tsx` was built around, and this is the thing that fills it.
 *
 * The backend speaks a neutral `ChannelTimeline`: the same value a Lark card is
 * built from. Nothing here asks for a web-shaped payload, because there is no
 * web-shaped payload — see `plans/divo-one-soul-two-surfaces.md`.
 */

export const API_BASE_URL =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL
  ?? 'http://localhost:8000'

/** One row of the run's activity log, as the backend sends it. */
export type LedgerRow = {
  /**
   * `tool` is something Divo did, `say` is something it told you, `thought` is
   * it reasoning to itself on the way. Lark drops the last kind — a card is
   * read by a whole chat — which is why this arrives marked rather than
   * pre-filtered.
   */
  kind?: 'tool' | 'say' | 'thought'
  label: string
  count: number
  outcome?: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  children?: LedgerRow[]
  /**
   * Who was called, in the wire's own words.
   *
   * `label` is English written for a reader — "Google Gmail" — and parsing it
   * back into a vendor to choose a mark is how every branded call in this log
   * ended up drawn as a terminal. `tool-identity.ts` keys off these instead.
   */
  toolId?: string
  toolName?: string
}

export type Timeline = {
  phase?: string
  state?: 'queued' | 'thinking' | 'planning' | 'working' | 'writing' | 'done' | 'blocked'
  liveLabel?: string
  actionCount?: number
  startedAtMs?: number
  completedSteps?: number
  totalSteps?: number
  progressPct?: number
  declared?: {
    done: number
    total: number
    current?: string
    next?: string
    items?: { title: string; status: LedgerRow['status'] }[]
  }
  ledger?: LedgerRow[]
}

export type RunEvent =
  | { type: 'timeline'; timeline: Timeline }
  | { type: 'answer'; text: string }
  | { type: 'answer_delta'; delta: string }
  | { type: 'answer_reset' }
  | { type: 'final'; text: string; timeline: Timeline }
  | { type: 'error'; message: string; code: string }

export type AskInput = {
  threadId: string
  text: string
  files?: readonly File[]
  token: string
  signal?: AbortSignal
}

/**
 * Ask, and yield what happens.
 *
 * `fetch` rather than `EventSource`: the ask is a POST that can carry files, and
 * `EventSource` only does credential-less GETs. The framing is still SSE, so
 * anything pointed at this endpoint reads it the same way.
 */
export async function* ask(input: AskInput): AsyncGenerator<RunEvent> {
  const body = new FormData()
  body.append('threadId', input.threadId)
  body.append('text', input.text)
  for (const file of input.files ?? []) body.append('files', file)

  const response = await fetch(`${API_BASE_URL}/api/web-chat/runs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.token}` },
    body,
    ...(input.signal ? { signal: input.signal } : {}),
  })

  if (!response.ok || !response.body) {
    yield {
      type: 'error',
      code: String(response.status),
      message: askFailure(response.status),
    }
    return
  }

  yield* readSse(response.body)
}

/**
 * Watch a run that is already going.
 *
 * The route a reader comes back to. Same frames as `ask`, from wherever the run
 * has reached — reloading the page or opening a second tab is another view onto
 * one run, never a second one. Yields nothing when the thread is idle, which is
 * the ordinary case and not a failure.
 */
export async function* watch(input: {
  threadId: string
  token: string
  signal?: AbortSignal
}): AsyncGenerator<RunEvent> {
  const response = await fetch(
    `${API_BASE_URL}/api/web-chat/runs/${encodeURIComponent(input.threadId)}/stream`,
    {
      headers: { Authorization: `Bearer ${input.token}` },
      ...(input.signal ? { signal: input.signal } : {}),
    },
  )
  // 204 — nothing running on this thread. Not an error; there is simply
  // nothing to watch, which is what most thread opens will find.
  if (response.status === 204 || !response.ok || !response.body) return
  yield* readSse(response.body)
}

function askFailure(status: number): string {
  if (status === 401) return 'Your session expired. Sign in again to keep working.'
  if (status === 409) return 'This chat already has a run going. Wait for it, or stop it first.'
  /* The composer checks the size before it offers to send, so reaching this
     means the server's limit is lower than the one the browser was told about.
     Named as a size problem anyway — "please try again" would send someone
     round the same loop with the same file. */
  if (status === 413) return 'That file is too large to send. Try a smaller one.'
  return 'Divo could not start this run. Please try again.'
}

/** Frames out of an SSE body, shared by starting a run and re-joining one. */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<RunEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE separates frames with a blank line. Anything after the last one is
      // a partial frame and has to wait for the next chunk — parsing it early
      // is how a stream reader drops the tail of every message.
      let split = buffer.indexOf('\n\n')
      while (split !== -1) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const event = parseFrame(frame)
        if (event) yield event
        split = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

/** Ask a run that is still going to stop. The reply arrives on the open stream. */
export async function stop(threadId: string, token: string): Promise<void> {
  await fetch(`${API_BASE_URL}/api/web-chat/runs/${encodeURIComponent(threadId)}/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {})
}

function parseFrame(frame: string): RunEvent | null {
  const data = frame
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .join('\n')
  if (!data) return null
  try {
    const parsed = JSON.parse(data) as RunEvent & { type?: string }
    // `open` is a handshake frame, not part of the run.
    return parsed.type === 'timeline' || parsed.type === 'answer'
      || parsed.type === 'answer_delta' || parsed.type === 'answer_reset'
      || parsed.type === 'final' || parsed.type === 'error'
      ? parsed
      : null
  } catch {
    return null
  }
}
