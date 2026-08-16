/**
 * The pieces a run is rendered out of.
 *
 * The governing rule, and the one thing that makes this read like the desktop
 * work log rather than a status page: **a step is expanded while it is running
 * and folds to a single sentence once it settles.** Detail is offered at the
 * moment it is being produced and withdrawn the moment it stops being news —
 * so a finished ten-step run is ten quiet lines, and the one step still working
 * is the only thing with any weight on the screen.
 *
 * Everything else follows from that. No progress bars, no spinner parked in a
 * corner, no badge that says "running". The live row simply looks alive and
 * the settled ones do not.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, Paperclip, Plus } from 'lucide-react'
import { ToolMark, tool, type ToolKey } from './tools'
import { rehypeWords } from './words'
import { DataTable } from './answer/table.view'
import { parseDrawnTable, readGrid, textOf } from './answer/table'
import { Sources, SourceLink } from './answer/links.view'
import { sourcesIn } from './answer/links'
import { FileChips, RejectionNote } from './attach.view'
import { namedForClipboard, type Rejection } from './attach'
import { CopyButton } from './copy'
import type { Beat } from './beats'
import {
  reasoningEffortHint,
  reasoningEffortLabel,
  type ModelSelection,
  type SelectableModel,
} from './model-choice'

/* ── Step ─────────────────────────────────────────────────
   Two states, one shape. Live: open, the label shimmering, the chip carrying
   what the call is aimed at. Settled: one line, foldable back open by anyone
   who wants the detail. Both carry the vendor mark, in the same slot at the
   same size — it is how the row is identified at a glance, and identity should
   not depend on whether the work has finished yet.

   A step used to stream a list of detail lines while it ran, which is why the
   fold exists at all. Nothing has produced one since the surface started
   reading a real run: the only tool that reports work underneath itself is the
   one that spawns agents, and those get drawn as agents. What is left in the
   fold is the call's own target and the app it belongs to. */

