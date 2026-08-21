/**
 * The thing you type in.
 *
 * Its own module, which it was not: 447 of `parts.tsx`'s 751 lines were this,
 * sharing a file with the answer renderer for no reason beyond the order they
 * were written in. The cost was not the line count — it was that the work-log
 * row imported the composer to get at a neighbour, so drawing a trace pulled in
 * a text field, two popup menus and a measurement mirror it can never use.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, ArrowUpRight, Check, ChevronDown, Plus } from 'lucide-react'
import { ToolMark, tool, type ToolKey } from './tools'
import { splitMentions } from './mentions'
import { tintFor } from './pebble'
import './pebble.css'
import './mentions.css'
import { FileChips, RejectionNote } from './attach.view'
import { namedForClipboard, type Rejection } from './attach'
import {
  reasoningEffortHint,
  reasoningEffortLabel,
  type ModelSelection,
  type SelectableModel,
} from './model-choice'

/* ── Composer ─────────────────────────────────────────────
   Ported from the library's PromptBar, and the geometry is the whole point.

   A pill while the prompt fits on one line, with the `+`, the model picker and
   send sitting INSIDE it on that same line. The moment the text outgrows the
   space between them, the field claims a row of its own and the controls drop
   beneath it, and the radius relaxes from a full pill to a rounded box. That
   transition is what makes it feel like a product rather than a form: the
   control is only ever as big as the thing being written in it.

   `@` opens the source picker over the connected apps — the menu grows upward
   from the composer's top edge, because there is nothing but composer below it.
   `+` attaches a file and does nothing else; it used to open that same picker
   with an attach row on top, which made the one control whose shape says "add
   something to this message" mostly a list of places to point the message at.

   Enter sends, Shift+Enter breaks the line. Not the place to be clever. */

/** The apps a prompt can be pointed at. Order is how often they are reached for. */
const SOURCES: { key: ToolKey; name: string; hint: string }[] = [
  { key: 'gmail', name: 'Gmail', hint: 'Threads, attachments, drafts' },
  { key: 'sheets', name: 'Google Sheets', hint: 'Read and write spreadsheets' },
  { key: 'drive', name: 'Google Drive', hint: 'Files and folders' },
  { key: 'calendar', name: 'Google Calendar', hint: 'Events and availability' },
  { key: 'zohoBooks', name: 'Zoho Books', hint: 'Invoices, bills, payments' },
  { key: 'zohoCrm', name: 'Zoho CRM', hint: 'Accounts, contacts, deals' },
  { key: 'lark', name: 'Lark', hint: 'Messages, tasks, calendar' },
  { key: 'airtable', name: 'Airtable', hint: 'Bases and records' },
  { key: 'semrush', name: 'Semrush', hint: 'Rankings and traffic' },
  { key: 'web', name: 'Web search', hint: 'Search and read pages' },
]

/* Stable identities for the empty case. A fresh `[]` in a default parameter is a
   new array on every render, which defeats every memo below it. */
const NO_FILES: readonly File[] = []
const NO_REJECTIONS: readonly Rejection[] = []

/**
 * How much of the type size an app's mark takes, as a fraction.
 *
 * Has to stay in step with `.cmp-mention-mark`'s `width` in `mentions.css`.
 * They are two halves of one number: the CSS reserves the slot, this fills it,
 * and when they disagreed the artwork overflowed its own pebble and sat low.
 */
const MARK_EM = 0.7

/** The `@token` under the caret, if the caret is inside one. */
function tokenAt(draft: string) {
  const at = draft.lastIndexOf('@')
  if (at === -1) return null
  const query = draft.slice(at + 1)
  /* A space closes the token — `@Gmail and also` is no longer picking a source. */
  if (/\s/.test(query)) return null
  return { query, start: at }
}

