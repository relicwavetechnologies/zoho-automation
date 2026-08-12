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
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import { ToolMark, tool, type ToolKey } from './tools'
import { WORD_MS, rehypeWords, wordIndexOf } from './reveal'
import type { ArtifactBlock, Beat, StepLine, TableBlock } from './transcripts'

/* ── Step ─────────────────────────────────────────────────
   Two states, one shape. Live: open, lines streaming, the label shimmering.
   Settled: one line, foldable back open by anyone who wants the detail.
   Both carry the vendor mark, in the same slot at the same size — it is how the
   row is identified at a glance, and identity should not depend on whether the
   work has finished yet. */

function Line({ line, index }: { line: StepLine; index: number }) {
  const tone =
    line.tone === 'add' ? 'text-[var(--bui-green)]'
      : line.tone === 'warn' ? 'text-ink-2'
        : 'text-ink-2'
  return (
    <span
      className={`flex gap-1.5 text-[12px] leading-[1.65] ${tone} ${line.tone === 'mono' ? 'font-mono text-[11.5px]' : ''}`}
      style={{ animation: `bui-fade-up 320ms cubic-bezier(0.23,1,0.32,1) ${index * 130}ms both` }}
    >
      {line.tone === 'warn' && (
        <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-[var(--bui-orange)]" />
      )}
      <span className="min-w-0">{line.text}</span>
    </span>
  )
}

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
        <span
          className={`min-w-0 truncate text-ink-3 transition-colors duration-100 group-hover:text-ink-2 ${beat.mono ? 'font-mono text-[12px]' : ''}`}
        >
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
              <span className={`mb-0.5 text-[11.5px] text-ink-3 ${beat.mono ? 'font-mono' : ''}`}>
                {beat.chip}
              </span>
            )}
            {beat.lines.map((line, i) => (
              <Line key={line.text} line={line} index={live ? i : 0} />
            ))}
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

/* ── Approval ─────────────────────────────────────────────
   The moment the run stops. It is a card rather than a row because it is the
   one thing on the screen that will not resolve itself, and it states what is
   about to happen in the reader's terms — destination, scope, blast radius —
   not in the runtime's. */
