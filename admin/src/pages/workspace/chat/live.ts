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
import type { Beat } from './transcripts'
import { toolMarkFor } from './tool-identity'
import {
  ask, stop, watch,
  type LedgerRow, type RunEvent, type Timeline,
} from './stream'
import { getThread, threadSettled, type ThreadRunRecord, type ThreadTurn } from './threads'
import type { RunState } from './player'

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
    // The stream decides when a step ends, so its duration is never guessed.
    ms: 0,
    lines: (row.children ?? []).map(child => ({
      text: child.label,
      ...(child.outcome ? { detail: child.outcome } : {}),
    })) as Beat extends { t: 'step'; lines: infer L } ? L : never,
    done: row.outcome ?? (row.status === 'failed' ? 'Failed' : 'Done'),
  }
}

/**
 * The answer, as one beat.
 *
 * It used to be split on blank lines so the screen could reveal a paragraph at
 * a time. That was fine while the answer was prose and wrong the moment it was
 * markdown: a blank line is how markdown separates a heading from its list and
 * a sentence from its table, so splitting there handed the renderer a pile of
 * fragments and asked each to make sense alone. The document is the unit.
 *
 * Nothing is lost from the live feel — while the run is going, the prose is
 * arriving as `say` rows in the ledger, which still land one at a time.
 */
function sayBeats(text: string): Beat[] {
  const answer = text.trim()
  /* One id for the whole run, because there is one reply and it is the same
     reply from its first word to its last. Keyed by position instead, it moved
     as the log above it grew, and the answer a reader was mid-sentence through
     was torn down and rebuilt — re-parsing its markdown and replaying its
     arrival animation — because a row above it had been reclassified. */
  return answer ? [{ t: 'say', id: 'answer', text: answer }] : []
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
    return [stepBeat(row)]
  })
}

/**
 * The run so far, as beats.
 *
 * The backend sends a snapshot of the whole timeline each tick, not a delta, so
 * each snapshot simply replaces the beats. Rows carry their own identity, so a
 * dropped frame costs a redraw rather than a corrupted log, and a row that did
 * not change is not redrawn at all.
 */
