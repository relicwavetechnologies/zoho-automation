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
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Beat } from './transcripts'
import { toolMarkFor } from './tool-identity'
import {
  ask, decideApproval, stop, watch,
  type LedgerRow, type PendingApproval, type RunEvent, type Timeline,
} from './stream'
import { getThread, threadSettled, type ThreadRunRecord, type ThreadTurn } from './threads'
import type { RunState } from './player'

function stepBeat(row: LedgerRow): Beat {
  return {
    t: 'step',
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
  return answer ? [{ t: 'say', text: answer }] : []
}

/**
 * The work log, minus the answer being written into it.
 *
 * The ledger's `say` rows are the model's prose arriving live — and the last
 * run of them *is* the answer, streaming in a sentence at a time. The final
 * event then carries that same answer, complete. Printing both is how "hi" came
 * back as "Hi! How can I help you today?" twice, one line apart.
 *
 * Only the trailing ones are dropped. A `say` before a tool call is narration
 * the answer does not repeat — "let me check the invoices first" — and losing it
 * would make the run look like it worked in silence. What survives is marked as
 * narration, which is how the thread knows to file it with the work rather than
 * beside the answer. On Lark the question never arises: the log is a card and
 * the answer is a separate message, so the two never sit in one column.
 */
function ledgerBeats(ledger: readonly LedgerRow[], answered: boolean): Beat[] {
  const rows = [...ledger]
  if (answered) {
    while (rows.length > 0 && rows[rows.length - 1]!.kind === 'say') rows.pop()
  }
  return rows.map((row, index) => {
    if (row.kind === 'say') return { t: 'say', text: row.label, narration: true }
    /* Unlike a tool call, a thought has no end event — the model stops thinking
       by doing something else. So it counts as still going while it is the
       newest thing in the ledger, which is what earns it the scrolling window
       rather than the folded line. The caller still has to agree the run itself
       is open; the last row of a finished run is not thinking. */
    if (row.kind === 'thought') {
      return { t: 'think', text: row.label, running: index === rows.length - 1 }
    }
    return stepBeat(row)
  })
}

/**
 * The run so far, as beats.
 *
 * The backend sends a snapshot of the whole timeline each tick, not a delta, so
 * each snapshot simply replaces the beats — no reconciliation, no keys to get
 * wrong, and a dropped frame costs a redraw rather than a corrupted log.
 */
export function beatsFrom(
  timeline: Timeline | null,
  final: { text: string; awaitingApproval?: PendingApproval[] } | null,
  liveAnswer = '',
): Beat[] {
  const answer = final?.text?.trim() ?? liveAnswer
  const beats = ledgerBeats(timeline?.ledger ?? [], answer.length > 0)

  for (const approval of final?.awaitingApproval ?? []) {
    beats.push({
      t: 'approve',
      // An approval names the capability it is asking about, so the mark comes
      // from the same identity a tool row's does.
      tool: toolMarkFor({ toolId: approval.toolId }),
      title: String(approval.description?.title ?? 'This needs your approval'),
      body: String(approval.description?.detail ?? 'Divo is asking before it changes anything.'),
      facts: [
        { k: 'Capability', v: approval.toolId },
        { k: 'Action', v: approval.action },
        ...(approval.departmentName ? [{ k: 'Department', v: approval.departmentName }] : []),
      ],
      confirm: 'Approve',
      declined: 'Declined. Nothing was changed.',
    })
  }

  beats.push(...sayBeats(answer))
  return beats
}

/** The same beats, rebuilt from what a finished run wrote down. */
function beatsFromRecord(text: string, run: ThreadRunRecord | undefined): Beat[] {
  const answer = text.trim()
  const beats = ledgerBeats(run?.ledger ?? [], answer.length > 0)
  beats.push(...sayBeats(answer))
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
  approve: () => void
  decline: () => void
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
  const [final, setFinal] = useState<{ text: string; awaitingApproval?: PendingApproval[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [declined, setDeclined] = useState<string | null>(null)
  const [answered, setAnswered] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const startedAt = useRef(0)
  /* Guards a late response from a thread the reader has already left. Without
     it, switching threads mid-fetch paints one conversation's history under
     another one's name. */
  const currentThread = useRef(input.threadId)
  currentThread.current = input.threadId

  /* Elapsed is read off a start timestamp rather than accumulated per tick:
     `setInterval` is not paced to the millisecond and a background tab throttles
     it to roughly once a second, so an accumulated clock under-reports a long
     run by half while the work carries on. */
  useEffect(() => {
    if (!running) return
    const started = startedAt.current
    const tick = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 100)
    return () => window.clearInterval(tick)
  }, [running])

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
          setFinal({
            text: event.text,
            ...(event.awaitingApproval?.length ? { awaitingApproval: event.awaitingApproval } : {}),
          })
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
    setDeclined(null)
    setAnswered(false)
    setElapsed(0)
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
      setElapsed((Date.now() - live.startedAt) / 1000)
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
      state: { ...settledState(beats, elapsed), declined },
      ...(error ? { error } : {}),
    }])
    setPrompt(null)
    setTimeline(null)
    setLiveAnswer('')
    setFinal(null)
    setError(null)
    setDeclined(null)
    setAnswered(false)
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
    setDeclined(null)
    setAnswered(false)
    setElapsed(0)
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

  const liveBeats = prompt === null ? [] : beatsFrom(timeline, final, liveAnswer)
  const gateIndex = liveBeats.findIndex(beat => beat.t === 'approve')
  const gate = !answered && !declined && gateIndex !== -1 ? gateIndex : null
  const pendingApproval = final?.awaitingApproval?.[0]

  const approve = useCallback(() => {
    if (!pendingApproval || !input.token) return
    setAnswered(true)
    void decideApproval(pendingApproval.id, 'approved', input.token)
  }, [pendingApproval, input.token])

  const decline = useCallback(() => {
    if (!pendingApproval || !input.token) return
    setDeclined('Declined. Nothing was changed.')
    void decideApproval(pendingApproval.id, 'rejected', input.token)
  }, [pendingApproval, input.token])

  /* Everything the ledger holds has happened, except the gate — which is the
     one beat that is waiting rather than done. The timeline is a snapshot of
     work already reported, so there is nothing here to reveal on a cursor; each
     step says for itself whether it is still open. */
  const liveState: RunState = {
    played: liveBeats
      .map((_, index) => index)
      .filter(index => index !== gate),
    gate,
    declined,
    finished: !running,
    elapsed,
  }

  const exchanges = prompt === null
    ? settled
    : [...settled, {
      id: runExchangeId(startedAt.current),
      prompt,
      beats: liveBeats,
      state: liveState,
      ...(error ? { error } : {}),
    }]

  return {
    exchanges,
    title,
    loading,
    liveLabel: running ? timeline?.liveLabel ?? null : null,
    running,
    approve,
    decline,
    stopRun,
    send,
    error,
  }
}
