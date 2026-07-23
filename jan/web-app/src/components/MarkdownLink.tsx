import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { resolveMarkdownLinkIcon } from '@/lib/markdown-link-icon'

type MarkdownLinkProps = {
  href?: string
  children?: ReactNode
  className?: string
}

/**
 * Chat markdown hyperlink with a small host icon (local brand map).
 * Citations stay on CitationLink — this is for real http(s)/mailto URLs.
 */
export function MarkdownLink({ href, children, className }: MarkdownLinkProps) {
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
