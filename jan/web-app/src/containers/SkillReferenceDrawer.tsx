import { IconSearch, IconX } from '@tabler/icons-react'
import type { RefObject } from 'react'
import type { DivoSkillSearchResult } from '@/lib/divo-skill-search'

const SKELETON_ROWS = [0, 1, 2]

type SkillReferenceDrawerProps = {
  searchInputRef: RefObject<HTMLInputElement | null>
  search: string
  loading: boolean
  error: string | null
  results: DivoSkillSearchResult[]
  onSearchChange: (value: string) => void
  onClose: () => void
  onSelect: (skill: DivoSkillSearchResult) => void
}

export function SkillReferenceDrawer({
  searchInputRef,
  search,
  loading,
  error,
  results,
  onSearchChange,
  onClose,
  onSelect,
}: SkillReferenceDrawerProps) {
  const hasSearch = search.trim().length > 0

  return (
    <div
      data-testid="skill-reference-drawer"
      className="mx-3 mt-3 overflow-hidden rounded-2xl border border-border bg-background shadow-lg"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <IconSearch size={17} className="shrink-0 text-muted-foreground" />
        <input
          ref={searchInputRef}
          data-testid="skill-reference-search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return

            e.preventDefault()
            onClose()
          }}
          placeholder="Search skills"
          className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          aria-label="Close skill reference drawer"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onClose}
        >
          <IconX size={16} />
        </button>
      </div>
      <div className="space-y-2 px-3 py-3">
        {loading ? (
          SKELETON_ROWS.map((row) => (
            <div
              key={row}
              className="flex items-center gap-3 rounded-lg px-1 py-1.5"
            >
              <div className="size-8 shrink-0 rounded-md bg-muted" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="h-2.5 w-2/5 rounded-full bg-muted" />
                <div className="h-2 w-3/5 rounded-full bg-muted/70" />
              </div>
            </div>
          ))
        ) : error ? (
          <div
            data-testid="skill-reference-error"
            className="px-2 py-6 text-center text-sm text-destructive"
          >
            {error}
          </div>
        ) : results.length > 0 ? (
          results.map((skill) => (
            <button
              key={skill.id}
              type="button"
              data-testid={`skill-reference-result-${skill.id}`}
              className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted"
              onClick={() => onSelect(skill)}
            >
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sky-500/10 text-xs font-semibold text-sky-700 dark:text-sky-300">
                /
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {skill.name}
                  </span>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {skill.category}
                  </span>
                </div>
                <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                  {skill.description}
                </div>
              </div>
            </button>
          ))
        ) : hasSearch ? (
          <div
            data-testid="skill-reference-empty"
            className="px-2 py-6 text-center text-sm text-muted-foreground"
          >
            No matching skills
          </div>
        ) : (
          <div className="h-2" />
        )}
      </div>
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
