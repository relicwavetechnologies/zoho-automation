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
import { API_BASE_URL } from '@/lib/api-base'
import type { ModelSelection } from './model-choice'

/**
 * One agent working under a step that farmed work out.
 *
 * Its own shape, not another `LedgerRow`: an agent has a role, a task and a
 * clock, and none of a tool call's count, vendor or nesting. Typed as a row it
 * carried four fields that could never mean anything here, and the renderer
 * reached past them every time.
 */
export type LedgerChild = {
  /** The agent's role — "scout", "reviewer". This names it on screen. */
  label: string
  status: LedgerRow['status']
  /** What it was asked to do. */
  outcome?: string
  /** How long it has been working, while it still is. */
  elapsed?: string
}

/** One row of the run's activity log, as the backend sends it. */
export type LedgerRow = {
  /**
   * `tool` is something Divo did, `say` is something it told you, `thought` is
   * it reasoning to itself on the way. Lark drops the last kind — a card is
   * read by a whole chat — which is why this arrives marked rather than
   * pre-filtered.
   */
  kind?: 'tool' | 'say' | 'thought'
  /**
   * Which row this is, across every snapshot of the run.
   *
   * The backend sends a whole timeline each tick, so without this the only way
   * to tell one tick's rows from the last one's is where they sit in the array
   * — and rows do not stay put. A sentence being reclassified inserts one into
   * the middle, which renumbers everything below it, and React tears down and
   * rebuilds rows that never changed. Every animation on them replays; that is
   * the flicker.
   */
  id?: string
  /**
   * A `say` row the model went on working after: an aside, not the reply.
   *
   * The reply is drawn under the log, from the answer stream, so the log draws
   * asides and nothing else. This surface used to work it out for itself by
   * asking whether the answer stream happened to be empty — a fact about the
   * wire, not about the run, and one the backend flips on every tool call. The
   * same sentence moved between the log and the answer, and back, several times
   * a turn.
   */
  aside?: true
  label: string
  count: number
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  outcome?: string
  children?: LedgerChild[]
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

/**
 * The run's timeline, narrowed to what this surface actually draws.
 *
 * Hand-written rather than shared with the backend, because the two trees do
 * not share types — which is exactly why this is kept to the fields that are
 * read. It once mirrored the wire field for field and carried eleven the
 * surface never touched: a phase, a state, four counters, and a plan's own
 * `done`/`total`/`current`/`next` — the last of which `plan.ts` deliberately
 * recomputes from the item list, because two counts of one list disagree the
 * moment one of them is stale.
 *
 * More arrives on the wire than is listed here, and that is fine: JSON ignores
 * what it is not asked for. Adding a field is a two-line change on the day
 * something draws it.
 */
export type Timeline = {
  /** What the run says it is doing right now — shimmered at the trace head. */
  liveLabel?: string
  /** Set only when the model declared a checklist. Drawn as the plan panel. */
  declared?: {
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
  /**
   * A document is ready to read beside the thread.
   *
   * Address only, never the body. The reader may already have this version open,
   * and a report on the event stream would put a document-sized payload on a
   * channel built for sentences.
   */
  | {
      type: 'artifact'
      artifactId: string
      title: string
      mime: string
      version: number
    }
  /**
   * Divo is taking in a video that came with the ask.
   *
   * Arrives before any timeline exists, because the recording has to be read
   * before the model can be asked about it. Without this the thread would sit
   * silent for the minutes that takes.
   */
  | {
      type: 'watching'
      fileName: string
      percent: number
      step: 'watching' | 'transcribing' | 'reading_screens' | 'ready'
    }
  | { type: 'error'; message: string; code: string }

export type AskInput = {
  threadId: string
  text: string
  modelSelection: ModelSelection
  files?: readonly File[]
  /** Videos already uploaded to this thread, by id. */
  videoIds?: readonly string[]
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
/**
 * Hand a recording over before the ask that talks about it.
 *
 * Its own request, and its own endpoint: a screen recording is orders of
 * magnitude larger than anything the multipart ask carries, and sending it
 * early is what lets the server start watching it while the question is still
 * being typed. The body is the file — there is one of them, and its name and
 * type fit in headers.
 */
export async function uploadVideo(input: {
  threadId: string
  file: File
  mimeType: string
  token: string
  signal?: AbortSignal
}): Promise<string> {
  const response = await fetch(
    `${API_BASE_URL}/api/web-chat/threads/${encodeURIComponent(input.threadId)}/video`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${input.token}`,
        'Content-Type': input.mimeType,
        // Encoded, because a header may not carry a newline or a non-ASCII byte
        // and a file name may contain both.
        'X-File-Name': encodeURIComponent(input.file.name),
      },
      body: input.file,
      // Required by fetch whenever a request has a streaming body, and harmless
      // when the body is a File.
      duplex: 'half',
      ...(input.signal ? { signal: input.signal } : {}),
    } as RequestInit,
  )
  const body = await response.json().catch(() => null) as
    { ok?: boolean; video?: { videoId?: string }; error?: string } | null
  if (!response.ok || !body?.ok || !body.video?.videoId) {
    throw new Error(uploadFailureMessage(response.status, body?.error))
  }
  return body.video.videoId
}

function uploadFailureMessage(status: number, error?: string): string {
  if (status === 413 || error === 'file_too_large') return 'That recording is too large to send.'
  // The one refusal a member can act on, so it keeps its own words instead of
  // being flattened into "could not be sent".
  if (status === 429 || error === 'video_budget_reached') {
    return 'Divo is still working through the recordings this workspace has sent. Try again shortly.'
  }
  if (status === 415 || error === 'unsupported_video') return 'Divo reads MP4, MOV and WebM recordings.'
  if (status === 503) return 'Divo cannot watch video in this workspace yet.'
  return 'That recording could not be sent.'
}

export async function* ask(input: AskInput): AsyncGenerator<RunEvent> {
  const body = new FormData()
  body.append('threadId', input.threadId)
  body.append('text', input.text)
  body.append('model', input.modelSelection.model)
  body.append('reasoningEffort', input.modelSelection.reasoningEffort)
  for (const file of input.files ?? []) body.append('files', file)
  for (const videoId of input.videoIds ?? []) body.append('videoIds', videoId)

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
      || parsed.type === 'final' || parsed.type === 'artifact' || parsed.type === 'error'
      || parsed.type === 'watching'
      ? parsed
      : null
  } catch {
    return null
  }
}
