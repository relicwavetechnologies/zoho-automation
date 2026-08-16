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
 * in the open, governed tools apply the same backend policy, and what comes
 * back is an answer rather than a wall of rows.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { Navigate, useParams } from 'react-router-dom'
import { Composer } from './chat/composer'
import { useDecisions } from './data/use-decisions'
import { firstOpen } from './decisions/decision'
import { DecisionCard } from './decisions/decision.view'
import { Say } from './chat/answer/answer.view'
import { PiTraceTimeline } from './chat/trace'
import { PinSpacer } from './chat/pin'
import { DropVeil, SentChips, useAttachments, useDropGuard, useFileDrop } from './chat/attach.view'
import { CopyButton } from './chat/copy'
import { clearHandoff, peekHandoff } from './chat/handoff'
import { useThreadRun, type Exchange } from './chat/live'
import { PlanPanel } from './chat/plan.view'
import { LoadEarlier, ThreadSkeleton } from './chat/loading.view'
import {
  isThreadId, newThreadId, renameThread, threadRenamed, threadStarted, threadsChanged,
} from './chat/threads'
import { generateThreadTitle } from './chat/title'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { ArtifactWorkspace } from './artifacts/panel'
import { restoreThreadArtifacts } from './artifacts/open'
import { setOpen, useArtifacts } from './artifacts/store'
import { EXAMPLES } from './chat/examples'
import { ToolMark } from './chat/tools'
import { reconcileModelSelection, useChatModelChoice, type ModelSelection } from './chat/model-choice'
import '@/styles/beautiful.css'

/**
 * `/chat` is not a page, it is a request for a new one.
 *
 * Minting the id here and redirecting means every conversation — including the
 * one you have not typed into yet — has an address. `replace` so that Back
 * leaves the chat rather than bouncing off `/chat` into a second new thread.
 *
 * That makes `/chat` the one place a thread id comes into being, which is why
 * the sidebar's New chat and the delete-the-open-chat path both just navigate
 * here rather than minting their own. Two call sites minting is two copies of
 * one rule.
 */
