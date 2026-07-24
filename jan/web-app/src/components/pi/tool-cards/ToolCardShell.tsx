import { memo, useState, type ComponentType } from 'react'
import { ChevronRightIcon, ExternalLinkIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { CodeBlock } from '@/components/ai-elements/code-block'

export type ToolCardState = 'running' | 'done' | 'error'

export type ToolCardShellProps = {
  /** Vendor mark (Gmail, Lark, …), sized by the shell. */
  Mark: ComponentType<{ className?: string }>
  /** Branded app name — the card's identity line. */
  appName: string
  /** State-appropriate action phrase, e.g. "Searching" / "Searched". */
  action: string
  /** The call's headline subject (query, file, range), dimmed. */
  subject?: string
  state: ToolCardState
  /** The result's one-line takeaway, shown as a chip when settled. */
  headline?: string
  /** A primary openable link the result produced. */
  link?: string
  /** The actual result rows — task titles, record names, sheet cells. */
  items?: string[]
  /** How many rows exist beyond the ones in `items`. */
  moreCount?: number
  /** Error body, shown in place of the result when the call failed. */
  errorText?: string
  /** Pretty-printed request params for the "raw" disclosure. */
  rawInput?: string
  /** Pretty-printed result body for the "raw" disclosure. */
  rawOutput?: string
}

/**
 * The presentational chrome shared by every tool card.
 *
 * Identity line (mark + app), action line (verb + subject), then a state-driven
 * body: skeleton bars while the call runs ("applying"), or once settled the
 * reader-facing result — a headline chip, an open-link, and a short preview of
 * what came back. The full request/result JSON is never discarded: it folds
 * into a "raw" disclosure, matching the trace's fold-don't-destroy rule.
 *
 * Vendor-agnostic by design — the vendor lives entirely in `Mark`, `appName`,
 * and the resolved strings, so every family reuses this unchanged.
 */
export const ToolCardShell = memo(
  ({
    Mark,
    appName,
    action,
    subject,
    state,
    headline,
    link,
    items,
    moreCount,
    errorText,
    rawInput,
    rawOutput,
  }: ToolCardShellProps) => {
    const [rawOpen, setRawOpen] = useState(false)
    const [itemsOpen, setItemsOpen] = useState(false)
    const running = state === 'running'
    const hasRaw = Boolean(rawInput || rawOutput)
    const hasResult = Boolean(headline || link || (items && items.length))

    // Show a handful of items collapsed; the rest expand inline on click.
    const INITIAL_ITEMS = 6
    const allItems = items ?? []
    const shownItems = itemsOpen ? allItems : allItems.slice(0, INITIAL_ITEMS)
    const hiddenInline = allItems.length - shownItems.length

    return (
      <section
        className="my-1 max-w-[70ch] overflow-hidden rounded-lg border border-border bg-muted/30 text-sm"
        data-testid="tool-card"
        data-state={state}
      >
        <div className="flex flex-col gap-1.5 p-3">
          {/* Identity — the branded mark carries the vendor colour. */}
          <div className="flex items-center gap-2">
            <Mark className="size-4 shrink-0" />
            <span className="font-medium text-foreground">{appName}</span>
          </div>

          {/* Action + subject. The verb shimmers only while the call runs. */}
          <div className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                'shrink-0 text-[13px] text-muted-foreground',
                running && 'text-shimmer'
              )}
            >
              {action}
            </span>
            {subject && (
              <span className="min-w-0 truncate text-[13px] text-muted-foreground/60">
                {subject}
              </span>
            )}
          </div>

          {/* Body — loading bars, result, or error. */}
          {running ? (
            <div className="mt-0.5 flex flex-col gap-1.5" data-testid="tool-card-skeleton">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          ) : state === 'error' ? (
            <p className="mt-0.5 text-[13px] leading-relaxed text-destructive">
              {errorText || 'This call did not complete.'}
            </p>
          ) : (
            hasResult && (
              <div className="mt-0.5 flex flex-col gap-1.5">
                {(headline || link) && (
                  <div className="flex flex-wrap items-center gap-2">
                    {headline && (
                      <span className="inline-flex items-center rounded-md bg-background px-2 py-0.5 text-[13px] font-medium text-foreground/80 ring-1 ring-border">
                        {headline}
                      </span>
                    )}
                    {link && (
                      <a
                        href={link}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[13px] text-primary hover:underline"
                      >
                        Open
                        <ExternalLinkIcon className="size-3" />
                      </a>
                    )}
                  </div>
                )}
                {allItems.length > 0 && (
                  <ul className="flex flex-col gap-0.5">
                    {shownItems.map((line, i) => (
                      <li
                        key={i}
                        className="truncate text-[13px] text-muted-foreground/80 before:mr-1.5 before:text-muted-foreground/40 before:content-['·']"
                      >
                        {line}
                      </li>
                    ))}
                    {/* Expand the rest inline; collapse again once opened. */}
                    {(hiddenInline > 0 || itemsOpen) && allItems.length > INITIAL_ITEMS && (
                      <li>
                        <button
                          type="button"
                          onClick={() => setItemsOpen((v) => !v)}
                          className="mt-0.5 text-[12px] font-medium text-muted-foreground/60 transition-colors hover:text-foreground"
                        >
                          {itemsOpen ? 'Show less' : `+${hiddenInline} more`}
                        </button>
                      </li>
                    )}
                    {/* Beyond what a click can reveal — the rest lives in raw. */}
                    {itemsOpen && moreCount && moreCount > 0 ? (
                      <li className="text-[12px] text-muted-foreground/40">
                        +{moreCount} more in raw
                      </li>
                    ) : null}
                  </ul>
                )}
              </div>
            )
          )}
        </div>

        {/* Raw request/result — folded away, one click from view. */}
        {hasRaw && (
          <div className="border-t border-border">
            <button
              type="button"
              onClick={() => setRawOpen((v) => !v)}
              aria-expanded={rawOpen}
              className="group flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12px] text-muted-foreground/70 transition-colors hover:text-muted-foreground"
            >
              <ChevronRightIcon
                className={cn('size-3.5 shrink-0 transition-transform', rawOpen && 'rotate-90')}
              />
              {rawOpen ? 'Hide raw' : 'View raw'}
            </button>
            {rawOpen && (
              <div className="flex flex-col gap-3 px-3 pb-3">
                {rawInput && <RawBlock heading="Parameters" code={rawInput} />}
                {rawOutput && <RawBlock heading="Result" code={rawOutput} />}
              </div>
            )}
          </div>
        )}
      </section>
    )
  }
)

ToolCardShell.displayName = 'ToolCardShell'

function RawBlock({ heading, code }: { heading: string; code: string }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {heading}
      </h4>
      <div className="max-h-40 overflow-auto rounded-md border border-border">
        <CodeBlock code={code} language="json" />
      </div>
    </div>
  )
}
