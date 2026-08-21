/**
 * A conversation, live and remembered.
 *
 * This started as a wrapper around one run: it held a prompt, a set of beats,
 * and a flag saying whether the run was going. Sending a second message reset
 * all three. That was not a chat — it was a form that happened to stream, and
 * every complaint about the surface came from it. Leaving the page ended the
 * run. Coming back showed nothing. A follow-up erased the exchange above it.
 *
 * So the unit here is a **thread**, and a run is one exchange inside it. The
 * thread has an id that lives in the URL, its turns are read back from the
 * server, and a run that is still going is *joined* rather than restarted. What
 * did not change is the shape handed to the components below — a transcript and
 * a cursor over it — which is why none of them needed touching.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Beat } from './beats'
import { traceSteps, type TraceStep } from './lifecycle'
import { agentRunOf, isAgentRow } from './agents'
import { planOf, type Plan } from './plan'
import { toolMarkFor } from './tool-identity'
import {
  ask, stop, watch,
  type LedgerRow, type RunEvent, type Timeline,
} from './stream'
import { uploadVideo } from './stream'
import { isVideo, sentFrom, videoMimeFor, type SentFile } from './attach'
import { getThread, threadSettled, type ThreadRunRecord, type ThreadTurn } from './threads'
import { showArtifact } from '../artifacts/open'
import type { RunState } from './player'
import type { ModelSelection } from './model-choice'

/** "Watching workflow.mov · reading screens 62%" */
function watchingLabel(watching: { fileName: string; percent: number; step: string }): string {
  if (watching.step === 'uploading') return `sending ${watching.fileName}`
  const step = watching.step === 'transcribing'
    ? 'listening to'
    : watching.step === 'reading_screens' ? 'reading screens in' : 'watching'
  return `${step} ${watching.fileName} · ${Math.round(watching.percent)}%`
}

function stepBeat(row: LedgerRow): Beat {
  return {
    t: 'step',
    ...(row.id ? { id: row.id } : {}),
    tool: toolMarkFor(row),
    title: row.count > 1 ? `${row.label} ×${row.count}` : row.label,
    ...(row.outcome ? { chip: row.outcome } : {}),
    // Straight off the row. The run knows which of its calls are still open —
    // it can have two — and reading that from the row rather than from where
    // the row happens to sit in the list is what lets a step keep shimmering
    // while the model narrates over the top of it.
    ...(row.status === 'running' ? { running: true } : {}),
    done: row.outcome ?? (row.status === 'failed' ? 'Failed' : 'Done'),
  }
}

/**
 * The work log — everything the run did on the way, and nothing it landed on.
 *
 * The ledger's `say` rows are the model's prose in sentence-sized pieces, and
 * some of them are the reply: the run says "Three invoices are overdue" and
 * that same sentence arrives again, complete, on the answer stream. Printing
 * both is how "hi" came back as "Hi! How can I help you today?" twice, one line
 * apart.
 *
 * Which is which is not this module's judgement to make, and it used to make it
 * anyway — dropping trailing `say` rows whenever the answer stream happened to
 * be non-empty. That is a fact about the wire, and the backend clears the answer
 * stream on every tool call, so the flag flipped several times a turn and the
 * same sentence moved between the log and the answer and back. The run knows
 * which sentences it went on working after; it now says so, and this reads it.
 */
function ledgerBeats(ledger: readonly LedgerRow[]): Beat[] {
  return ledger.flatMap((row, index): Beat[] => {
    const id = row.id ?? `row:${index}`
    // Prose the run landed on is the reply, and the reply is drawn under this
    // log rather than inside it.
    if (row.kind === 'say') {
      return row.aside ? [{ t: 'say', id, text: row.label, narration: true }] : []
    }
    /* A thought has no end event — the model stops thinking by doing something
       else — so the run marks the row settled at the moment it does. This used
       to be guessed from the row being last in the list, which made a thought
       flicker between its live window and its folded line every time the list
       was reshaped for an unrelated reason. The caller still has to agree the
       run itself is open: a record kept mid-thought is not still thinking. */
    if (row.kind === 'thought') {
      return [{ t: 'think', id, text: row.label, running: row.status === 'running' }]
    }
    // The one row whose content is underneath it rather than in its label.
    if (isAgentRow(row)) return [{ t: 'agents', id, run: agentRunOf(row) }]
    return [stepBeat(row)]
  })
}