export function Approval({
  beat, onApprove, onDecline, answered,
}: {
  beat: Extract<Beat, { t: 'approve' }>
  onApprove: () => void
  onDecline: () => void
  answered: 'approved' | 'declined' | null
}) {
  const meta = tool(beat.tool)
  return (
    <div
      className="rounded-card bg-surface shadow-card"
      style={{ animation: 'bui-fade-up 380ms cubic-bezier(0.23,1,0.32,1) both' }}
    >
      <div className="flex items-start gap-2.5 border-b border-line p-3">
        <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-control bg-inset shadow-hairline">
          <ToolMark name={beat.tool} size={15} />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-ink">{beat.title}</span>
          <span className="mt-0.5 block text-[12px] leading-relaxed text-ink-2">{beat.body}</span>
        </span>
        {!answered && (
          <span className="ml-auto shrink-0 rounded-full bg-[var(--bui-accent-tint)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--bui-accent-ink)]">
            Waiting on you
          </span>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 p-3">
        {beat.facts.map((f) => (
          <div key={f.k} className="contents">
            <dt className="text-[11.5px] text-ink-3">{f.k}</dt>
            <dd className="text-[11.5px] text-ink">{f.v}</dd>
          </div>
        ))}
      </dl>

      <div className="flex items-center gap-2 border-t border-line p-2.5">
        {answered ? (
          <span
            className={`flex items-center gap-1.5 text-[12px] font-medium ${answered === 'approved' ? 'text-[var(--bui-green)]' : 'text-ink-2'}`}
          >
            {answered === 'approved' ? <Check size={13} /> : <X size={13} />}
            {answered === 'approved' ? `Approved — ${meta.app}` : 'Declined'}
          </span>
        ) : (
          <>
            <button
              type="button"
              onClick={onApprove}
              className="rounded-control bg-ink px-3 py-1.5 text-[12.5px] font-medium text-surface transition-transform duration-150 active:scale-[0.97]"
            >
              {beat.confirm}
            </button>
            <button
              type="button"
              onClick={onDecline}
              className="rounded-control px-3 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors duration-100 hover:bg-fill hover:text-ink"
            >
              Not now
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/* ── Answer ───────────────────────────────────────────────
   Paragraphs arrive whole and blur in, rather than typing character by
   character. A run that took twenty seconds to think has already made the
   reader wait; making them watch it type is a second tax on the same result.

   Markdown, because the model writes markdown. It was rendered as plain text,
   so a table of ten emails arrived as a wall of pipes and hyphens and every
   heading kept its asterisks — the answer was there, and unreadable. The model
   is not doing anything unusual: bold, lists and GFM tables are how it says
   "here are your results", and a surface that prints them literally is refusing
   to listen. */
export function Say({ text, reveal }: { text: string; reveal?: boolean }) {
  /* An answer read back from history is already old news, so it is simply
     there. Re-typing yesterday's reply every time the thread is scrolled past
     would be a performance of work that finished a day ago. */
  if (!reveal) {
    return (
      <div
        className="text-[13.5px] leading-[1.7] text-ink"
        style={{ animation: 'bui-stream-in 420ms cubic-bezier(0.23,1,0.32,1) both' }}
      >
        <Markdown>{text}</Markdown>
      </div>
    )
  }
  return <StreamedSay text={text} />
}

/**
 * The answer arriving a word at a time.
 *
 * The document is parsed once and in full — see `reveal.ts` for why — so what
 * moves here is only a cursor over words that already exist. Every word past it
 * renders as nothing, which is what makes the paragraph grow rather than fade
 * up out of a block that was already the right size.
 */
function StreamedSay({ text }: { text: string }) {
  const [shown, setShown] = useState(0)
  /* Counted off the same split the parser uses, so the cursor and the indices
     it is compared against can never disagree about what a word is. */
  const total = useMemo(
    () => text.split(/(\s+)/).filter(part => part.trim().length > 0).length,
    [text],
  )

  /* Only a *different* answer starts over. While a run is live the same answer
     arrives again and again, each time a little longer, and treating every
     arrival as new text would drag the cursor back to zero and replay the
     whole reveal several times a second. */
  const revealing = useRef(text)
  useEffect(() => {
    if (!text.startsWith(revealing.current)) setShown(0)
    revealing.current = text
  }, [text])

  useEffect(() => {
    if (shown >= total) return
    const tick = window.setTimeout(() => setShown(count => count + 1), WORD_MS)
    return () => window.clearTimeout(tick)
  }, [shown, total])

  /* The document is built once per answer and handed down unchanged, so moving
     the cursor re-renders the words and nothing else. Rebuilt every tick it
     would be re-parsed every tick — and, far worse, every word would be a new
     element and would mount again from the start of its own animation. */
  const document = useMemo(() => (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REVEAL_PLUGINS}
      components={REVEAL_COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  ), [text])

  const cursor = useMemo(() => ({ shown, streaming: shown < total }), [shown, total])

  return (
    <div className="bui-stream text-[13.5px] leading-[1.7] text-ink">
      <RevealCursor.Provider value={cursor}>{document}</RevealCursor.Provider>
    </div>
  )
}

/**
 * How far the reveal has got.
 *
 * It travels by context so that the component drawing a word can be written
 * once, at module scope. Passing the cursor the obvious way — rebuilding the
 * `components` map each tick, closing over `shown` — hands react-markdown a
 * brand new function for `span` eighteen times a second, and a new function is
 * a new element type: React throws away every word and mounts it again. Each
 * remount restarts `bui-stream-in`, so the answer sat permanently in the
 * blurred, transparent first frame of its own arrival and never finished
 * arriving.
 */
const RevealCursor = createContext({ shown: Number.POSITIVE_INFINITY, streaming: false })

const RevealWord: Components['span'] = ({ node, children, ...rest }) => {
  const { shown, streaming } = useContext(RevealCursor)
  const index = wordIndexOf(node?.properties)
  // Not one of ours — a span the model's own markdown asked for.
  if (index === null) return <span {...rest}>{children}</span>
  if (index >= shown) return null
  return (
    <span
      data-word={index}
      className="bui-word"
      /* The caret rides inside the newest word rather than at the end of the
         document, so it sits where the text actually stops. Parked after the
         container it would land under the answer, on its own line, wherever
         the last block happened to end. */
    >
      {children}
      {streaming && index === shown - 1 && <i className="bui-caret" />}
    </span>
  )
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
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="underline decoration-line underline-offset-2 transition-colors hover:decoration-ink-2"
    >
      {children}
    </a>
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
  pre: ({ children }) => (
    <pre className="my-2.5 overflow-x-auto rounded-control bg-inset p-3 shadow-hairline">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-control bg-surface shadow-hairline">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-line">{children}</thead>,
  th: ({ children }) => (
    <th className="whitespace-nowrap px-2.5 py-1.5 text-left font-medium text-ink-2">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-t border-line px-2.5 py-1.5 align-top text-ink">{children}</td>
  ),
}

const REMARK_PLUGINS = [remarkGfm]
/* Runs after the markdown is already a tree, so numbering the words cannot
   change what the document means. */
const REVEAL_PLUGINS = [rehypeWords]
/* One map, made once. Its identity is what keeps a word's element — and so the
   animation that word is part-way through — alive from one tick to the next. */
const REVEAL_COMPONENTS: Components = { ...MARKDOWN_COMPONENTS, span: RevealWord }

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
      {children}
    </ReactMarkdown>
  )
}

/* ── Table ────────────────────────────────────────────────
   A preview, and it says so in the footer. The full data is in the artifact —
   this exists to prove the rows are real, not to be read. */
export function Preview({ block }: { block: TableBlock }) {
  const numeric = new Set(block.numeric ?? [])
  return (
    <figure
      className="overflow-hidden rounded-control bg-surface shadow-hairline"
      style={{ animation: 'bui-fade-up 380ms cubic-bezier(0.23,1,0.32,1) both' }}
    >
      <figcaption className="border-b border-line px-2.5 py-1.5 text-[11px] text-ink-3">
        {block.caption}
      </figcaption>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11.5px]">
          <thead>
            <tr>
              {block.columns.map((c, i) => (
                <th
                  key={c}
                  className={`border-b border-line px-2.5 py-1.5 font-medium text-ink-3 ${numeric.has(i) ? 'text-right' : 'text-left'}`}
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={row[0]} className="transition-colors duration-100 hover:bg-fill">
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={`whitespace-nowrap px-2.5 py-1.5 ${ri < block.rows.length - 1 ? 'border-b border-line' : ''} ${
                      numeric.has(ci) ? 'text-right tabular-nums text-ink' : ci === 0 ? 'font-medium text-ink' : 'text-ink-2'
                    }`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {block.footer && (
        <div className="border-t border-line px-2.5 py-1.5 text-[11px] text-ink-3">{block.footer}</div>
      )}
    </figure>
  )
}

/* ── Artifact ─────────────────────────────────────────────
   What the run actually produced. The mark is the vendor's, because the file
   now lives in their system and not in Divo. */
export function Artifact({ block }: { block: ArtifactBlock }) {
  return (
    <button
      type="button"
      className="group flex w-full items-center gap-2.5 rounded-card bg-surface p-2.5 text-left shadow-btn transition-colors duration-100 hover:bg-fill"
      style={{ animation: 'bui-pop-in 320ms cubic-bezier(0.23,1,0.32,1) both' }}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-inset shadow-hairline">
        <ToolMark name={block.tool} size={17} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-ink">{block.title}</span>
        <span className="block truncate text-[11px] text-ink-3">{block.meta}</span>
      </span>
      <ArrowUpRight
        size={14}
        className="shrink-0 text-ink-3 transition-colors duration-100 group-hover:text-ink"
      />
    </button>
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

const MODELS = [
  { key: 'pro', name: 'Pro', tag: 'Default' },
  { key: 'fast', name: 'Fast', tag: 'Cheaper' },
  { key: 'deep', name: 'Deep', tag: 'Long runs' },
]

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
}: {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  placeholder: string
  autoFocus?: boolean
  /** A run is going. The send control becomes the way to end it. */
  running?: boolean
  onStop?: () => void
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const controls = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLSpanElement>(null)
  const modelBtn = useRef<HTMLButtonElement>(null)

  const [expanded, setExpanded] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [modelOpen, setModelOpen] = useState(false)
  const [model, setModel] = useState(MODELS[0])
  const [active, setActive] = useState(0)

  const ready = value.trim().length > 0
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
    if (!ready) return
    onSubmit()
  }

  return (
    <div className="relative">
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

      {/* ── model menu ── */}
      {modelOpen && (
        <div
          className="absolute right-0 bottom-full z-10 mb-2 w-44 rounded-card bg-surface p-1 shadow-overlay"
          style={{ animation: 'bui-pop-in 180ms cubic-bezier(0.23,1,0.32,1) both', transformOrigin: 'bottom right' }}
        >
          {MODELS.map((m) => (
            <button
              key={m.key}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { setModel(m); setModelOpen(false); input.current?.focus() }}
              className="flex h-8 w-full items-center gap-2 rounded-control px-2 text-left transition-colors duration-100 hover:bg-fill"
            >
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{m.name}</span>
              <span className="shrink-0 text-[11px] text-ink-3">{m.tag}</span>
              <Check size={13} className={`shrink-0 text-ink ${m.key === model.key ? '' : 'invisible'}`} />
            </button>
          ))}
        </div>
      )}

      {/* ── the bar ── */}
      <div
        onClick={() => input.current?.focus()}
        className={`relative cursor-text border border-line bg-surface p-1.5 shadow-btn transition-[border-color,border-radius] duration-150 focus-within:border-line-strong ${
          expanded ? 'rounded-[22px]' : 'rounded-full'
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
            placeholder={placeholder}
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
            onClick={() => { setSourceOpen(false); setModelOpen((v) => !v) }}
            className={`flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-[12px] font-medium text-ink-2 transition-colors duration-150 hover:bg-fill hover:text-ink ${
              expanded ? 'col-start-2 row-start-2' : 'col-start-3 row-start-1'
            }`}
          >
            {model.name}
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
            disabled={running ? false : !ready}
            onClick={running ? onStop : send}
            className={`flex size-7 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94] ${
              expanded ? 'col-start-3 row-start-2' : 'col-start-4 row-start-1'
            }`}
            style={{
              background: running || ready ? 'var(--bui-ink)' : 'var(--bui-line-strong)',
              color: running || ready ? 'var(--bui-surface)' : 'var(--bui-ink-2)',
            }}
          >
            {running ? <span className="size-2.5 rounded-[2px] bg-current" /> : <ArrowUp size={16} />}
          </button>
        </div>
      </div>
    </div>
  )
}
