/**
 * Links, drawn as the things they point at.
 *
 * This module used to ask one question — *is the link's text bare?* — and only
 * the yes branch got a mark. Since most links the model writes have real prose,
 * most links arrived as an underline that said nothing about where they went,
 * and a workspace file arrived as dead text. It now asks what the href *is*,
 * and every kind it recognises carries its mark. Bareness survives as one
 * detail of one kind: whether a site's own address is worth printing twice.
 *
 * The mark is drawn locally, never fetched. A favicon service would tell a
 * third party every domain that appears in this company's answers, which is a
 * strange price to pay for a 16-pixel picture. Which mark a site gets is
 * `tool-identity`'s answer, so a Zoho link and a Zoho step in the work log
 * cannot disagree about what Zoho looks like.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Check, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, Mail, Presentation,
} from 'lucide-react'
import { ToolMark } from '../tools'
import { markForUrl } from '../tool-identity'
import {
  fileNameOf, initialOf, isBareLink, isNavigable, targetOf, tintOf,
  type FileFamily, type Source,
} from './links'

/** Shared by every kind, so a link reads as a link before it reads as a file. */
const LINK_INK = 'text-[var(--bui-link)]'

export function SiteMark({ href, domain, size = 14 }: {
  /** The full address — the path is what tells a Google Doc from a Google Sheet. */
  href?: string
  domain: string
  size?: number
}) {
  const known = markForUrl(href ?? `https://${domain}`)
  if (known) return <ToolMark name={known} size={size} />

  const hue = tintOf(domain)
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-[3px] font-medium"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.62,
        background: `oklch(0.62 0.13 ${hue} / 0.16)`,
        color: `oklch(0.62 0.13 ${hue})`,
      }}
    >
      {initialOf(domain)}
    </span>
  )
}

/**
 * A file's glyph, by family.
 *
 * Tinted, and the tint is identity rather than measurement — nothing here
 * encodes a quantity, so a fixed hue per family is honest. It also does the
 * work: a spreadsheet and a PDF are told apart across the page at a glance,
 * which a single grey paperclip never managed.
 */
const FILE_FACE: Record<FileFamily, { Icon: typeof FileText; hue: number }> = {
  doc: { Icon: FileText, hue: 25 },
  sheet: { Icon: FileSpreadsheet, hue: 150 },
  slide: { Icon: Presentation, hue: 45 },
  image: { Icon: FileImage, hue: 300 },
  archive: { Icon: FileArchive, hue: 265 },
  code: { Icon: FileCode, hue: 220 },
  file: { Icon: FileText, hue: 250 },
}

function FileMark({ family, size = 13 }: { family: FileFamily; size?: number }) {
  const { Icon, hue } = FILE_FACE[family]
  return <Icon size={size} aria-hidden className="shrink-0" style={{ color: `oklch(0.62 0.15 ${hue})` }} />
}

/**
 * One link inside the prose.
 *
 * Four shapes, one rule: whatever it is, it says so before it says anything
 * else.
 */
export function SourceLink({
  href, text, children,
}: {
  href: string
  text: string
  children?: ReactNode
}) {
  const target = targetOf(href)

  if (target.kind === 'file') return <FileLink href={href} target={target} />

  if (target.kind === 'site' && isBareLink(text, href)) {
    /* An address printed in full is the least readable thing on a line. The
       chip says the same thing in the width of a word. */
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="mx-[1px] inline-flex max-w-full translate-y-[2px] items-center gap-1 rounded-[5px] bg-fill px-1.5 py-[1px] align-baseline text-[11.5px] text-ink-2 no-underline transition-colors duration-100 hover:bg-field hover:text-ink"
      >
        <SiteMark href={href} domain={target.domain} size={12} />
        <span className="truncate font-mono">{target.domain}</span>
      </a>
    )
  }

  if (target.kind === 'site' || target.kind === 'mail') {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={`inline ${LINK_INK} underline decoration-[color:var(--bui-link-soft)] underline-offset-2 transition-colors hover:decoration-[color:var(--bui-link)]`}
      >
        {/* `inline-flex` on the mark rather than on the anchor, so a link that
            wraps across two lines breaks like the sentence it is part of
            instead of being held together as one unbreakable box. */}
        <span className="mr-[3px] inline-flex translate-y-[2px] items-center">
          {target.kind === 'mail'
            ? <Mail size={12} aria-hidden className={`shrink-0 ${LINK_INK}`} />
            : <SiteMark href={href} domain={target.domain} size={12} />}
        </span>
        {children ?? text}
      </a>
    )
  }

  /* An anchor, or a scheme with nothing to say about it. */
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="underline decoration-line underline-offset-2 transition-colors hover:decoration-ink-2"
    >
      {children ?? text}
    </a>
  )
}

