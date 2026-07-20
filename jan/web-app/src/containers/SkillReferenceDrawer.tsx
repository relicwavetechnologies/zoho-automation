import { IconX } from '@tabler/icons-react'
import { SparklesIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { DivoSkillSearchResult } from '@/lib/divo-skill-search'

const SKELETON_ROWS = [0, 1, 2]

/** Rows shown before the list collapses behind "Show N more". */
const VISIBLE_ROWS = 6

type SkillReferenceDrawerProps = {
  search: string
  loading: boolean
  error: string | null
  results: DivoSkillSearchResult[]
  onSelect: (skill: DivoSkillSearchResult) => void
  /** Rendered above the skills group — e.g. the /share-memory command row. */
  commands?: ReactNode
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-2.5 pb-1 text-[11px] font-normal text-muted-foreground/70">
      {children}
    </div>
  )
}

/**
 * The `/` command menu — a compact floating list, positioned by its caller
 * above the composer.
 *
 * It has NO search field of its own. The `/query` the user is already typing in
 * the composer drives the results (see the slash handler in ChatInput), so a
 * second box here meant two inputs for one search, and opening it stole focus
 * out of the composer mid-sentence. Typing, filtering and sending all stay on
 * the textarea; this list only ever displays and selects.
 */
export function SkillReferenceDrawer({
  search,
  loading,
  error,
  results,
  onSelect,
  commands,
}: SkillReferenceDrawerProps) {
  const [expanded, setExpanded] = useState(false)
  const hasSearch = search.trim().length > 0
  const shown = expanded ? results : results.slice(0, VISIBLE_ROWS)
  const hidden = results.length - shown.length

  return (
    <div
      data-testid="skill-reference-drawer"
      className="w-[380px] max-w-full overflow-hidden rounded-xl border border-border bg-popover py-1 shadow-xl"
    >
      {commands}

      <GroupLabel>Skills</GroupLabel>

      {loading ? (
        SKELETON_ROWS.map((row) => (
          <div key={row} className="flex items-center gap-2.5 px-3 py-1.5">
            <div className="size-4 shrink-0 rounded bg-muted" />
            <div className="h-2.5 w-2/5 rounded-full bg-muted" />
          </div>
        ))
      ) : error ? (
        <div
          data-testid="skill-reference-error"
          className="px-3 py-2 text-[13px] text-destructive"
        >
          {error}
        </div>
      ) : results.length > 0 ? (
        <>
          {shown.map((skill) => (
            <button
              key={skill.id}
              type="button"
              data-testid={`skill-reference-result-${skill.id}`}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
              onClick={() => onSelect(skill)}
            >
              <SparklesIcon className="size-4 shrink-0 text-muted-foreground/70" />
              <span className="min-w-0 flex-1 truncate">{skill.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground/60">
                {skill.category}
              </span>
            </button>
          ))}
          {hidden > 0 && (
            <button
              type="button"
              data-testid="skill-reference-show-more"
              className="w-full px-3 py-1.5 text-left text-[13px] text-muted-foreground/70 hover:text-foreground"
              onClick={() => setExpanded(true)}
            >
              Show {hidden} more
            </button>
          )}
        </>
      ) : hasSearch ? (
        <div
          data-testid="skill-reference-empty"
          className="px-3 py-2 text-[13px] text-muted-foreground"
        >
          No matching skills
        </div>
      ) : (
        <div className="px-3 py-2 text-[13px] text-muted-foreground/70">
          Type to search skills
        </div>
      )}
    </div>
  )
}

type SkillReferenceChipsProps = {
  skills: DivoSkillSearchResult[]
  onRemove: (skillId: string) => void
}

export function SkillReferenceChips({
  skills,
  onRemove,
}: SkillReferenceChipsProps) {
  if (skills.length === 0) return null

  return (
    <div
      data-testid="skill-reference-chips"
      className="flex flex-wrap gap-2 px-3 pt-3"
    >
      {skills.map((skill) => (
        <span
          key={skill.id}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-800 dark:border-sky-400/30 dark:bg-sky-400/10 dark:text-sky-200"
        >
          <span className="min-w-0 truncate">/{skill.name}</span>
          <button
            type="button"
            aria-label={`Remove ${skill.name} reference`}
            className="shrink-0 rounded-full text-sky-600 hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-100"
            onClick={() => onRemove(skill.id)}
          >
            <IconX size={13} />
          </button>
        </span>
      ))}
    </div>
  )
}
