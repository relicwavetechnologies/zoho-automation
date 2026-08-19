/**
 * The model's prose, drawn as the model wrote it.
 *
 * Every element is given a class rather than left to browser defaults, because
 * the defaults are a 1990s document: 2em headings, blue underlined links, a
 * table with no borders and no way to scroll. The point is not decoration — it
 * is that an answer should look like the rest of the surface it arrived in.
 *
 * It lives in `answer/` because the rest of the answer already does: the link
 * and table readers this hands its nodes to are one directory deep, and this
 * used to sit two directories away in the module that owns the *composer*. So
 * "how is an answer rendered" began in the file about typing one.
 */
import { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { rehypeWords } from '../words'
import { DataTable } from './table.view'
import { parseDrawnTable, readGrid, textOf } from './table'
import { Sources, SourceLink } from './links.view'
import { sourcesIn } from './links'
import { CopyButton } from '../copy'

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
