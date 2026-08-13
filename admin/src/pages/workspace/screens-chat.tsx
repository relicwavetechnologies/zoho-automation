/**
 * `/chat/:threadId` — Divo as a conversation, on the web.
 *
 * Typing here runs the real agent: the same container, the same skills, the
 * same permission checks a Lark message goes through. `useThreadRun` drives it.
 *
 * It used to play three scripted transcripts on a timer, because there was no
 * backend to call. The seam turned out to be exactly as narrow as it was
 * written to be — the hook returns a transcript and a cursor over it, and not
 * one component below changed when the stream replaced the timer. What is left
 * of the scripts is their three prompts, on the empty state, where they are
 * suggestions rather than performances.
 *
 * The thread id in the path is the second thing that had to be true. Before it,
 * the conversation existed only inside this component: leaving the page ended
 * the run, coming back showed nothing, and a second chat alongside the first was
 * not expressible. A URL fixes all three, because it is the one piece of state
 * the browser already knows how to keep.
 *
 * It exists because the admin only ever showed the operational half of Divo —
 * runs, cost, approvals after the fact — and never the thing people actually
 * do with it. The shape is the one Lark already has: you ask, the work happens
 * in the open, Divo stops before it writes anything, and what comes back is an
 * answer rather than a wall of rows.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { Chart } from './chat/charts'
import { Approval, Artifact, Composer, Preview, Say } from './chat/parts'
import { splitTrace } from './chat/lifecycle'
import { PiTraceTimeline } from './chat/trace'
import { PinSpacer } from './chat/pin'
import { useThreadRun, type Exchange } from './chat/live'
import {
  isThreadId, newThreadId, renameThread, threadStarted, threadsChanged,
} from './chat/threads'
import { generateThreadTitle } from './chat/title'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { TRANSCRIPTS } from './chat/transcripts'
import { ToolMark } from './chat/tools'
import '@/styles/beautiful.css'

/** The prompt Home hands over when somebody types there and hits send. */
const HANDOFF_KEY = 'divo.chat.pendingPrompt'

/**
 * Read the prompt Home staged, without consuming it.
 *
 * Reading and clearing in one step looked tidier and silently lost the handoff:
 * StrictMode mounts a component, unmounts it, and mounts it again, so the first
 * mount took the value and the second — the one that survives — found an empty
 * key and rendered a blank composer. The clear now happens at the only moment
 * that proves the prompt arrived somewhere, which is when the run starts.
 */
function peekHandoff() {
  try {
    return window.sessionStorage.getItem(HANDOFF_KEY) ?? ''
  } catch {
    /* private mode — no handoff, just an empty composer */
    return ''
  }
}

function clearHandoff() {
  try {
    window.sessionStorage.removeItem(HANDOFF_KEY)
  } catch { /* private mode — nothing was stored to begin with */ }
}

/**
 * `/chat` is not a page, it is a request for a new one.
 *
 * Minting the id here and redirecting means every conversation — including the
 * one you have not typed into yet — has an address. `replace` so that Back
 * leaves the chat rather than bouncing off `/chat` into a second new thread.
 */
export function WorkspaceChat() {
  const { threadId } = useParams<{ threadId: string }>()
  const minted = useMemo(newThreadId, [])
  if (!isThreadId(threadId)) {
    return <Navigate to={`/chat/${minted}`} replace />
  }
  // Keyed on the thread so switching conversations remounts rather than
  // reconciling: two threads share no state worth carrying across, and a
  // half-carried one shows the previous chat's scroll position and draft.
  return <ChatThread key={threadId} threadId={threadId} />
}