/**
 * A file the run put in its workspace.
 *
 * The path cannot be followed — the file is in the container, not on this
 * origin — so clicking copies it instead of pretending to navigate, and the
 * glyph confirms the copy happened. A link that silently does nothing is worse
 * than no link, and a silent copy is only marginally better.
 */
function FileLink({ href, target }: {
  href: string
  target: Extract<ReturnType<typeof targetOf>, { kind: 'file' }>
}) {
  const [copied, setCopied] = useState(false)
  const settle = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(settle.current), [])

  const navigable = isNavigable(href)
  const label = target.name || fileNameOf(href)

  return (
    <a
      href={href}
      {...(navigable ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
      title={navigable ? href : `${href} — click to copy this path`}
      onClick={event => {
        if (navigable) return
        event.preventDefault()
        void navigator.clipboard?.writeText(href).then(
          () => setCopied(true),
          () => setCopied(false),
        )
        window.clearTimeout(settle.current)
        settle.current = window.setTimeout(() => setCopied(false), 1_600)
      }}
      className={`mx-[1px] inline-flex max-w-full translate-y-[2px] items-center gap-1 rounded-[5px] bg-fill px-1.5 py-[1px] align-baseline text-[11.5px] no-underline transition-colors duration-100 hover:bg-field ${LINK_INK}`}
    >
      {copied
        ? <Check size={12} aria-hidden className="shrink-0 text-[var(--bui-green)]" />
        : <FileMark family={target.family} size={12} />}
      <span className="truncate">{copied ? 'Path copied' : label}</span>
    </a>
  )
}

/**
 * Where the answer got its information, under the answer.
 *
 * Folded to a stack of marks and a count, because the sources are provenance
 * rather than content: worth being able to check, not worth reading first.
 */
export function Sources({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false)
  if (sources.length === 0) return null

  return (
    <div className="mt-3 flex flex-col gap-1.5" style={{ animation: 'bui-fade-in 300ms ease-out both' }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="group flex w-fit items-center gap-2 rounded-full py-0.5 text-[11.5px] text-ink-3 transition-colors duration-100 hover:text-ink-2"
      >
        <span className="flex items-center">
          {sources.slice(0, 4).map((source, index) => (
            <span
              key={source.domain}
              className="grid size-[18px] place-items-center rounded-full bg-surface shadow-hairline"
              style={{ marginLeft: index === 0 ? 0 : -6, zIndex: 4 - index }}
            >
              <SiteMark href={source.href} domain={source.domain} size={11} />
            </span>
          ))}
        </span>
        {sources.length} {sources.length === 1 ? 'source' : 'sources'}
      </button>

      {open && (
        <div className="flex flex-wrap gap-1">
          {sources.map(source => (
            <a
              key={source.domain}
              href={source.href}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-1.5 rounded-control bg-inset px-2 py-1 text-[11.5px] text-ink-2 no-underline shadow-hairline transition-colors duration-100 hover:bg-fill hover:text-ink"
            >
              <SiteMark href={source.href} domain={source.domain} size={13} />
              <span className="font-mono">{source.domain}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