/**
 * The work log so far.
 *
 * The backend sends a snapshot of the whole timeline each tick, not a delta, so
 * each snapshot simply replaces the log. Rows carry their own identity, so a
 * dropped frame costs a redraw rather than a corrupted log, and a row that did
 * not change is not redrawn at all.
 *
 * Deliberately knows nothing about the answer. The two used to be concatenated
 * into one array here and pulled apart again by the renderer, which meant the
 * whole log was rebuilt on every token of the reply — see `traceFrom`'s memo in
 * `useThread`, which is the point of keeping them separate.
 */
export function traceFrom(timeline: Timeline | null): TraceStep[] {
  return traceSteps(ledgerBeats(timeline?.ledger ?? []))
}

/**
 * A stored ledger, read back the best way it can be.
 *
 * Runs recorded before the reducer marked asides cannot say which sentences
 * were ones — so for those, and only those, the old reading applies: everything
 * but the last unbroken run of talking was said on the way. It was a poor rule
 * live, because the thing it keyed off changed several times a turn; on a
 * finished run nothing moves, and it recovers narration that would otherwise
 * disappear from every conversation older than this change.
 *
 * Scoped to the record seam on purpose. The live path has the run's own answer
 * and must never fall back to guessing at it. This deletes itself once no
 * stored run predates the mark.
 */
function asRecorded(rows: readonly LedgerRow[]): LedgerRow[] {
  if (rows.some(row => row.aside)) return [...rows]
  const lastSpoken = rows.reduce(
    (found, row, index) => (row.kind === 'tool' ? index : found),
    -1,
  )
  return rows.map((row, index) => (
    row.kind === 'say' && index < lastSpoken ? { ...row, aside: true as const } : row
  ))
}

/** The same log, rebuilt from what a finished run wrote down. */
function traceFromRecord(run: ThreadRunRecord | undefined): TraceStep[] {
  return traceSteps(ledgerBeats(asRecorded(run?.ledger ?? [])))
}

/**
 * One ask and everything that came of it.
 *
 * The thread is a list of these. Only the last one can be live, because the
 * server allows a thread one run at a time — two containers on one conversation
 * would answer each other's questions.
 */
export type Exchange = {
  id: string
  prompt: string
  /**
   * What the run did on the way. Changes about once a second.
   *
   * Held apart from the answer rather than interleaved with it, because they
   * move at rates two orders of magnitude apart and are never drawn mixed
   * together. One array meant the slower value inherited the faster one's
   * identity, so every token of the reply rebuilt every row of the log — and
   * with it every vendor mark, roughly thirty times a second.
   */
  trace: TraceStep[]
  /** What the run landed on. Changes with every token while it streams. */
  answer: string
  state: RunState
  /** Set when the run ended without an answer. */
  error?: string
  /** Files that went with the ask. Drawn under it, the way the composer showed them. */
  attachments?: SentFile[]
}

/**
 * The identity of an exchange this reader started, live and afterwards alike.
 *
 * A run used to be called `live` while it streamed and `${prompt}:${startedAt}`
 * once it settled, which made finishing look like a different exchange arriving:
 * React tore the element down and built a new one at the exact moment the answer
 * appeared, and anything anchored to the exchange — a scroll position, a pinned
 * prompt — was anchored to something that no longer existed. The run's start is
 * the one thing true of it from the first frame to the last.
 */
export function runExchangeId(startedAtMs: number): string {
  return `run:${startedAtMs}`
}

function settledState(elapsed: number): RunState {
  return {
    finished: true,
    startedAt: null,
    elapsed,
  }
}

/**
 * Server turns → exchanges.
 *
 * Turns arrive as a flat alternating list, which is what the model reads. A
 * reader sees pairs: the ask, and the work it caused. An answer with no question
 * before it (a run recorded after its user turn failed to save) still gets its
 * own exchange rather than being dropped — the answer happened.
 */
export function exchangesFrom(turns: readonly ThreadTurn[]): Exchange[] {
  const exchanges: Exchange[] = []
  for (const turn of turns) {
    if (turn.role === 'user') {
      exchanges.push({
        id: turn.id,
        prompt: turn.text,
        trace: [],
        answer: '',
        state: settledState(0),
        ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
      })
      continue
    }
    const trace = traceFromRecord(turn.run)
    const elapsed = (turn.run?.elapsedMs ?? 0) / 1000
    const open = exchanges[exchanges.length - 1]
    if (open && open.trace.length === 0 && !open.answer && !open.error) {
      exchanges[exchanges.length - 1] = {
        ...open,
        trace,
        answer: turn.text,
        state: settledState(elapsed),
        ...(turn.run?.failure ? { error: turn.run.failure.message } : {}),
      }
    } else {
      exchanges.push({
        id: turn.id,
        prompt: '',
        trace,
        answer: turn.text,
        state: settledState(elapsed),
        ...(turn.run?.failure ? { error: turn.run.failure.message } : {}),
      })
    }
  }
  return exchanges
}