function ChatThread({ threadId }: { threadId: string }) {
  const handoff = useMemo(peekHandoff, [])
  const { token } = useAdminAuth()
  const [draft, setDraft] = useState('')
  /* Whether the thread has been scrolled at all — the header's hairline is
     drawn only when something is genuinely passing under it. */
  const [scrolled, setScrolled] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)

  const live = useThreadRun({ threadId, token })
  /* `send` is rebuilt whenever the run's state changes, so depending on it
     directly would re-run the handoff effect on every frame of a live run. */
  const sendRef = useRef(live.send)
  sendRef.current = live.send

  /* A prompt typed on Home continues here rather than being dropped at the
     door: the reader already asked, and showing them an empty composer would
     make the handoff read as a page change instead of the same request
     carrying on.
     Waits for `token` and for the thread's history, because the run cannot
     start without one and must not start before the other — sending mid-load
     would have the reply land under a transcript that arrives after it. */
  /* Set by a send, read by the effect that pins. A flag rather than a guess at
     which exchange looks new: a thread joined mid-run also grows an exchange
     the moment its history lands, and pinning that one would yank the scroll
     of somebody who has merely reopened the page. This is only ever true
     because a person on this screen pressed send. */
  const pinNext = useRef(false)

  /* The name this chat gets written the moment it is started, replacing the
     truncated first message the server derives. Held here rather than read back
     from the thread so the rail and this bar change at the same time. */
  const [named, setNamed] = useState<string | null>(null)
  const namedOnce = useRef(false)
  const titleAbort = useRef<AbortController | null>(null)
  useEffect(() => () => titleAbort.current?.abort(), [])

  /**
   * Name the conversation from its opening ask.
   *
   * Only on the first thing said in a thread, and only once. The desktop guards
   * the same moment with two metadata flags because its send path can be
   * re-entered; this one cannot, so "there was nothing here before" is the whole
   * condition. A later rename is therefore never overwritten — nothing runs to
   * overwrite it.
   */
  const nameThread = (text: string) => {
    if (namedOnce.current || live.exchanges.length > 0 || !token) return
    namedOnce.current = true
    const controller = new AbortController()
    titleAbort.current = controller
    void generateThreadTitle({ threadId, prompt: text, token, signal: controller.signal })
      .then(title => {
        if (!title || controller.signal.aborted) return
        setNamed(title)
        /* Written through to the server so the name outlives this tab, and
           announced so the rail stops showing the truncated one. A failed write
           costs the stored name, not the one on screen. */
        void renameThread(threadId, title, token).then(threadsChanged)
      })
  }

  const begin = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // Armed only if a run genuinely started. A send declined because one is
    // already open would otherwise leave the pin armed, to fire against
    // whatever exchange happens to appear next.
    const started = sendRef.current(trimmed)
    pinNext.current = started
    if (!started) return
    nameThread(trimmed)
    /* The chat now exists, whatever the server thinks. It is created by the run
       that was just asked for, so for the length of that round trip this is the
       only place that knows — and the rail is where a person looks to see that
       their question landed somewhere. Named with the ask until the real name
       arrives, which is the same thing the server would derive anyway. */
    threadStarted(threadId, trimmed)
  }

  const handedOff = useRef(false)
  useEffect(() => {
    if (handedOff.current || !handoff || !token || live.loading) return
    handedOff.current = true
    clearHandoff()
    /* Through the same door as a send typed here, so a prompt carried over from
       Home pins exactly as it would have if it had been typed on this page. */
    begin(handoff)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff, token, live.loading])

  const start = (text: string) => {
    if (!text.trim()) return
    setDraft('')
    begin(text)
  }

  /* Which message is held at the top, and the send that put it there.
     The id is taken from the exchange once it exists rather than minted at send
     time, so the pin can never name something that is not on screen. */
  const [pin, setPin] = useState<{ id: string; nonce: number }>({ id: '', nonce: 0 })
  const lastExchangeId = live.exchanges[live.exchanges.length - 1]?.id ?? ''
  useEffect(() => {
    if (!pinNext.current || !lastExchangeId) return
    pinNext.current = false
    setPin(current => ({ id: lastExchangeId, nonce: current.nonce + 1 }))
  }, [lastExchangeId])

  /* Follow the run down the page while it works, and only then. Scrolling a
     reader who has deliberately gone back up to re-read something is the most
     reliably irritating thing a chat surface can do, so this stops the moment
     they leave the bottom. */
  const atBottom = useRef(true)
  useEffect(() => {
    if (!atBottom.current) return
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [live.exchanges])

  /* The name we just wrote wins, then the server's, then the opening ask —
     which is the last resort rather than the default it used to be. Printing
     the raw ask put a whole sentence in the bar, and a bar wide enough for a
     sentence is a bar that reads as a heading for the page. */
  const title = named || live.title || live.exchanges[0]?.prompt || 'New chat'
  const empty = !live.loading && live.exchanges.length === 0

  return (
    <div className="bui-scope flex h-full min-h-0 flex-col bg-page">
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const node = e.currentTarget
          setScrolled(node.scrollTop > 4)
          atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
        }}
      >
        <Header title={title} scrolled={scrolled} />
        <div ref={column} className="mx-auto flex w-full max-w-[720px] flex-col gap-8 px-5 pb-6">
          {empty ? (
            <Welcome onPick={start} />
          ) : (
            live.exchanges.map((exchange) => (
              <Exchanged
                key={exchange.id}
                exchange={exchange}
                liveLabel={live.liveLabel}
                onApprove={live.approve}
                onDecline={live.decline}
              />
            ))
          )}
        </div>
        {/* After the column, not in it — see `pin.tsx`. */}
        <PinSpacer
          scroller={scroller}
          column={column}
          pinId={pin.id || null}
          nonce={pin.nonce}
        />
      </div>

      <div className="shrink-0 bg-page">
        <div className="mx-auto w-full max-w-[720px] px-5 py-3">
          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={() => start(draft)}
            placeholder={empty ? 'Ask Divo to do something' : 'Ask a follow up'}
            autoFocus={empty}
            running={live.running}
            onStop={live.stopRun}
          />
        </div>
      </div>
    </div>
  )
}