export function WorkspaceChat() {
  const { threadId } = useParams<{ threadId: string }>()
  /* Keyed on the thread rather than on the mount, and that is the whole
     correctness of this component.

     Both `/chat` and `/chat/:threadId` render this same element at the same
     position in the tree, so React reconciles instead of remounting when the
     match flips between them — the instance, and everything memoised in it,
     survives. With `[]` the id was therefore minted once per page load and then
     never again: opening a chat consumed it, and New chat afterwards redirected
     to the thread the reader was already in. It looked like a dead button, and
     a reload "fixed" it exactly once.

     `threadId` changes on every arrival at `/chat` from somewhere else, so this
     mints exactly when a new thread is actually being asked for, and stays
     stable across the renders that redirect — which is what stops it looping. */
  const minted = useMemo(newThreadId, [threadId])
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
  const modelChoice = useChatModelChoice()
  /* What this conversation produced before today. Restored into the panel's
     tabs but not shown: a reader opening last week's thread came back for the
     conversation, and a panel that springs out at them is answering a question
     they did not ask. The header's control is how they ask it. */
  useEffect(() => { void restoreThreadArtifacts(threadId, token) }, [threadId, token])
  const [draft, setDraft] = useState('')
  /* Whether the thread has been scrolled at all — the header's hairline is
     drawn only when something is genuinely passing under it. */
  const [scrolled, setScrolled] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)

  const column = useRef<HTMLDivElement>(null)

  /* Files waiting to go with the next message, wherever they came from. Held by
     the screen rather than the composer because the screen is what knows a run
     actually started, which is the only moment they may be cleared. */
  const attach = useAttachments()
  const { over, dropProps } = useFileDrop(attach.add)
  useDropGuard()

  const live = useThreadRun({ threadId, token })

  /* What Divo is waiting to hear from this person.
     
     Polled rather than pushed. A decision always ends the turn that raised it —
     the tool returns "waiting on somebody" and the model wraps up — so the
     moment worth catching is a run finishing, and a poll catches that within a
     few seconds without a second event channel to keep honest. It also catches
     the case a push never would: the same question being answered on a Lark
     card while this thread sits open, which has to make the card here go away. */
  const decisions = useDecisions({ poll: 15_000 })
  /* Only what this thread raised. `awaitingMe` is everything in the company
     waiting on this person, which for a manager is mostly other people's Lark
     approvals — showing those here replaced the composer of every thread they
     opened, and there was no way to type until each was dismissed. */
  const asking = firstOpen(decisions.awaitingMe, threadId)
  const [deferred, setDeferred] = useDeferredDecisions()
  const open = asking && !deferred.includes(asking.id) ? asking : null
  /* A run that has just stopped is the likeliest moment for a new question. */
  useEffect(() => { if (!live.running) void decisions.refresh() }, [live.running])
  /**
   * Reading upward, without the page moving underneath.
   *
   * Prepending an earlier page adds height above whatever the reader is looking
   * at, and a scroller left alone keeps its *offset* rather than its content —
   * so the line being read jumps down by however much arrived. The height
   * before the page lands is recorded here and the difference added back once
   * it has, in a layout effect so it happens before anything is painted.
   */
  /* Whether the reader is parked at the newest message. Read by the follow
     below, and cleared by hand when they ask to look at older ones. */
  const atBottom = useRef(true)
  const anchor = useRef<number | null>(null)
  const readEarlier = () => {
    anchor.current = scroller.current?.scrollHeight ?? 0
    /* Stop following the bottom. Three things move this scroller — the pin on
       send, the follow-the-bottom observer, and this restore — and the observer
       is the one that would win: it fires after layout, when the column has
       grown by a whole page. A reader at the bottom of a short thread who asked
       to read upward would be thrown straight back down.

       Cleared rather than suspended, because it is also just true: somebody who
       has asked for older messages is not reading the newest one. The scroll
       handler recomputes it the moment they move. */
    atBottom.current = false
    void live.loadEarlier()
  }
  useLayoutEffect(() => {
    const node = scroller.current
    if (anchor.current === null || !node) return
    node.scrollTop += node.scrollHeight - anchor.current
    anchor.current = null
  })

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
        /* The rail is told directly rather than waiting for the renamed row to
           come back. Both places show a chat's name at once, and until this the
           header switched to the real name while the rail went on showing the
           raw ask for the length of the round trip. */
        threadRenamed(threadId, title)
        /* Written through to the server so the name outlives this tab, and
           announced so the rail stops showing the truncated one. A failed write
           costs the stored name, not the one on screen. */
        void renameThread(threadId, title, token).then(threadsChanged)
      })
  }

  /* `files` is a parameter with a default rather than always the composer's,
     because the handoff carries its own: they arrive with the prompt from Home
     and were never in this screen's attachment state, so reading that state
     here would send the message without them. */
  const begin = (
    text: string,
    files: readonly File[] = attach.files,
    selected: ModelSelection | null = modelChoice.selection,
  ) => {
    const trimmed = text.trim()
    if (!trimmed || !selected) return
    // Armed only if a run genuinely started. A send declined because one is
    // already open would otherwise leave the pin armed, to fire against
    // whatever exchange happens to appear next.
    const started = sendRef.current(trimmed, files, selected)
    pinNext.current = started
    if (!started) return
    // Only once the run is real. Clearing on the attempt would throw away the
    // files a declined send never carried, and the person would have to find
    // and drag them again.
    attach.clear()
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
    if (handedOff.current || !handoff.prompt || !token || live.loading) return
    // Home already fetched and staged an allowed pair. Do not put the same
    // model-options request on this route change's critical path; the runtime
    // and proxy still re-check the pair before inference. An older handoff with
    // no pair waits for this screen's catalogue and takes its reconciled choice.
    const selected = handoff.modelSelection ?? reconcileModelSelection(
      modelChoice.models,
      modelChoice.selection,
    )
    if (!selected && modelChoice.loading) return
    if (!selected) return
    handedOff.current = true
    clearHandoff()
    /* Through the same door as a send typed here, so a message carried over from
       Home pins exactly as it would have if it had been typed on this page. */
    begin(handoff.prompt, handoff.files, selected)
    // `begin` intentionally stays outside the dependency list; the handoff is
    // one-shot, while the catalogue fields are the values that can unblock an
    // older handoff which carried no model pair.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff, token, live.loading, modelChoice.loading, modelChoice.models, modelChoice.selection])

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
     they leave the bottom.

     Driven by the column actually growing rather than by a render. Keyed on the
     exchanges array it ran on every render instead — the array was rebuilt each
     time — so a reader scrolling up inside the last 80 pixels was dragged back
     down several times a second and the thread felt stuck to its own bottom.
     A ResizeObserver fires when there is genuinely more to see, which is the
     only moment following is wanted. */
  useEffect(() => {
    const node = scroller.current
    const list = column.current
    if (!node || !list) return
    const follow = () => { if (atBottom.current) node.scrollTop = node.scrollHeight }
    const observer = new ResizeObserver(follow)
    observer.observe(list)
    return () => observer.disconnect()
  }, [])

  /* The name we just wrote wins, then the server's, then the opening ask —
     which is the last resort rather than the default it used to be. Printing
     the raw ask put a whole sentence in the bar, and a bar wide enough for a
     sentence is a bar that reads as a heading for the page. */
  const title = named || live.title || live.exchanges[0]?.prompt || 'New chat'
  const empty = !live.loading && live.exchanges.length === 0

  return (
    /* The split wraps the conversation rather than the app, because a document
       is beside *this* conversation. The panel is empty and takes no width until
       a run files something, so an ordinary chat is laid out exactly as before. */
    <ArtifactWorkspace>
    {/* The drop target is the whole conversation, composer included. A file is
        being given to Divo rather than typed into a field, so anywhere you can
        see the chat is somewhere you can let go of it. */}
    <div className="bui-scope relative flex h-full min-h-0 flex-col bg-canvas" {...dropProps}>
      <DropVeil visible={over} />
      {/* Over the conversation, not in it. The work log answers "what has it
          done"; this answers "how far through is it", and an answer that
          scrolls away with the thread is one you have to go looking for.

          Rendered only while there is a plan, which is only while a run that
          declared one is going — so most conversations never see it, which is
          the point. `live.plan` is null the rest of the time. */}
      {live.plan && <PlanPanel plan={live.plan} />}
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
          {/* Three states, not two. A thread being read is not an empty one,
              and drawing nothing for it made a slow read look like a chat with
              nothing in it — see `loading.view.tsx`. */}
          {live.loading && live.exchanges.length === 0 ? (
            <ThreadSkeleton />
          ) : empty ? (
            <Welcome onPick={start} />
          ) : (
            <>
              {live.hasEarlier && (
                <LoadEarlier loading={live.loadingEarlier} onLoad={readEarlier} />
              )}
              {live.exchanges.map((exchange) => (
                <Exchanged
                  key={exchange.id}
                  exchange={exchange}
                  /* Only the exchange that is still running has any use for it,
                     and handing the same changing string to every exchange in
                     the thread would defeat the memo on all of them — a new
                     label per tool call would redraw the whole conversation. */
                  liveLabel={exchange.state.finished ? null : live.liveLabel}
                />
              ))}
            </>
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

      <div className="shrink-0 bg-canvas">
        <div className="mx-auto w-full max-w-[720px] px-5 py-3">
          {/* The composer's place, taken by the question.

              Swapped rather than stacked above it, and that is the point: a
              banner over a live text box says "when you get a minute", and this
              says the true thing — nothing else is going to happen here until
              you answer. Putting it aside is still allowed, and the request
              stays open on the Approvals page either way. */}
          {open ? (
            <DecisionCard
              decision={open}
              sending={decisions.sending === open.id}
              onDismiss={() => setDeferred(open.id)}
              onSend={(answer) => void decisions.settle(open.id, answer)}
            />
          ) : (
          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={() => start(draft)}
            placeholder={empty ? 'Ask Divo to do something' : 'Ask a follow up'}
            autoFocus={empty}
            running={live.running}
            onStop={live.stopRun}
            models={modelChoice.models}
            modelSelection={modelChoice.selection}
            onModelChange={modelChoice.selectModel}
            onReasoningEffortChange={modelChoice.selectReasoningEffort}
            modelLoading={modelChoice.loading}
            files={attach.files}
            rejected={attach.rejected}
            onAttach={attach.add}
            onRemoveFile={attach.remove}
          />
          )}
        </div>
      </div>
    </div>
    </ArtifactWorkspace>
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
  const { tabs, open } = useArtifacts()
  return (
    <header
      className={`ws-chat-head sticky top-0 z-10 shrink-0 bg-veil backdrop-blur-md transition-[border-color] duration-200 ${
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
        {/* The only way back to a document once the panel has been closed, and
            the only sign that a thread produced one at all. Absent when there is
            nothing to show, so an ordinary conversation carries no control for a
            thing it never made. */}
        {tabs.length > 0 && !open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-control px-2 py-1 text-[12px] text-ink-3 transition-colors hover:bg-fill hover:text-ink"
          >
            <FileText size={13} />
            {tabs.length === 1 ? '1 document' : `${tabs.length} documents`}
          </button>
        )}
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
        {EXAMPLES.map((item, i) => (
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
/**
 * One ask and everything that came of it.
 *
 * Memoised, and it is not a micro-optimisation: a thread is a list of finished
 * exchanges with at most one live one, and every frame of a live run used to
 * re-render all of them — re-splitting their traces, re-coalescing their
 * bursts, and reparsing the markdown of every answer above. Settled exchanges
 * hold their identity, so now they are drawn once and left alone.
 */
const Exchanged = memo(function Exchanged({
  exchange, liveLabel,
}: {
  exchange: Exchange
  /** What the run says it is doing. Null once it has settled. */
  liveLabel?: string | null
}) {
  const { prompt, trace, answer, state } = exchange

  return (
    /* The id is what a just-sent prompt is pinned by. It has to sit on a direct
       child of the thread column, because that is where the spacer looks. */
    <div data-exchange-id={exchange.id} className="flex flex-col gap-5">
      {prompt && (
        /* The bubble and its control are one group, so hovering anywhere on
           your own message offers the copy — aiming at a 24px target that only
           appears once you are already on it is a worse trade than it sounds. */
        <div className="group flex flex-col items-end gap-0.5 pl-16">
          {/* Above the words, where the composer had them. A file attached to a
              question is context for it, and a reader scanning back for "the
              message I sent the contract with" is looking for the file. */}
          {exchange.attachments && <SentChips files={exchange.attachments} />}
          <p className="rounded-card bg-field px-3 py-2 text-[13.5px] leading-[1.5] text-ink">
            {prompt}
          </p>
          <CopyButton text={prompt} />
        </div>
      )}

      <div className="flex flex-col gap-3">
        <PiTraceTimeline
          steps={trace}
          streaming={!state.finished}
          startedAt={state.startedAt}
          elapsed={state.elapsed}
          liveLabel={liveLabel}
        />

        {answer && <Say text={answer} streaming={!state.finished} />}

        {exchange.error && (
          <p className="text-[13px] text-rose-600 dark:text-rose-400">{exchange.error}</p>
        )}
      </div>
    </div>
  )
})

/**
 * Decisions the reader has put aside, for as long as the tab is open.
 *
 * In `sessionStorage` rather than component state because `ChatThread` is keyed
 * on the thread id: leaving a conversation and coming back remounts it, and a
 * dismissal held in `useState` came straight back with it. Not `localStorage` —
 * putting a question aside is a "not this minute", not a decision that should
 * still be in force next week.
 */
const DEFERRED_KEY = 'divo.decisions.deferred'

function useDeferredDecisions(): [string[], (id: string) => void] {
  const [ids, setIds] = useState<string[]>(() => {
    try {
      const raw = window.sessionStorage.getItem(DEFERRED_KEY)
      return raw ? (JSON.parse(raw) as string[]) : []
    } catch {
      return []
    }
  })
  const defer = useCallback((id: string) => {
    setIds((prev) => {
      if (prev.includes(id)) return prev
      const next = [...prev, id]
      try { window.sessionStorage.setItem(DEFERRED_KEY, JSON.stringify(next)) } catch { /* private mode */ }
      return next
    })
  }, [])
  return [ids, defer]
}