export function Step({
  beat, live,
}: {
  beat: Extract<Beat, { t: 'step' }>
  live: boolean
}) {
  /* `null` means "follow the run" — open while live, folded once settled. A
     click pins it either way, and the pin survives the step settling, because
     someone who opened a row to read it should not have it shut in their face. */
  const [pinned, setPinned] = useState<boolean | null>(null)
  const open = pinned ?? live
  const meta = tool(beat.tool)

  return (
    <div style={{ animation: 'bui-fade-up 320ms cubic-bezier(0.23,1,0.32,1) both' }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setPinned(!open)}
        className="group flex w-full items-center gap-2.5 py-0.5 text-left text-[13px] text-ink-2 transition-colors duration-100 hover:text-ink"
      >
        {/* A running step keeps its own mark rather than turning into a
            spinner. The spinner was on screen at exactly the moment somebody is
            watching the log, so the one thing they could not see was which
            system Divo was in — the marks only appeared once the work was over
            and the answer had made them redundant. The desktop settled this the
            same way: a running Gmail call should look like Gmail.

            The label carries "in flight" instead, so the row keeps its shape
            when it settles and only the shimmer falls away. Swapping the glyph
            made every step twitch sideways as it finished.

            Held back while settled and full while running, so the mark of the
            call actually in flight is the brightest thing in the log. */}
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          <ToolMark name={beat.tool} size={14} dim={!live} />
        </span>

        {/* The shimmer is a class on the row's own label rather than the
            `Shimmer` component, which carries its own type size — borrowing it
            here would resize the title as the step settled, which is the twitch
            the mark was just stopped from causing.

            No colour of its own: the row owns the weight, so hovering brightens
            label and detail together instead of half the line. */}
        <span className={`shrink-0 ${live ? 'bui-shimmer' : ''}`}>
          {beat.title}
        </span>

        {/* Live: the chip carries the real target — the query, the file, the
            sheet name. Settled: the chip gives way to the one-line result,
            because what it did now matters more than what it was aimed at.

            Both sit a weight below the label and are never title-cased: a query,
            a path or a command is verbatim, and tidying it corrupts what it
            says. */}
        <span className="min-w-0 truncate text-ink-3 transition-colors duration-100 group-hover:text-ink-2">
          {live ? beat.chip : beat.done}
        </span>

        {/* Trails, and only on hover. Drawn at rest on every row it made the log
            a column of chevrons — structure to decode rather than read — and the
            marks it competed with are the thing worth seeing. A running row has
            none at all: it is already open, and there is nothing to offer. */}
        {!live && (
          <ChevronRight
            size={13}
            className={`shrink-0 text-ink-3 opacity-0 transition-all duration-150 group-hover:opacity-100 ${open ? 'rotate-90 opacity-100' : ''}`}
          />
        )}
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? '1fr' : '0fr',
          opacity: open ? 1 : 0,
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-0.5 mb-1 ml-[7px] flex flex-col gap-0.5 border-l border-line py-0.5 pl-4">
            {/* Once settled the chip has left the header, so it reappears here
                — the query is still the most useful thing in the detail. */}
            {!live && beat.chip && (
              <span className="mb-0.5 text-[11.5px] text-ink-3">{beat.chip}</span>
            )}
            {/* The app's name, in text. The mark is already on the row header
                two lines up — repeating it here was the logo showing up twice
                inside one step for no added information. */}
            <span className="mt-1 text-[11px] text-ink-3">{meta.app}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── Answer ───────────────────────────────────────────────
   A live answer grows only when another model delta reaches the browser. Each
   newly arrived word resolves out of blur and the caret sits at the true wire
   boundary; there is no timer replaying a response the client already owns.

   Markdown, because the model writes markdown. A completed or historical
   answer is simply present — it is never typed again after the run finishes. */
export function Say({ text, streaming }: { text: string; streaming?: boolean }) {
  /* Provenance, and only once there is a whole answer to have provenance for.
     A count that climbs while the answer is still being written is a second
     thing moving on the screen, and it is the least urgent thing on it. */
  const sources = useMemo(() => (streaming ? [] : sourcesIn(text)), [text, streaming])

  if (streaming) return <LiveSay text={text} />

  return (
    <div
      className="group text-[13.5px] leading-[1.7] text-ink"
      style={{ animation: 'bui-stream-in 420ms cubic-bezier(0.23,1,0.32,1) both' }}
    >
      <Markdown>{text}</Markdown>
      <Sources sources={sources} />
      {/* Under the answer rather than floating beside it: the answer is as wide
          as the column, so there is no margin to sit in, and a control overlaid
          on the last line covers the text it belongs to. Only on a settled
          answer — the streaming branch returns above — because copying a reply
          that is still arriving gets you half of it. */}
      <div className="mt-1.5 flex items-center gap-0.5">
        <CopyButton text={text} />
      </div>
    </div>
  )
}

/**
 * The answer accumulated from real provider deltas so far.
 *
 * The current prefix is reparsed because the remainder does not exist in the
 * browser yet, and `rehypeWords` puts each word of it in an element of its own.
 * That is all the arrival animation needs: a word that has just reached the
 * browser is an element React has just mounted, and `.bui-word` animates on
 * mount. Nothing here has to be told how far the answer has got, because the
 * document it is handed *is* how far the answer has got.
 */
function LiveSay({ text }: { text: string }) {
  const document = useMemo(() => (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={STREAM_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  ), [text])

  return <div className="bui-stream text-[13.5px] leading-[1.7] text-ink">{document}</div>
}

/**
 * The model's prose, as the model wrote it.
 *
 * Every element is given a class rather than left to browser defaults, because
 * the defaults are a 1990s document: 2em headings, blue underlined links, a
 * table with no borders and no way to scroll. The point is not decoration — it
 * is that an answer should look like the rest of the surface it arrived in.
 *
 * The one structural rule worth naming: a table scrolls inside its own box. A
 * ten-column result is ordinary and a page that scrolls sideways because of one
 * is not — the table is the thing that is too wide, so the table is the thing
 * that scrolls.
 */
const MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  /* One size below body and heavier, rather than the browser's large-and-bold.
     A heading inside a chat answer is a label for the paragraph under it, not a
     title for a page. */
  h1: ({ children }) => <h3 className="mb-1.5 mt-4 text-[13.5px] font-semibold text-ink first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mb-1.5 mt-4 text-[13.5px] font-semibold text-ink first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mb-1.5 mt-3.5 text-[13px] font-semibold text-ink first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="mb-1 mt-3 text-[13px] font-semibold text-ink-2 first:mt-0">{children}</h4>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5 marker:text-ink-3">{children}</li>,
  /* A link whose text is its own address becomes a source chip; one the model
     wrote words for keeps them. `SourceLink` owns that judgement so a link in a
     table cell and a link in a sentence cannot end up disagreeing about it. */
  a: ({ children, href, node }) => (
    <SourceLink href={href ?? ''} text={textOf(node)}>{children}</SourceLink>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2.5 border-l-2 border-line pl-3 text-ink-2">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-line" />,
  code: ({ className, children }) => {
    // react-markdown gives a fenced block a language class and an inline span
    // none, which is the only way to tell them apart here.
    const fenced = typeof className === 'string' && className.includes('language-')
    if (fenced) {
      return <code className="block font-mono text-[12px] leading-[1.6]">{children}</code>
    }
    return (
      <code className="rounded-[4px] bg-fill px-1 py-0.5 font-mono text-[12px] text-ink">
        {children}
      </code>
    )
  },
  /* Divo does not always write GFM. Asked for a list it will happily print a
     fenced block of pipes with a row of dashes under the header — a table by
     every measure except the one the parser uses, arriving as a wall of
     monospace. If the block is that shape it is read back out and drawn as the
     table it is; anything else is left as the code it claims to be. */
  pre: ({ children, node }) => {
    const drawn = parseDrawnTable(textOf(node))
    if (drawn) {
      return <DataTable table={{ ...drawn, hrefs: [] }} />
    }
    return (
      <pre className="my-2.5 overflow-x-auto rounded-control bg-inset p-3 shadow-hairline">{children}</pre>
    )
  },
  /* Drawn from the table's own data rather than by decorating cells, because
     alignment, folding and the chart are all decisions about a column and a
     `<td>` renderer only ever sees one cell. */
  table: ({ children, node }) => {
    const grid = readGrid(node)
    if (grid) return <DataTable table={grid} />
    return (
      <div className="my-3 overflow-x-auto rounded-control bg-surface shadow-hairline">
        <table className="w-full border-collapse text-[12px]">{children}</table>
      </div>
    )
  },
  thead: ({ children }) => <thead className="border-b border-line">{children}</thead>,
  th: ({ children }) => (
    <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-medium text-ink-2">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-t border-line px-2.5 py-1.5 align-top text-ink">{children}</td>
  ),
}

const REMARK_PLUGINS = [remarkGfm]
/* Only while the answer is still arriving. A settled answer is present rather
   than arriving, so wrapping its words would be several hundred elements bought
   for an animation that already finished. Runs after the markdown is a tree, so
   it cannot change what the document means. */
const STREAM_PLUGINS = [rehypeWords]

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {children}
    </ReactMarkdown>
  )
}

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
                {candidate.vision ? 'Vision' : candidate.provider === 'deepseek' ? 'DeepSeek' : 'OpenAI'}
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
