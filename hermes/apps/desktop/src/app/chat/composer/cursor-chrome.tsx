/**
 * Cursor-style composer chrome — currently MOCK / static visuals to match the
 * Cursor reference UI. No live data wired yet:
 *   - ComposerDiffBar      → "Changes +N −N" + "Commit & Push ▾" pills (above)
 *   - ComposerContextFooter → "<current folder path> · Local · NN%" footer (below)
 * The folder path is live (from $currentCwd); the diff bar + percent are still
 * placeholder props so real git/agent data can be threaded in later.
 */
import { useStore } from '@nanostores/react'

import { Codicon } from '@/components/ui/codicon'
import { ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $currentCwd } from '@/store/session'

const PILL_CLASS = cn(
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[0.8125rem]',
  'border border-[color-mix(in_srgb,var(--foreground)_12%,transparent)]',
  'bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] text-(--ui-text-tertiary)',
  'transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] hover:text-foreground'
)

export function ComposerDiffBar({
  added = 10158,
  removed = 7171
}: {
  added?: number
  removed?: number
}) {
  return (
    <div className="relative z-10 flex items-center gap-2 px-0.5 pt-1 pb-2.5">
      <button className={PILL_CLASS} type="button">
        <span>Changes</span>
        <span className="font-medium text-[#5fbf73]">+{added.toLocaleString()}</span>
        <span className="font-medium text-[#e0667a]">−{removed.toLocaleString()}</span>
      </button>
      <button className={PILL_CLASS} type="button">
        <span>Commit &amp; Push</span>
        <ChevronDown className="size-3.5 opacity-70" />
      </button>
    </div>
  )
}

/** Split an absolute path into a truncatable parent and an always-visible
 * basename (so the current folder name never gets clipped). Collapses $HOME
 * to `~` when we can recognise a `/Users/<name>/` or `/home/<name>/` prefix. */
function formatFolder(raw: string): { full: string; parent: string; base: string } | null {
  const full = raw.trim().replace(/\/+$/, '')

  if (!full) {
    return null
  }

  const display = full.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~')
  const idx = display.lastIndexOf('/')

  if (idx < 0) {
    return { base: display, full, parent: '' }
  }

  return { base: display.slice(idx + 1) || display, full, parent: display.slice(0, idx + 1) }
}

export function ComposerContextFooter({
  target = 'Local',
  percent = 48
}: {
  target?: string
  percent?: number
}) {
  const cwd = useStore($currentCwd)
  const folder = formatFolder(cwd)

  return (
    <div className="relative z-10 flex items-center justify-between px-1.5 pt-2 text-[0.78rem] text-(--ui-text-tertiary)">
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="flex min-w-0 items-center gap-1.5" title={folder?.full ?? 'No folder selected'}>
          <Codicon className="shrink-0 opacity-80" name="folder" size="0.85rem" />
          {folder ? (
            <span className="flex min-w-0">
              {folder.parent && <span className="truncate opacity-70">{folder.parent}</span>}
              <span className="shrink-0">{folder.base}</span>
            </span>
          ) : (
            <span className="opacity-70">No folder</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <Codicon className="opacity-80" name="device-desktop" size="0.85rem" />
          <span>{target}</span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <ProgressRing percent={percent} />
        <span className="tabular-nums">{percent}%</span>
      </div>
    </div>
  )
}

function ProgressRing({ percent }: { percent: number }) {
  const r = 6
  const c = 2 * Math.PI * r
  const offset = c * (1 - Math.max(0, Math.min(100, percent)) / 100)

  return (
    <svg aria-hidden className="size-3.5 -rotate-90" viewBox="0 0 16 16">
      <circle
        cx="8"
        cy="8"
        fill="none"
        r={r}
        stroke="color-mix(in srgb, var(--foreground) 18%, transparent)"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        fill="none"
        r={r}
        stroke="currentColor"
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        strokeWidth="2"
      />
    </svg>
  )
}