/* ── Header ───────────────────────────────────────────────
   The conversation's own name, on a bar the thread scrolls under.

   What was here before was a scenario switcher and a Replay control — three
   scripted stories and a way to re-run them. Useful while there was no backend;
   noise the moment there was one, because none of it referred to anything the
   reader had done. A header should say where you are, and "Inbox → Sheet" said
   where a demo was.

   Translucent with a blur rather than opaque: the thread passing underneath is
   what tells you the page is scrolled, and a solid bar cuts it off flat. The
   hairline underneath only appears once something is actually under it —
   drawn at rest it is a border around nothing.

   The name appears on the same condition, and for a related reason. At the top
   of a thread it sits directly above the message it was taken from, so a short
   ask reads as "hi" printed twice, one line apart. A header names what you can
   no longer see; while you can see it, there is nothing to name.

   Stop is not here. It briefly was, and it was in the wrong place: while a run
   is going, ending it is the only thing you want, and it belongs under your
   hand rather than at the far edge of the screen. It is the composer's send
   control now, the way a recorder's button becomes stop while recording.

   Delete is not here either, and for the same kind of reason. It applied to the
   page it was drawn on, sat beside no other action, and on a thread one line
   long it was the loudest thing on screen — an offer to throw the work away,
   read before the work. It belongs on the chat's row in the rail, where it is
   one of the things you can do to a chat among several, and where the chat is
   an object rather than the place you are standing. */