export function beatsFrom(
  timeline: Timeline | null,
  final: { text: string } | null,
  liveAnswer = '',
): Beat[] {
  const beats = ledgerBeats(timeline?.ledger ?? [])
  beats.push(...sayBeats(final?.text?.trim() ?? liveAnswer))
  return beats
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

/** The same beats, rebuilt from what a finished run wrote down. */
function beatsFromRecord(text: string, run: ThreadRunRecord | undefined): Beat[] {
  const beats = ledgerBeats(asRecorded(run?.ledger ?? []))
  beats.push(...sayBeats(text))
  return beats
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
  beats: Beat[]
  state: RunState
  /** Set when the run ended without an answer. */
  error?: string
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

function settledState(beats: Beat[], elapsed: number): RunState {
  return {
    played: beats.map((_, index) => index),
    gate: null,
    declined: null,
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
        beats: [],
        state: settledState([], 0),
      })
      continue
    }
    const beats = beatsFromRecord(turn.text, turn.run)
    const elapsed = (turn.run?.elapsedMs ?? 0) / 1000
    const open = exchanges[exchanges.length - 1]
    if (open && open.beats.length === 0 && !open.error) {
      exchanges[exchanges.length - 1] = {
        ...open,
        beats,
        state: settledState(beats, elapsed),
        ...(turn.run?.failure ? { error: turn.run.failure.message } : {}),
      }
    } else {
      exchanges.push({
        id: turn.id,
        prompt: '',
        beats,
        state: settledState(beats, elapsed),
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
  /** True until the thread's history has been read back. */
  loading: boolean
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
  send: (text: string, files?: readonly File[]) => boolean
  error: string | null
}

export function useThreadRun(input: {
  threadId: string
  token: string | null
}): ThreadRun {
  const [settled, setSettled] = useState<Exchange[]>([])
  const [title, setTitle] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [prompt, setPrompt] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [liveAnswer, setLiveAnswer] = useState('')
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
        if (event.type === 'timeline') setTimeline(event.timeline)
        if (event.type === 'answer') setLiveAnswer(event.text)
        if (event.type === 'answer_delta') setLiveAnswer(current => current + event.delta)
        if (event.type === 'answer_reset') setLiveAnswer('')
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
    setSettled([])
    setTitle(null)
    setPrompt(null)
    setTimeline(null)
    setLiveAnswer('')
    setFinal(null)
    setError(null)
    setRunning(false)
    setLoading(true)

    const load = async (): Promise<{ prompt: string; startedAt: number } | null> => {
      const found = await getThread(threadId, input.token!)
      if (controller.signal.aborted || currentThread.current !== threadId) return null
      const history = exchangesFrom(found?.thread.turns ?? [])
      const live = found?.running

      // A live run's own ask is already the last user turn in history — the
      // runtime wrote it down when the run started. Lifting it out of the
      // settled list stops the same question appearing twice, once above its
      // answer and once beside it.
      const last = history[history.length - 1]
      if (live && last && last.beats.length === 0) history.pop()

      setSettled(history)
      setTitle(found?.thread.title?.trim() || null)
      setLoading(false)
      return live ? { prompt: live.prompt || last?.prompt || '', startedAt: live.startedAt } : null
    }

    void (async () => {
      const live = await load()
      if (!live) return
      setPrompt(live.prompt)
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
    const beats = beatsFrom(timeline, final)
    setSettled(previous => [...previous, {
      id: runExchangeId(startedAt.current),
      prompt,
      beats,
      /* Read once, here, from the same clock the header was ticking off. The
         duration is only news when the run is over. */
      state: settledState(beats, (Date.now() - startedAt.current) / 1000),
      ...(error ? { error } : {}),
    }])
    setPrompt(null)
    setTimeline(null)
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

  const send = useCallback((text: string, files?: readonly File[]): boolean => {
    if (!input.token || running) return false
    const controller = new AbortController()
    abort.current?.abort()
    abort.current = controller
    startedAt.current = Date.now()
    setPrompt(text)
    setTimeline(null)
    setLiveAnswer('')
    setFinal(null)
    setError(null)
    setRunning(true)

    void consume(ask({
      threadId: input.threadId,
      text,
      ...(files?.length ? { files } : {}),
      token: input.token,
      signal: controller.signal,
    }), controller)
    return true
  }, [input.threadId, input.token, running, consume])

  const stopRun = useCallback(() => {
    if (!input.token || !running) return
    void stop(input.threadId, input.token)
  }, [input.threadId, input.token, running])

  /* Rebuilt only when the wire says something new.
     Every value below it is derived, and a derived value with a fresh identity
     is a re-render of everything downstream — so a render caused by anything
     else at all (a scroll flag, a title arriving) used to rebuild every beat in
     the run and hand each exchange a new object to redraw from. */
  const liveBeats = useMemo(
    () => (prompt === null ? [] : beatsFrom(timeline, final, liveAnswer)),
    [prompt, timeline, final, liveAnswer],
  )

  /* The timeline is a snapshot of work already reported, so every received
     beat is visible. Web writes no longer create a client-side approval gate;
     configured company governance remains a backend concern. */
  const liveState = useMemo<RunState>(() => ({
    played: liveBeats.map((_, index) => index),
    gate: null,
    declined: null,
    finished: !running,
    startedAt: startedAt.current,
    elapsed: 0,
  }), [liveBeats, running])

  const exchanges = useMemo(() => (prompt === null
    ? settled
    : [...settled, {
      id: runExchangeId(startedAt.current),
      prompt,
      beats: liveBeats,
      state: liveState,
      ...(error ? { error } : {}),
    }]), [prompt, settled, liveBeats, liveState, error])

  return {
    exchanges,
    title,
    loading,
    liveLabel: running ? timeline?.liveLabel ?? null : null,
    running,
    stopRun,
    send,
    error,
  }
}