export function Composer({
  value, onChange, onSubmit, placeholder, autoFocus, running, onStop,
  models, modelSelection, onModelChange, onReasoningEffortChange, modelLoading, picksModel = true,
  files = NO_FILES, rejected = NO_REJECTIONS, onAttach, onRemoveFile,
  hero, actions,
}: {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  /**
   * How much of the landing geometry to wear, from 1 (a box you could write a
   * paragraph in) down to 0 (the compact bar).
   *
   * A number rather than a variant, because Home moves between the two as you
   * scroll and a variant would swap layouts mid-gesture — one composer
   * disappearing and another appearing where the reader was mid-sentence. Every
   * value between is a real state, so the same element simply gets smaller.
   *
   * Left off entirely by the chat surface, which is the bar and nothing else.
   * Passing it also pins the two-row arrangement, so shrinking never re-flows
   * the controls from under the field to beside it.
   */
  hero?: number
  /** Quick starts, above the field. Only drawn while there is room for them. */
  actions?: React.ReactNode
  models: readonly SelectableModel[]
  modelSelection: ModelSelection | null
  onModelChange: (model: string) => void
  onReasoningEffortChange: (effort: ModelSelection['reasoningEffort']) => void
  modelLoading?: boolean
  /**
   * Whether this composer chooses a model.
   *
   * Off for the signed-out landing, which has no session to read a model list
   * from. The picker would be a permanently disabled control reading
   * "Unavailable", and — worse — send is gated on having a model pair, so the
   * one control the page exists for would be dead. Sending there opens
   * onboarding rather than starting a run, so there is nothing for a model to
   * be chosen *for* until somebody is signed in.
   */
  picksModel?: boolean
  placeholder: string
  autoFocus?: boolean
  /** A run is going. The send control becomes the way to end it. */
  running?: boolean
  onStop?: () => void
  /**
   * Files this message will carry. Owned by the screen, not by the composer —
   * the screen is what clears them once a run has actually started, and a
   * composer holding its own copy would keep showing chips for a send that was
   * declined.
   */
  files?: readonly File[]
  rejected?: readonly Rejection[]
  onAttach?: (incoming: readonly File[]) => void
  onRemoveFile?: (index: number) => void
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const controls = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLSpanElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const modelBtn = useRef<HTMLButtonElement>(null)
  const modelMenu = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const root = useRef<HTMLDivElement>(null)

  const [measured, setMeasured] = useState(false)
  /* Landing geometry is always the two-row arrangement, at every size. The
     alternative is the controls hopping from beside the field to under it
     partway down a scroll, which is the one movement this whole design is
     built to avoid. */
  const expanded = hero !== undefined || measured
  /* The `@` picker, put away.
     Its open state is the draft — an `@token` under the caret — so "closed"
     cannot be the absence of a flag; it has to be one. Clicking away or
     pressing Escape sets this, and a fresh `@` clears it. */
  const [sourceDismissed, setSourceDismissed] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [active, setActive] = useState(0)

  const ready = value.trim().length > 0
  const canSend = ready && (modelSelection !== null || !picksModel)
  const model = models.find(candidate => candidate.id === modelSelection?.model)
  /*
   * The field's type size, as one number.
   *
   * It was spelled out three times — the mirror, the textarea, and the fallback
   * `text-[13px]` — and now a fourth thing depends on it: the app marks drawn
   * inside the text have to scale with the letters they sit among, because the
   * landing composer's font size is a function of how far Home has been
   * scrolled.
   */
  const fieldFontPx = hero === undefined ? 13 : 13 + 1.5 * hero
  /*
   * The mark, in pixels, at the same fraction of the type size the CSS slot
   * uses.
   *
   * Sized here rather than stretched by CSS because `BrandMark` writes its own
   * width and height as inline styles, and an inline style beats a stylesheet.
   * The old `> * { width: 100% }` rule silently lost that fight: the artwork
   * kept its natural 14px inside a 10.7px slot, overflowed the bottom, and sat
   * a pixel and a half below the centre of its own pebble.
   */
  const markPx = Math.round(fieldFontPx * MARK_EM)
  const runs = useMemo(() => splitMentions(value), [value])
  const token = tokenAt(value)
  const rows = useMemo(() => {
    const q = (token?.query ?? '').toLowerCase()
    return SOURCES.filter((s) => s.name.toLowerCase().includes(q))
  }, [token?.query])
  /* Typing an `@` is the only thing that opens it. `+` attaches a file and
     nothing else — see the button. */
  const menu = token !== null && !sourceDismissed

  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])

  useEffect(() => { setActive(0) }, [token?.query])

  /* A new `@` is a new question, so it reopens the picker even if the last one
     was dismissed. Keyed on where the token starts rather than on what has been
     typed into it: every keystroke changes the query, and reopening on those
     would make Escape last exactly one letter. */
  useEffect(() => { setSourceDismissed(false) }, [token?.start])

  /* Pointing at anything outside the composer puts the picker away.
     It used to stay open until the token stopped being one, so a menu could sit
     over the page while the reader had plainly gone somewhere else. `mousedown`
     rather than `click`, so it closes on the press instead of waiting to see
     what the press turns out to be. */
  useEffect(() => {
    if (!menu) return
    const dismissAway = (event: MouseEvent) => {
      if (root.current?.contains(event.target as Node)) return
      setSourceDismissed(true)
    }
    document.addEventListener('mousedown', dismissAway)
    return () => document.removeEventListener('mousedown', dismissAway)
  }, [menu])

  useEffect(() => {
    if (running) setModelOpen(false)
  }, [running])

  useEffect(() => {
    if (!modelOpen) return
    const dismissAway = (event: MouseEvent) => {
      const target = event.target as Node
      if (modelMenu.current?.contains(target) || modelBtn.current?.contains(target)) return
      setModelOpen(false)
    }
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setModelOpen(false)
      modelBtn.current?.focus()
    }
    document.addEventListener('mousedown', dismissAway)
    document.addEventListener('keydown', dismissWithKeyboard)
    return () => {
      document.removeEventListener('mousedown', dismissAway)
      document.removeEventListener('keydown', dismissWithKeyboard)
    }
  }, [modelOpen])

  /* Wrapped text takes a row of its own, then the field grows to a ceiling.
     Measured off a hidden mirror of the draft rather than off the textarea, so
     the decision to expand is made from the text's natural width instead of
     from a height that has already wrapped. */
  useLayoutEffect(() => {
    const el = input.current
    const bar = controls.current
    const gauge = measure.current
    /* The model picker is not required, and treating it as required was a real
       bug: a composer with `picksModel` off draws no picker, so this bailed on
       every pass and the field never got a height at all. It stayed at one CSS
       line while the text scrolled inside it. Its width is a term in the
       measurement, so it contributes nothing when it is not there. */
    if (!el || !bar || !gauge) return

    /* Nothing has been laid out yet, so every number below would be a
       fabrication. Bailing leaves the field at its CSS `min-height`, which is
       exactly one line — the right answer for a composer nobody has typed in.
       Measuring anyway wrote a garbage height that no later pass corrected,
       because the deps had not changed by the time layout was real. */
    if (bar.clientWidth === 0) return

    const fixed = 28 * 2 + (modelBtn.current?.offsetWidth ?? 0)
    const gaps = 4 * 3
    const inline = bar.clientWidth - fixed - gaps

    /* Two guards, both learned the hard way.

       An empty draft is never expanded — there is nothing to wrap, and
       measuring it measures the placeholder instead.

       And a non-positive `inline` means the row has not been laid out yet.
       Acting on that reading expands the bar on the very first pass, and
       because the expanded layout is what every later pass then measures, it
       latches: the composer opened two-rows-tall and stayed there forever. */
    const needsRow =
      value.length > 0
      && (value.includes('\n') || (inline > 0 && gauge.offsetWidth + 8 > inline))
    if (needsRow !== measured) setMeasured(needsRow)

    /* The landing field is tall before anything is typed — an empty box the
       size of a paragraph is an invitation, where one line is a search box.
       It gives that height up as the composer compresses, and from then on the
       floor is the same single line the chat bar has. */
    const MIN = 28 + Math.round(38 * (hero ?? 0))
    const MAX = 128
    if (!value) {
      /* An empty field is one line by definition. Measured, it would report
         the placeholder instead. */
      el.style.height = `${MIN}px`
      el.style.overflowY = 'hidden'
      return
    }
    el.style.height = '0px'
    const content = el.scrollHeight
    el.style.height = `${Math.min(Math.max(content, MIN), MAX)}px`
    el.style.overflowY = content > MAX ? 'auto' : 'hidden'
  }, [value, expanded, hero])

  const pickSource = (source: (typeof SOURCES)[number]) => {
    const head = token ? value.slice(0, token.start) : value
    onChange(`${head}@${source.name} `)
    input.current?.focus()
  }

  const send = () => {
    if (!canSend) return
    onSubmit()
  }

  const openPicker = () => {
    fileInput.current?.click()
  }

  /* Reading `files` off the event is what makes this work for a screenshot as
     well as for a copied file — the clipboard carries both under the same key,
     and a screenshot is the reason this exists. Left un-prevented when there
     are none, so ordinary text still pastes. */
  const paste = (event: React.ClipboardEvent) => {
    const pasted = Array.from(event.clipboardData?.files ?? [])
    if (pasted.length === 0 || !onAttach) return
    event.preventDefault()
    onAttach(pasted.map((file, index) => namedForClipboard(file, Date.now() + index)))
  }

  return (
    <div className="relative" ref={root}>
      {/* ── source menu — grows up from the composer's top edge ── */}
      {menu && rows.length > 0 && (
        <div
          className="absolute inset-x-0 bottom-full z-10 mb-2 max-h-[264px] overflow-y-auto rounded-card bg-surface p-1 shadow-overlay"
          style={{ animation: 'bui-pop-in 180ms cubic-bezier(0.23,1,0.32,1) both', transformOrigin: 'bottom center' }}
        >
          {rows.map((source, i) => (
            <button
              key={source.key}
              type="button"
              /* `mousedown` would blur the field before the click lands, which
                 closes the menu out from under the pointer. */
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pickSource(source)}
              className={`flex h-9 w-full items-center gap-2.5 rounded-control px-2 text-left transition-colors duration-100 ${
                i === active ? 'bg-fill' : ''
              }`}
            >
              {/* A 40px slot, not a square one. Zoho's mark is a wordmark and
                  at a legible height it is ~39px wide, so a square box let it
                  spill over its own label. Sized for the widest mark, every
                  row's text still starts on the same line. */}
              <span className="flex w-10 shrink-0 items-center justify-center">
                <ToolMark name={source.key} size={15} />
              </span>
              <span className="shrink-0 text-[12.5px] font-medium text-ink">{source.name}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">{source.hint}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── the bar ── */}
      {/* On the landing the box sits on a plate, with a tray under it — one
          object with two levels rather than a box and some buttons beneath it.
          The plate fades out as the composer compresses, so the chat-shaped bar
          it ends as is a single edge again. */}
      <div
        className={actions === undefined ? undefined : 'ws-comp-plate'}
        style={actions === undefined ? undefined : { ['--plate' as string]: hero ?? 1 }}
      >
      <div
        onClick={() => input.current?.focus()}
        className={`relative cursor-text border border-line bg-surface shadow-btn transition-[border-color] duration-150 focus-within:border-line-strong ${
          hero === undefined ? 'p-1.5' : ''
        } ${
          expanded || files.length > 0 ? 'rounded-[22px]' : 'rounded-full'
        }`}
        /* Interpolated rather than switched between two classes: every value
           in between is a frame somebody is looking at while they scroll. */
        style={hero === undefined ? undefined : {
          padding: `${6 + 5 * hero}px`,
          borderRadius: `${16 + 4 * hero}px`,
        }}
      >
        {/* Hidden mirror of the draft — its natural width decides the layout. */}
        <span
          ref={measure}
          aria-hidden
          className="pointer-events-none invisible absolute whitespace-pre text-[13px] leading-[18px]"
        >
          {value}
        </span>

        {/* Reset before opening, so choosing the same file twice in a row still
            fires a change event — otherwise removing a file and re-picking it
            does nothing at all. */}
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onClick={(event) => { (event.target as HTMLInputElement).value = '' }}
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? [])
            if (picked.length > 0) onAttach?.(picked)
            input.current?.focus()
          }}
        />

        <FileChips files={files} onRemove={(index) => onRemoveFile?.(index)} />

        <div
          ref={controls}
          className={`grid items-end gap-x-1 gap-y-1.5 ${
            expanded ? 'grid-cols-[minmax(0,1fr)_auto_28px]' : 'grid-cols-[28px_minmax(0,1fr)_auto_28px]'
          }`}
        >
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            /* Straight to the picker. It used to open a menu whose first row
               was this and whose other ten were the apps — a list of places to
               point a sentence at, offered by a control that looks like "add
               something to this message". The apps are still reachable the way
               they always were, by typing `@`, which is where a mention
               belongs; the button does the one thing its shape promises. */
            onClick={() => { setModelOpen(false); openPicker() }}
            className={`flex size-7 shrink-0 items-center justify-center justify-self-start rounded-full text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-fill hover:text-ink active:scale-[0.94] ${
              expanded ? 'col-start-1 row-start-2' : 'col-start-1 row-start-1'
            }`}
          >
            <Plus size={16} />
          </button>

          {/*
            The box you type in, and the marks drawn behind it.

            Two elements at one position: a mirror that draws the draft with an
            app's logo where its `@` is, and the real textarea on top of it with
            its own letters turned transparent. Every keystroke, the caret and
            the selection stay with the textarea — only the drawing moves. See
            `mentions.css` for why nothing here may change a character's width.
          */}
          <div
            className={`cmp-field min-w-0 self-start ${
              expanded ? 'col-span-full col-start-1 row-start-1' : 'col-start-2 row-start-1'
            }`}
          >
            <div
              ref={mirror}
              aria-hidden
              className={`cmp-mirror px-1 py-[5px] leading-[18px] ${
                hero === undefined ? 'text-[13px]' : ''
              }`}
              style={hero === undefined ? undefined : { fontSize: `${13 + 1.5 * hero}px` }}
            >
              {runs.map((run, index) => (
                run.kind === 'text' ? (
                  <span key={index}>{run.text}</span>
                ) : (
                  <span
                    key={index}
                    className="pebble cmp-mention"
                    data-brand={tintFor(run.key) ? 'true' : undefined}
                    /* Carries the space after it, so the pebble has a right
                       side to pad with. See `mentions.css`. */
                    data-tail={run.text.endsWith(' ') ? 'true' : undefined}
                    /* The app's own colour, handed to CSS rather than mixed
                       here: the tint has to be blended against whichever theme
                       is on, and `color-mix` in the stylesheet knows that and
                       this does not. */
                    style={tintFor(run.key) ? { ['--pebble-brand' as string]: tintFor(run.key) } : undefined}
                  >
                    {run.key ? (
                      <span className="cmp-mention-mark">
                        <ToolMark name={run.key} size={markPx} />
                      </span>
                    ) : null}
                    <span className={run.key ? 'cmp-mention-at' : undefined}>@</span>
                    {run.text.slice(1)}
                  </span>
                )
              ))}
              {/* A draft ending in a newline leaves the mirror a line short:
                  a trailing line break collapses in flow, and the textarea's
                  does not. */}
              {value.endsWith('\n') ? '\u00a0' : null}
            </div>

            <textarea
            ref={input}
            rows={1}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onPaste={paste}
            onKeyDown={(event) => {
              if (menu && rows.length > 0) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  setActive((c) => (c + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length)
                  return
                }
                if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && token)) {
                  event.preventDefault()
                  pickSource(rows[active])
                  return
                }
              }
              if (event.key === 'Escape') {
                setSourceDismissed(true)
                setModelOpen(false)
                return
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                send()
              }
            }}
            /* A file with nothing asked of it is the one message guaranteed to
               be useless — Divo has been shown something and asked nothing, and
               answering it costs a whole turn to say so. Lark solves this by
               holding the file until the next message arrives; a composer holds
               it for free, so send stays off and the field says why. */
            placeholder={files.length > 0 && !ready
              ? `Ask about the attached file${files.length === 1 ? '' : 's'}`
              : placeholder}
            aria-label="Message Divo"
            onScroll={(event) => {
              /* The mirror has no scrollbar of its own; it follows. */
              if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop
            }}
            className={`cmp-input relative min-h-7 w-full min-w-0 resize-none bg-transparent px-1 py-[5px] leading-[18px] outline-none [overflow-wrap:anywhere] placeholder:text-ink-3 ${
              hero === undefined ? 'text-[13px]' : ''
            }`}
            style={hero === undefined ? undefined : { fontSize: `${13 + 1.5 * hero}px` }}
          />
          </div>

          {/* Left out entirely when there is no model to choose; see `picksModel`. */}
          {picksModel ? (
            /* The menu lives in the toggle's own cell and grows up from it, so
               it opens where the click was. Anchored to the composer's edge it
               drifted: the landing box is tall and wears a tray, so "above the
               composer" was half a screen from the control that opened it. */
            <div
              className={`relative ${expanded ? 'col-start-2 row-start-2' : 'col-start-3 row-start-1'}`}
            >
              <button
                ref={modelBtn}
                type="button"
                aria-expanded={modelOpen}
                aria-label="Choose model"
                disabled={running || modelLoading || models.length === 0}
                onClick={() => { setSourceDismissed(true); setModelOpen((v) => !v) }}
                className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[12px] font-medium text-ink-2 transition-colors duration-150 enabled:hover:bg-fill enabled:hover:text-ink disabled:opacity-60"
              >
                {model?.label ?? (modelLoading ? 'Loading…' : 'Unavailable')}
                {modelSelection && (
                  <span className="font-normal text-ink-3">
                    · {reasoningEffortLabel(modelSelection.reasoningEffort)}
                  </span>
                )}
                <ChevronDown size={11} className="text-ink-3" />
              </button>

              {modelOpen && (
                <div
                  ref={modelMenu}
                  className="absolute right-0 bottom-full z-10 mb-2 w-56 rounded-card bg-surface p-1 shadow-overlay"
                  style={{ animation: 'bui-pop-in 180ms cubic-bezier(0.23,1,0.32,1) both', transformOrigin: 'bottom right' }}
                >
                  <p className="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">
                    Model
                  </p>
                  {models.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => { onModelChange(candidate.id); input.current?.focus() }}
                      className="flex h-8 w-full items-center gap-2 rounded-control px-2 text-left transition-colors duration-100 hover:bg-fill"
                    >
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{candidate.label}</span>
                      <span className="shrink-0 text-[11px] text-ink-3">
                        {candidate.provider === 'deepseek'
                          ? 'DeepSeek'
                          : candidate.provider === 'openai'
                            ? 'OpenAI'
                            : candidate.provider}
                      </span>
                      <Check size={13} className={`shrink-0 text-ink ${candidate.id === model?.id ? '' : 'invisible'}`} />
                    </button>
                  ))}
                  {model && modelSelection && (
                    <>
                      <p className="mx-1 mt-1 border-t border-line px-1 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">
                        Reasoning effort
                      </p>
                      {model.reasoningEfforts.map((effort) => (
                        <button
                          key={effort}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            onReasoningEffortChange(effort)
                            setModelOpen(false)
                            input.current?.focus()
                          }}
                          className="flex h-8 w-full items-center gap-2 rounded-control px-2 text-left transition-colors duration-100 hover:bg-fill"
                        >
                          <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                            {reasoningEffortLabel(effort)}
                          </span>
                          <span className="shrink-0 text-[11px] text-ink-3">
                            {reasoningEffortHint(effort)}
                          </span>
                          <Check
                            size={13}
                            className={`shrink-0 text-ink ${effort === modelSelection.reasoningEffort ? '' : 'invisible'}`}
                          />
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          ) : null}

          {/*
            One control, two jobs — send, then stop. A recorder works this way
            because while something is running, ending it is the only thing you
            want from that spot; a second button parked elsewhere makes you go
            looking for it mid-run. The square is the universal stop mark, and
            it is always enabled while a run is going, where send is only
            enabled with something to send.
          */}
          <button
            type="button"
            aria-label={running ? 'Stop' : 'Send'}
            disabled={running ? false : !canSend}
            onClick={running ? onStop : send}
            className={`flex size-7 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94] ${
              expanded ? 'col-start-3 row-start-2' : 'col-start-4 row-start-1'
            }`}
            style={{
              background: running || canSend ? 'var(--bui-ink)' : 'var(--bui-line-strong)',
              color: running || canSend ? 'var(--bui-surface)' : 'var(--bui-ink-2)',
            }}
          >
            {running ? <span className="size-2.5 rounded-[2px] bg-current" /> : <ArrowUp size={16} />}
          </button>
        </div>
      </div>

      {/* A tray tucked under the box, reading as part of it rather than as a
          row of buttons underneath it. What goes here is the kind of thing you
          reach for before writing rather than while writing — so it sits below
          the sentence, out of the way of it, and folds shut as the composer
          compresses because by then the page has the real work on it. */}
      {actions !== undefined && (
        <div
          className="ws-comp-tray"
          style={{
            height: `${40 * Math.max(0, Math.min(1, (hero ?? 0) * 1.6 - 0.6))}px`,
            opacity: Math.max(0, (hero ?? 0) * 2 - 1),
          }}
        >
          <div className="ws-comp-tray-in">{actions}</div>
        </div>
      )}
      </div>

      <RejectionNote rejected={rejected} />
    </div>
  )
}