function Header({ title, scrolled }: { title: string; scrolled: boolean }) {
  return (
    <header
      className={`ws-chat-head sticky top-0 z-10 shrink-0 bg-page/70 backdrop-blur-md transition-[border-color] duration-200 ${
        scrolled ? 'border-b border-line' : 'border-b border-transparent'
      }`}
    >
      {/* Flush to the pane, not to the thread. The bar used to borrow the
          conversation's own 720px column, which centred the name in the window
          and left it floating in the middle of the screen with nothing under
          it — on a wide display it read as a caption for whatever happened to
          be beneath it. A title belongs in the corner of the thing it names. */}
      <div className="flex w-full items-center gap-3 px-5 py-2.5">
        {/* Capped, not just truncated. `flex-1` alone let a name run the full
            width of a 27" display, at which point it stops reading as a label
            on a chat and starts reading as the page's heading. A name that
            needs more than this much room is not a name. */}
        <span
          className={`min-w-0 max-w-[46ch] truncate text-[13px] font-medium text-ink transition-opacity duration-200 ${
            scrolled ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {title}
        </span>
      </div>
    </header>
  )
}

/* ── Welcome ──────────────────────────────────────────────
   No hero copy and no feature grid. Three things Divo does, each showing the
   apps it touches, because that is the only claim worth making before it has
   done anything. */
function Welcome({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex flex-col gap-4 pt-8">
      <div>
        <h1 className="text-[19px] font-semibold tracking-[-0.015em] text-ink">
          What should Divo do?
        </h1>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
          Ask in your own words. Divo works in the open, stops before it writes anything, and
          hands back a file rather than a wall of rows.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        {TRANSCRIPTS.map((item, i) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onPick(item.prompt)}
            className="group flex items-center gap-3 rounded-card bg-surface p-3 text-left shadow-hairline transition-[background-color,box-shadow] duration-150 hover:bg-fill hover:shadow-btn"
            style={{ animation: `bui-fade-up 380ms cubic-bezier(0.23,1,0.32,1) ${i * 70}ms both` }}
          >
            {/* One mark — the app the run ends in. The full set was three
                logos per row across three rows, which read as a logo wall. */}
            <ToolMark name={item.apps[item.apps.length - 1]} size={16} />
            <span className="min-w-0 flex-1 text-[13px] leading-snug text-ink">{item.prompt}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ── Exchange ─────────────────────────────────────────────
   One ask and everything that came of it, in two parts and no more: the run's
   own trace, and what it handed back. `PiTraceTimeline` owns the first and this
   knows nothing about what is inside it — which is the whole point of the port.
   The arrangement of steps used to be decided here, and separately again inside
   the log, and the two disagreed: a burst ended up nested inside the log's own
   fold, so reading one tool call meant opening two disclosures.

   A thread is a list of these, which is the change that made this a chat. It
   used to draw exactly one, and sending a follow-up overwrote it — so the
   surface could hold a conversation only for as long as the conversation was
   one sentence long. */
function Exchanged({
  exchange, liveLabel, onApprove, onDecline,
}: {
  exchange: Exchange
  /** What the run says it is doing. Null once it has settled. */
  liveLabel?: string | null
  onApprove: () => void
  onDecline: () => void
}) {
  const { prompt, beats, state } = exchange
  const seen = new Set(state.played)
  /* Everything that happened on the way is the trace; everything else stays in
     the conversation, in the order the run put it there. */
  const { trace, rest } = splitTrace(beats)

  return (
    /* The id is what a just-sent prompt is pinned by. It has to sit on a direct
       child of the thread column, because that is where the spacer looks. */
    <div data-exchange-id={exchange.id} className="flex flex-col gap-5">
      {prompt && (
        <div className="flex justify-end pl-16">
          <p className="rounded-card bg-field px-3 py-2 text-[13.5px] leading-[1.5] text-ink">
            {prompt}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <PiTraceTimeline
          steps={trace}
          streaming={!state.finished}
          awaitingApproval={state.gate !== null}
          elapsed={state.elapsed}
          declined={state.declined !== null}
          liveLabel={liveLabel}
        />

        {rest.map(({ beat, index }) => {
          if (beat.t === 'approve') {
            return (
              <Approval
                key={index}
                beat={beat}
                onApprove={onApprove}
                onDecline={onDecline}
                answered={state.declined ? 'declined' : seen.has(index) ? 'approved' : null}
              />
            )
          }
          if (beat.t === 'say') {
            return (
              <Say
                key={index}
                text={beat.text}
                streaming={!state.finished && beat.narration !== true}
              />
            )
          }
          if (beat.t === 'block') {
            const { block } = beat
            if (block.kind === 'table') return <Preview key={index} block={block} />
            if (block.kind === 'artifact') return <Artifact key={index} block={block} />
            return <Chart key={index} block={block} />
          }
          return null
        })}

        {state.declined && (
          <p className="rounded-card bg-inset px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2 shadow-hairline">
            {state.declined}
          </p>
        )}

        {exchange.error && (
          <p className="text-[13px] text-rose-600 dark:text-rose-400">{exchange.error}</p>
        )}
      </div>
    </div>
  )
}
