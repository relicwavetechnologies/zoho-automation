/**
 * Links, drawn as the sources they are.
 *
 * A bare URL in a sentence is the least readable thing on the page. It gets a
 * chip instead: the site's mark and its domain, sized like a word so the line
 * still reads as a line. A link the model wrote real prose for keeps its prose
 * — the text is doing work a chip would throw away.
 *
 * The mark is drawn locally, never fetched. A favicon service would tell a
 * third party every domain that appears in this company's answers, which is a
 * strange price to pay for a 16-pixel picture.
 */
import { useState, type ReactNode } from 'react'
import { ToolMark, type ToolKey } from '../tools'
import { useRevealedIndex } from '../reveal'
import { domainOf, initialOf, isBareLink, tintOf, type Source } from './links'

/** Sites Divo already has a mark for, so a Zoho link looks like Zoho. */
const KNOWN: { match: RegExp; tool: ToolKey }[] = [
  { match: /(^|\.)zoho\.(com|in|eu)$/, tool: 'zohoBooks' },
  { match: /(^|\.)airtable\.com$/, tool: 'airtable' },
  { match: /(^|\.)canva\.com$/, tool: 'canva' },
  { match: /(^|\.)semrush\.com$/, tool: 'semrush' },
  { match: /(^|\.)(shopify\.com|myshopify\.com)$/, tool: 'shopify' },
  { match: /(^|\.)(larksuite\.com|feishu\.cn)$/, tool: 'lark' },
  { match: /^docs\.google\.com$/, tool: 'docs' },
  { match: /^(mail|inbox)\.google\.com$/, tool: 'gmail' },
  { match: /^drive\.google\.com$/, tool: 'drive' },
  { match: /^calendar\.google\.com$/, tool: 'calendar' },
  { match: /(^|\.)google\.(com|co\.in)$/, tool: 'google' },
]

export function SiteMark({ domain, size = 14 }: { domain: string; size?: number }) {
  const known = KNOWN.find(entry => entry.match.test(domain))
  if (known) return <ToolMark name={known.tool} size={size} />

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
 * One link inside the prose.
 *
 * Bare addresses become a chip; anything the model gave words to keeps them.
 */
export function SourceLink({
  href, text, word = null, children,
}: {
  href: string
  text: string
  /** Where the words it replaces sat in the reveal, when it replaces any. */
  word?: number | null
  children?: ReactNode
}) {
  const domain = domainOf(href)
  const revealed = useRevealedIndex(word)

  if (domain && isBareLink(text, href)) {
    if (!revealed) return null
    return (
      <a
        href={href}
        data-word={word ?? undefined}
        target="_blank"
        rel="noreferrer noopener"
        className="mx-[1px] inline-flex max-w-full translate-y-[2px] items-center gap-1 rounded-[5px] bg-fill px-1.5 py-[1px] align-baseline text-[11.5px] text-ink-2 no-underline transition-colors duration-100 hover:bg-field hover:text-ink"
      >
        <SiteMark domain={domain} size={12} />
        <span className="truncate font-mono">{domain}</span>
      </a>
    )
  }

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
              <SiteMark domain={source.domain} size={11} />
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
              <SiteMark domain={source.domain} size={13} />
              <span className="font-mono">{source.domain}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
