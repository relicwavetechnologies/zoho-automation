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
import { Sparkles } from 'lucide-react'
import { Chart } from './chat/charts'
import {
  Approval, Artifact, Composer, PixelGrid, Preview, Say, Shimmer, Step,
} from './chat/parts'
import { elapsedLabel } from './chat/player'
import { useThreadRun, type Exchange } from './chat/live'
import { isThreadId, newThreadId } from './chat/threads'
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
  const handedOff = useRef(false)
  useEffect(() => {
    if (handedOff.current || !handoff || !token || live.loading) return
    handedOff.current = true
    clearHandoff()
    sendRef.current(handoff)
  }, [handoff, token, live.loading])

  const start = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setDraft('')
    live.send(trimmed)
  }

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

  const title = live.exchanges[0]?.prompt || 'New chat'
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
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8 px-5 pb-6">
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
      className={`sticky top-0 z-10 shrink-0 bg-page/70 backdrop-blur-md transition-[border-color] duration-200 ${
        scrolled ? 'border-b border-line' : 'border-b border-transparent'
      }`}
    >
      <div className="mx-auto flex w-full max-w-[720px] items-center gap-3 px-5 py-2.5">
        <span
          className={`min-w-0 flex-1 truncate text-[13px] font-medium text-ink transition-opacity duration-200 ${
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
   One ask and everything that came of it. The steps live in a collapsible work
   log above the answer; the answer and its results sit below, in the order the
   run produced them.

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
  /* A finished run folds its work log away. While it is going the log is the
     interesting part of the screen; once there is an answer, the answer is. */
  const [logOpen, setLogOpen] = useState(!state.finished)
  const wasFinished = useRef(state.finished)
  useEffect(() => {
    if (!wasFinished.current && state.finished) setLogOpen(false)
    wasFinished.current = state.finished
  }, [state.finished])

  const seen = new Set(state.played)

  /* A beat is on screen if it has played or is playing. Nothing is rendered
     ahead of the run — the reader never sees a result before it arrived. */
  const shown = beats
    .map((beat, index) => ({ beat, index }))
    .filter(({ index }) => seen.has(index) || state.live === index || state.gate === index)

  /* Grouped, not sorted by kind.
     Splitting the beats into "all steps" then "everything else" was wrong: the
     invoice run produces its ageing chart BEFORE it asks to send anything, and
     that layout printed the chart underneath the approval it was meant to
     inform. So consecutive steps collapse into one work-log block and every
     other beat stays exactly where the run put it. */
  const groups: ({ kind: 'log'; items: typeof shown } | { kind: 'beat'; item: typeof shown[number] })[] = []
  for (const item of shown) {
    if (item.beat.t === 'step') {
      const tail = groups[groups.length - 1]
      if (tail?.kind === 'log') tail.items.push(item)
      else groups.push({ kind: 'log', items: [item] })
    } else {
      groups.push({ kind: 'beat', item })
    }
  }

  const working = !state.finished && !state.declined
  const toolCount = shown.filter((s) => s.beat.t === 'step').length

  return (
    <div className="flex flex-col gap-5">
      {prompt && (
        <div className="flex justify-end pl-16">
          <p className="rounded-card bg-field px-3 py-2 text-[13.5px] leading-[1.5] text-ink">
            {prompt}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {/* Run header — the one place that says whether work is happening. */}
        <button
          type="button"
          aria-expanded={logOpen}
          onClick={() => setLogOpen((v) => !v)}
          className="-mx-1.5 flex w-fit items-center gap-2.5 rounded-control px-1.5 py-1 transition-colors duration-100 hover:bg-fill-strong"
        >
          {working ? (
            <>
              <PixelGrid />
              {/* The run's own words for what it is doing, falling back to a
                  generic verb only before the first frame arrives. */}
              <Shimmer>
                {state.gate !== null ? 'Waiting on you' : liveLabel || 'Working'}
              </Shimmer>
              <span className="font-mono text-[12px] text-ink-3 tabular-nums">
                {elapsedLabel(state.elapsed)}
              </span>
            </>
          ) : (
            <>
              <Sparkles size={14} className="text-ink-3" />
              <span className="text-[13px] font-medium text-ink-2">
                {state.declined
                  ? `Stopped after ${elapsedLabel(state.elapsed)}`
                  : `Worked for ${elapsedLabel(state.elapsed)}`}
              </span>
              {toolCount > 0 && (
                <span className="text-[12px] text-ink-3 tabular-nums">
                  {toolCount} {toolCount === 1 ? 'step' : 'steps'}
                </span>
              )}
            </>
          )}
        </button>

        {groups.map((group) => {
          if (group.kind === 'log') {
            return (
              <div
                key={`log:${group.items[0].index}`}
                className="grid transition-[grid-template-rows,opacity] duration-400"
                style={{
                  gridTemplateRows: logOpen ? '1fr' : '0fr',
                  opacity: logOpen ? 1 : 0,
                  transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
                }}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="flex flex-col gap-0.5">
                    {group.items.map(({ beat, index }) =>
                      beat.t === 'step' ? (
                        <Step key={index} beat={beat} live={state.live === index} />
                      ) : null,
                    )}
                  </div>
                </div>
              </div>
            )
          }

          const { beat, index } = group.item
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
          if (beat.t === 'say') return <Say key={index} text={beat.text} />
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