export type ThreadRun = {
  /** Every exchange in the thread, oldest first. */
  exchanges: Exchange[]
  /**
   * What the conversation is called, once the server has one to give.
   *
   * Null on a thread that has not been spoken in yet — it does not exist server
   * side until then, and calling it anything before that would be naming
   * something that is not there.
   */
  title: string | null
  /** True until the thread's newest page has been read back. */
  loading: boolean
  /**
   * There is older conversation above the first exchange on screen.
   *
   * A thread arrives one page at a time — it used to arrive whole, every
   * message it had ever held, each answer carrying its full work log. This is
   * the server's own answer to "is there more?", not a guess from a full page.
   */
  hasEarlier: boolean
  /** True while an earlier page is being fetched. */
  loadingEarlier: boolean
  /** Fetch the page above the oldest exchange on screen. */
  loadEarlier: () => Promise<void>
  /**
   * What the run says it is doing right now.
   *
   * Comes from the timeline, not from this file: "Starting your workspace",
   * "Working in Zoho Books", "A step failed; checking what can continue…". The
   * screen printed a hardcoded "Working" and threw this away, which made a cold
   * container boot indistinguishable from a hang.
   */
  liveLabel: string | null
  /** True while a run is open — the composer turns its send control into stop. */
  running: boolean
  /**
   * The checklist the model committed to, while a run is open.
   *
   * Null the rest of the time, and that is the tool's own design rather than a
   * limitation here: a `divo_todos` list grants nothing, stores nothing, and
   * dies with the run — `ThreadRunRecord` carries a ledger and no plan. It
   * describes work happening now, so it exists only while work is happening.
   *
   * Kept off `Exchange` for the same reason. An exchange is a thing the
   * conversation keeps; this is not one, and hanging it there would put a field
   * on every settled exchange that could only ever be null.
   */
  plan: Plan | null
  /** Ask the run to stop. The reply still arrives on the open stream. */
  stopRun: () => void
  /**
   * Start a run, reporting whether one actually started.
   *
   * It declines while a run is already open, and a caller that assumed
   * otherwise would act on a send that never happened — the screen pins the
   * newest exchange to the top of the window on send, and a pin armed by a
   * declined send fires later, against whatever exchange appears next.
   */
  send: (text: string, files: readonly File[] | undefined, modelSelection: ModelSelection) => boolean
  error: string | null
}

/**
 * How often an idle thread asks whether a run has begun without it.
 *
 * Six seconds because the thing being waited for is a person coming back from
 * an OAuth consent screen, where a few seconds of nothing reads as broken. It
 * costs one request per interval and only while a thread is open, idle, and
 * visible.
 */

