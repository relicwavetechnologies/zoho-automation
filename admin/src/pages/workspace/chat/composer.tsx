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
import { ArrowUp, ArrowUpRight, Check, ChevronDown, Paperclip, Plus } from 'lucide-react'
import { ToolMark, tool, type ToolKey } from './tools'
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
  models, modelSelection, onModelChange, onReasoningEffortChange, modelLoading,
  files = NO_FILES, rejected = NO_REJECTIONS, onAttach, onRemoveFile,
}: {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  models: readonly SelectableModel[]
  modelSelection: ModelSelection | null
  onModelChange: (model: string) => void
  onReasoningEffortChange: (effort: ModelSelection['reasoningEffort']) => void
  modelLoading?: boolean
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
  const modelBtn = useRef<HTMLButtonElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const [expanded, setExpanded] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [active, setActive] = useState(0)

  const ready = value.trim().length > 0
  const canSend = ready && modelSelection !== null
  const model = models.find(candidate => candidate.id === modelSelection?.model)
  const token = tokenAt(value)
  const rows = useMemo(() => {
    const q = (token?.query ?? '').toLowerCase()
    return SOURCES.filter((s) => s.name.toLowerCase().includes(q))
  }, [token?.query])
  /* Open either because `+` was pressed, or because an `@` is being typed. */
  const menu = sourceOpen || token !== null

  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [autoFocus])

  useEffect(() => { setActive(0) }, [token?.query])

  useEffect(() => {
    if (running) setModelOpen(false)
  }, [running])

  /* Wrapped text takes a row of its own, then the field grows to a ceiling.
     Measured off a hidden mirror of the draft rather than off the textarea, so
     the decision to expand is made from the text's natural width instead of
     from a height that has already wrapped. */
  useLayoutEffect(() => {
    const el = input.current
    const bar = controls.current
    const mirror = measure.current
    const picker = modelBtn.current
    if (!el || !bar || !mirror || !picker) return

    /* Nothing has been laid out yet, so every number below would be a
       fabrication. Bailing leaves the field at its CSS `min-height`, which is
       exactly one line — the right answer for a composer nobody has typed in.
       Measuring anyway wrote a garbage height that no later pass corrected,
       because the deps had not changed by the time layout was real. */
    if (bar.clientWidth === 0) return

    const fixed = 28 * 2 + picker.offsetWidth
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
      && (value.includes('\n') || (inline > 0 && mirror.offsetWidth + 8 > inline))
    if (needsRow !== expanded) setExpanded(needsRow)

    const MIN = 28
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
  }, [value, expanded])

  const pickSource = (source: (typeof SOURCES)[number]) => {
    const head = token ? value.slice(0, token.start) : value
    onChange(`${head}@${source.name} `)
    setSourceOpen(false)
    input.current?.focus()
  }

  const send = () => {
    if (!canSend) return
    onSubmit()
  }

  const openPicker = () => {
    setSourceOpen(false)
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
    <div className="relative">
      {/* ── source menu — grows up from the composer's top edge ── */}
      {menu && (rows.length > 0 || sourceOpen) && (
        <div
          className="absolute inset-x-0 bottom-full z-10 mb-2 max-h-[264px] overflow-y-auto rounded-card bg-surface p-1 shadow-overlay"
          style={{ animation: 'bui-pop-in 180ms cubic-bezier(0.23,1,0.32,1) both', transformOrigin: 'bottom center' }}
        >
          {/* A file is a source too — the same `+`, one row above the apps.
              Only on the button, never on `@`: typing `@sh` is reaching for
              Shopify, and offering a file picker there is an interruption.
              Divo saves it into this chat's container workspace, which is what
              lets the run open it, so the row says so rather than "Upload". */}
          {sourceOpen && onAttach && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={openPicker}
              className="flex h-9 w-full items-center gap-2.5 rounded-control px-2 text-left transition-colors duration-100 hover:bg-fill"
            >
              <span className="flex w-10 shrink-0 items-center justify-center">
                <Paperclip size={14} className="text-ink-2" />
              </span>
              <span className="shrink-0 text-[12.5px] font-medium text-ink">Attach files</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
                Or drop them anywhere on this chat
              </span>
            </button>
          )}
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

      {/* ── model menu ── */}
      {modelOpen && (
        <div
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

      {/* ── the bar ── */}
      <div
        onClick={() => input.current?.focus()}
        className={`relative cursor-text border border-line bg-surface p-1.5 shadow-btn transition-[border-color,border-radius] duration-150 focus-within:border-line-strong ${
          expanded || files.length > 0 ? 'rounded-[22px]' : 'rounded-full'
        }`}
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
            aria-label="Add a source"
            aria-expanded={sourceOpen}
            onClick={() => { setModelOpen(false); setSourceOpen((v) => !v); input.current?.focus() }}
            className={`flex size-7 shrink-0 items-center justify-center justify-self-start rounded-full text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-fill hover:text-ink active:scale-[0.94] ${
              sourceOpen ? 'bg-fill text-ink' : ''
            } ${expanded ? 'col-start-1 row-start-2' : 'col-start-1 row-start-1'}`}
          >
            <Plus size={16} />
          </button>

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
                setSourceOpen(false)
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
            className={`min-h-7 w-full min-w-0 resize-none bg-transparent px-1 py-[5px] text-[13px] leading-[18px] text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3 ${
              expanded ? 'col-span-full col-start-1 row-start-1' : 'col-start-2 row-start-1'
            }`}
          />

          <button
            ref={modelBtn}
            type="button"
            aria-expanded={modelOpen}
            aria-label="Choose model"
            disabled={running || modelLoading || models.length === 0}
            onClick={() => { setSourceOpen(false); setModelOpen((v) => !v) }}
            className={`flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[12px] font-medium text-ink-2 transition-colors duration-150 enabled:hover:bg-fill enabled:hover:text-ink disabled:opacity-60 ${
              expanded ? 'col-start-2 row-start-2' : 'col-start-3 row-start-1'
            }`}
          >
            {model?.label ?? (modelLoading ? 'Loading…' : 'Unavailable')}
            {modelSelection && (
              <span className="font-normal text-ink-3">
                · {reasoningEffortLabel(modelSelection.reasoningEffort)}
              </span>
            )}
            <ChevronDown size={11} className="text-ink-3" />
          </button>

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

      <RejectionNote rejected={rejected} />
    </div>
  )
}
