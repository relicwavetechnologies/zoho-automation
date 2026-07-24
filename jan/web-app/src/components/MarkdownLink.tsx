import type { ReactNode } from 'react'
import { FileCode2Icon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { resolveMarkdownLinkIcon } from '@/lib/markdown-link-icon'
import {
  fileLinkLabel,
  isFileMarkdownHref,
  isNumericCitationLabel,
} from '@/lib/artifact-markdown'

type MarkdownLinkProps = {
  href?: string
  children?: ReactNode
  className?: string
}

function childrenToText(children: ReactNode): string {
  if (children == null || typeof children === 'boolean') return ''
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children)
  }
  if (Array.isArray(children)) {
    return children.map(childrenToText).join('')
  }
  return ''
}

/**
 * Chat/artifact markdown hyperlink.
 * - `#cite-…` stays on CitationLink (caller branches first)
 * - path-like hrefs → Cursor-style file chip (icon + dotted underline)
 * - numeric labels on http(s) → compact citation pill
 * - otherwise brand-icon external link
 */
export function MarkdownLink({ href, children, className }: MarkdownLinkProps) {
  const labelText = childrenToText(children)

  if (isFileMarkdownHref(href)) {
    const label = fileLinkLabel(href!, labelText || undefined)
    return (
      <a
        href={href}
        className={cn('markdown-file-link', className)}
        data-streamdown="link"
        title={href}
        onClick={(event) => {
          // Relative workspace paths are not browser-navigable; keep the chip
          // visual and copy the path so the user can jump in an editor.
          if (!/^(https?:|mailto:)/i.test(href ?? '')) {
            event.preventDefault()
            void navigator.clipboard?.writeText(href ?? label)
          }
        }}
      >
        <FileCode2Icon className="markdown-file-link-icon" aria-hidden />
        <span className="markdown-file-link-label">{label}</span>
      </a>
    )
  }

  if (
    href &&
    /^https?:/i.test(href) &&
    isNumericCitationLabel(labelText)
  ) {
    return (
      <a
        href={href}
        className={cn('markdown-citation-pill', className)}
        data-streamdown="link"
        rel="noreferrer"
        target="_blank"
        title={href}
      >
        {labelText.trim()}
      </a>
    )
  }

  const Icon = resolveMarkdownLinkIcon(href)

  return (
    <a
      href={href}
      className={cn('markdown-link', className)}
      data-streamdown="link"
      rel="noreferrer"
      target="_blank"
    >
      {Icon ? (
        <Icon
          className="markdown-link-icon"
          aria-hidden
          title={undefined}
        />
      ) : null}
      <span className="markdown-link-label">{children}</span>
    </a>
  )
}