export function useThreadRun(input: {
  threadId: string
  token: string | null
}): ThreadRun {
  /*
   * The conversation as the server sent it, and the exchanges this session
   * added on top.
   *
   * Turns rather than exchanges, because a page boundary does not respect the
   * pairing: an earlier page can end on a question whose answer is on the newer
   * one. Pairing each page as it arrives would draw those two as separate
   * exchanges — a question with no answer, above an answer with no question —
   * so pairing happens once, over everything held.
   */
  const [turns, setTurns] = useState<ThreadTurn[]>([])
  const [appended, setAppended] = useState<Exchange[]>([])
  const [hasEarlier, setHasEarlier] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [title, setTitle] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [prompt, setPrompt] = useState<string | null>(null)
  /* Described rather than held. The chips outlive the run and the `File`
     objects do not need to: keeping the handles alive would pin every uploaded
     buffer in memory for as long as the thread is open, to draw a name and a
     size that were copied out of them on the way past. */
  const [sent, setSent] = useState<SentFile[]>([])
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [liveAnswer, setLiveAnswer] = useState('')
  /* What Divo is taking in before the run proper starts. Null once it is done —
     a finished reading is not something the thread should keep reporting. */
  const [watching, setWatching] = useState<
    { fileName: string; percent: number; step: string } | null
  >(null)
  /* Whether the ask is still waiting on an upload, so Stop knows whether the
     server has anything to cancel yet. A ref because Stop reads it from a
     callback that must not be rebuilt on every progress tick. */
  const uploading = useRef(false)
  const [final, setFinal] = useState<{ text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const startedAt = useRef(0)
  /* Guards a late response from a thread the reader has already left. Without
     it, switching threads mid-fetch paints one conversation's history under
     another one's name. */
  const currentThread = useRef(input.threadId)
  currentThread.current = input.threadId
  /* Read inside `consume`, which is deliberately built once — a token in its
     dependency list would rebuild the consumer, and a rebuilt consumer mid-run
     is a second reader of one stream. */
  const currentToken = useRef(input.token)
  currentToken.current = input.token
  /* The newest turn this thread has been shown, by sequence. The idle poll
     compares the server against it to notice turns that arrived from somewhere
     other than this browser. */

  /**
   * Consume a run's events, however it was reached.
   *
   * Starting one and re-joining one differ only in which generator they read,
   * which is the point: a reader who reloads mid-run is on exactly the code path
   * a reader who never left is on.
   */
  const consume = useCallback(async (
    events: AsyncGenerator<RunEvent>,
    controller: AbortController,
  ): Promise<boolean> => {
    let answered = false
    try {
      for await (const event of events) {
        if (controller.signal.aborted) return answered
        if (event.type === 'watching') {
          setWatching(event.step === 'ready'
            ? null
            : { fileName: event.fileName, percent: event.percent, step: event.step })
        }
        if (event.type === 'timeline') setTimeline(event.timeline)
        if (event.type === 'answer') setLiveAnswer(event.text)
        if (event.type === 'answer_delta') setLiveAnswer(current => current + event.delta)
        if (event.type === 'answer_reset') setLiveAnswer('')
        // Opened on the announcement, filled a fetch later. Waiting for the body
        // first would leave a gap between the sentence naming the document and
        // the document appearing, which reads as the panel having missed it.
        if (event.type === 'artifact') {
          void showArtifact(event, currentThread.current, currentToken.current)
        }
        if (event.type === 'error') { setError(event.message); answered = true }
        if (event.type === 'final') {
          answered = true
          setTimeline(event.timeline)
          setFinal({ text: event.text })
        }
      }
    } catch {
      // An abort is the reader leaving, not a failure to report. The run itself
      // carries on server-side and will be here when they come back.
      if (!controller.signal.aborted) {
        setError('The connection to Divo dropped. The run is still going — reopen this chat to watch it.')
        answered = true
      }
    } finally {
      if (!controller.signal.aborted) setRunning(false)
    }
    return answered
  }, [])

  /* Opening a thread: read its history, then join whatever is still going.
     Both, in that order, because a run in flight belongs at the bottom of the
     conversation it is part of and not on its own. */
  useEffect(() => {
    const threadId = input.threadId
    if (!input.token) return
    const controller = new AbortController()
    abort.current?.abort()
    abort.current = controller
    setTurns([])
    setAppended([])
    setHasEarlier(false)
    setTitle(null)
    setPrompt(null)
    setTimeline(null)
    setWatching(null)
    setLiveAnswer('')
    setFinal(null)
    setError(null)
    setRunning(false)
    setLoading(true)

    const load = async (): Promise<
      { prompt: string; attachments: SentFile[]; startedAt: number } | null
    > => {
      const found = await getThread(threadId, input.token!, controller.signal)
      if (controller.signal.aborted || currentThread.current !== threadId) return null
      const page = found?.thread.turns ?? []
      const live = found?.running

      // A live run's own ask is already the last turn the server holds — the
      // runtime wrote it down when the run started. Lifting it out stops the
      // same question appearing twice, once above its answer and once beside it.
      const lastTurn = page[page.length - 1]
      const trailingAsk = live !== undefined && lastTurn?.role === 'user'

      setTurns(trailingAsk ? page.slice(0, -1) : page)
      setHasEarlier(found?.thread.hasEarlier ?? false)
      setTitle(found?.thread.title?.trim() || null)
      setLoading(false)
      /* The ask is redrawn whole, files included. Read from the run rather than
         from the turn it wrote: on a reload mid-run that turn is the one being
         lifted out just above, so its chips would go with it. */
      return live
        ? {
          prompt: live.prompt || (trailingAsk ? lastTurn!.text : ''),
          attachments: live.attachments ?? lastTurn?.attachments ?? [],
          startedAt: live.startedAt,
        }
        : null
    }

    void (async () => {
      const live = await load()
      if (!live) return
      setPrompt(live.prompt)
      setSent(live.attachments)
      startedAt.current = live.startedAt
      setRunning(true)
      const answered = await consume(
        watch({ threadId, token: input.token!, signal: controller.signal }),
        controller,
      )
      // The run finished in the gap between reading the thread and joining it,
      // so there was nothing left to watch and no answer came down the wire.
      // The answer is in the conversation by now — read it rather than leaving
      // a live exchange on screen that will never resolve.
      if (!answered && !controller.signal.aborted) {
        setPrompt(null)
        await load()
      }
    })()

    return () => controller.abort()
  }, [input.threadId, input.token, consume])

  /* A run started here keeps its own controller, which the effect above never
     sees. Without this, leaving the page leaves that reader open — the run is
     meant to outlive the connection, not the connection the reader. */
  useEffect(() => () => abort.current?.abort(), [])

  /* A finished run joins the conversation above it, and the live slot empties.
     Done here rather than by refetching the thread: the exchange on screen is
     already exactly what the server would send back, and a refetch would blank
     the answer the reader is mid-sentence through. */
  useEffect(() => {
    if (running || prompt === null) return
    if (!final && !error) return
    setAppended(previous => [...previous, {
      id: runExchangeId(startedAt.current),
      prompt,
      trace: traceFrom(timeline),
      answer: final?.text?.trim() ?? '',
      /* Read once, here, from the same clock the header was ticking off. The
         duration is only news when the run is over. */
      state: settledState((Date.now() - startedAt.current) / 1000),
      ...(error ? { error } : {}),
      ...(sent.length ? { attachments: sent } : {}),
    }])
    setPrompt(null)
    setSent([])
    setTimeline(null)
    setWatching(null)
    setLiveAnswer('')
    setFinal(null)
    setError(null)
    // A finished run is the moment a new thread acquires its name and stops
    // being marked as working, and neither is visible from the sidebar. It is
    // also the moment the rail's own claim on this thread expires: the server
    // has the conversation now, so it is the one that should be describing it.
    threadSettled(input.threadId)
    // Intentionally keyed on the run ending: the values it reads are all
    // settled by then, and re-running on every frame would duplicate the
    // exchange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, final, error])

  const send = useCallback((
    text: string,
    files: readonly File[] | undefined,
    modelSelection: ModelSelection,
  ): boolean => {
    if (!input.token || running) return false
    const controller = new AbortController()
    abort.current?.abort()
    abort.current = controller
    startedAt.current = Date.now()
    setPrompt(text)
    setSent((files ?? []).map(sentFrom))
    setTimeline(null)
    setWatching(null)
    setLiveAnswer('')
    setFinal(null)
    setError(null)
    setRunning(true)

    /* Recordings go first, on their own endpoint, and only their ids travel
       with the ask. Doing it here rather than inside `ask` keeps the upload
       visible: it is the slowest part of sending and the composer has already
       locked, so the thread has to say what is happening. */
    const recordings = (files ?? []).filter(isVideo)
    const ordinary = (files ?? []).filter(file => !isVideo(file))

    uploading.current = recordings.length > 0
    void (async () => {
      const videoIds: string[] = []
      for (const recording of recordings) {
        setWatching({ fileName: recording.name, percent: 0, step: 'uploading' })
        try {
          videoIds.push(await uploadVideo({
            threadId: input.threadId,
            file: recording,
            mimeType: videoMimeFor(recording),
            token: input.token!,
            signal: controller.signal,
          }))
        } catch (error) {
          uploading.current = false
          if (controller.signal.aborted) return
          setWatching(null)
          setRunning(false)
          setError(error instanceof Error ? error.message : 'That recording could not be sent.')
          return
        }
      }
      uploading.current = false
      if (controller.signal.aborted) return
      await consume(ask({
        threadId: input.threadId,
        text,
        modelSelection,
        ...(ordinary.length ? { files: ordinary } : {}),
        ...(videoIds.length ? { videoIds } : {}),
        token: input.token!,
        signal: controller.signal,
      }), controller)
    })()
    return true
  }, [input.threadId, input.token, running, consume])

  const stopRun = useCallback(() => {
    if (!input.token || !running) return
    /* Only the upload is cancelled locally.
       While a recording is still going up there is no run on the server yet, so
       `stop` has nothing to cancel — without this the upload finished and then
       started the very turn the member had just withdrawn. Aborting
       unconditionally is worse than not aborting at all: for an ordinary run it
       closes this view's own stream, so the runtime's "Stopped" reply never
       arrives, nothing clears `running`, and the composer is wedged until the
       thread changes. */
    if (uploading.current) {
      uploading.current = false
      abort.current?.abort()
      setWatching(null)
      setRunning(false)
      /* Said out loud, not left blank. Without an error the append effect skips
         this exchange entirely, so the message sits in the thread looking as
         though Divo answered with nothing — and vanishes on reload. The server
         path says "Stopped…" for the same reason; this is its equivalent for a
         stop that happened before the server had anything to stop. */
      setError('Stopped before the recording finished sending.')
    }
    void stop(input.threadId, input.token)
  }, [input.threadId, input.token, running])

  /* The work log, on the wire's own clock.
     Rebuilt only when the timeline says something new — about once a second —
     and pointedly not when the answer grows. It used to be memoised on the
     answer too, because the two shared an array: the reply arrives in deltas
     every few milliseconds, so every row of the log, every vendor mark and
     every agent list was rebuilt roughly thirty times a second to draw exactly
     what was already on screen. That is the flicker. */
  const liveTrace = useMemo(
    () => (prompt === null ? [] : traceFrom(timeline)),
    [prompt, timeline],
  )

  /* The answer, on the model's clock. A new string thirty times a second is
     what a stream is; it reaches one text node and nothing else. */
  const liveAnswerText = useMemo(
    () => (prompt === null ? '' : final?.text?.trim() ?? liveAnswer),
    [prompt, final, liveAnswer],
  )

  /* No longer keyed on the beats. It used to enumerate them — one index per
     beat, to say which had been played — so every answer delta handed the
     thread a fresh state object and redrew the whole exchange to report that a
     list it already had was still fully visible. */
  const liveState = useMemo<RunState>(() => ({
    finished: !running,
    startedAt: startedAt.current,
    elapsed: 0,
  }), [running])

  /* Read straight off the timeline rather than folded into the beats, because
     it is not one: a beat is a thing that happened at a point in the run, and
     the plan is the run's declared shape — replaced whole each time the model
     restates it, drawn in one place beside the thread rather than in sequence
     with everything else.

     Memoised on the timeline alone. The answer stream arrives in deltas every
     few milliseconds, and a plan rebuilt on each of them would hand the panel a
     new list of steps thirty times a second to draw the same five rows. */
  const plan = useMemo(() => planOf(timeline, running), [timeline, running])

  /* One pairing over everything held, then whatever this session finished on
     top. The server's turns and the exchanges completed here are kept apart
     precisely so this can be re-derived when an earlier page is prepended. */
  const settled = useMemo(
    () => [...exchangesFrom(turns), ...appended],
    [turns, appended],
  )

  /**
   * Fetch the page above the oldest turn on screen.
   *
   * Keyed off the oldest *turn's* sequence rather than a page number, so turns
   * arriving or being deleted underneath a reader cannot make a page repeat or
   * skip. Guarded against overlapping reads: pressing the control twice used to
   * be the ordinary way to get a page prepended to itself.
   */
  const loadEarlier = useCallback(async () => {
    const oldest = turns[0]?.sequence
    if (!input.token || oldest === undefined || loadingEarlier || !hasEarlier) return
    setLoadingEarlier(true)
    try {
      const found = await getThread(input.threadId, input.token, undefined, oldest)
      if (currentThread.current !== input.threadId) return
      setTurns(previous => [...(found?.thread.turns ?? []), ...previous])
      setHasEarlier(found?.thread.hasEarlier ?? false)
    } finally {
      setLoadingEarlier(false)
    }
  }, [input.threadId, input.token, turns, loadingEarlier, hasEarlier])

  const exchanges = useMemo(() => (prompt === null
    ? settled
    : [...settled, {
      id: runExchangeId(startedAt.current),
      prompt,
      trace: liveTrace,
      answer: liveAnswerText,
      state: liveState,
      ...(error ? { error } : {}),
      ...(sent.length ? { attachments: sent } : {}),
    }]), [prompt, settled, liveTrace, liveAnswerText, liveState, error, sent])

  return {
    exchanges,
    title,
    loading,
    /** There is older conversation above the first exchange on screen. */
    hasEarlier,
    loadingEarlier,
    loadEarlier,
    /* The reading takes over the live label while it runs: there is no timeline
       yet, and "Divo is watching workflow.mov (40%)" is the only true thing the
       thread can say during a wait that lasts minutes. */
    liveLabel: running
      ? (watching ? watchingLabel(watching) : timeline?.liveLabel ?? null)
      : null,
    running,
    plan,
    stopRun,
    send,
    error,
  }
}
