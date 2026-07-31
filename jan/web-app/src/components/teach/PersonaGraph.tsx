import { useMemo, useState } from 'react'
import { BookOpen, ChevronDown, Sparkles, Wrench } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ManagerPersonaTree } from '@/lib/divo-teach'

type PersonaNode = ManagerPersonaTree['nodes'][number]

type PersonaArea = {
  scopeKey: string
  title: string
  nodes: PersonaNode[]
}

const formatLearningDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))

/** `competitive-seo_analysis` -> `Competitive Seo Analysis`. */
const readableKey = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_.]/g)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ')

/**
 * How sure Divo is, said the way a person would say it.
 *
 * A "95%" badge invites a manager to wonder what the other 5% is and gives
 * them nothing to do about it. What they actually need to know is whether
 * Divo will act on this confidently or is still working it out.
 */
function confidenceLabel(confidence: number) {
  if (confidence >= 0.85) return { text: 'Divo is confident', tone: 'text-emerald-600' }
  if (confidence >= 0.6) return { text: 'Divo is fairly sure', tone: 'text-amber-600' }
  return { text: 'Divo is still learning this', tone: 'text-muted-foreground' }
}

/**
 * Everything Divo has learned, written for the person who taught it.
 *
 * This was a three-column routing graph: domains, then rule keys, then a
 * detail pane — all keyed on identifiers like `competitive-seo-analysis-
 * report-workflow`, with a revision number and confidence percentages, on a
 * canvas wide enough to force sideways scrolling. It described the data
 * structure faithfully and told a manager nothing about their own work.
 *
 * The rewrite shows the instruction itself as the content, because that is the
 * sentence the manager taught. Areas are plain headings, skills read as things
 * Divo can now do, and every identifier, percentage, and revision is folded
 * away behind "Technical details" for whoever actually needs it.
 */
export function PersonaGraph({
  tree,
  loading,
}: {
  tree: ManagerPersonaTree | null
  loading: boolean
}) {
  const areas = useMemo<PersonaArea[]>(() => {
    const grouped = new Map<string, PersonaNode[]>()
    for (const node of tree?.nodes ?? []) {
      grouped.set(node.scopeKey, [...(grouped.get(node.scopeKey) ?? []), node])
    }
    return [...grouped.entries()].map(([scopeKey, nodes]) => ({
      scopeKey,
      title: readableKey(scopeKey),
      nodes,
    }))
  }, [tree])

  const skillCount = new Set(
    (tree?.nodes ?? []).flatMap((node) => node.linkedSkills.map((skill) => skill.id))
  ).size

  if (!tree?.nodes.length) {
    return (
      <section className="mt-5 rounded-xl border bg-card px-5 py-6">
        <h2 className="text-sm font-medium">What Divo has learned</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {loading
            ? 'Checking what Divo has learned so far…'
            : 'Nothing yet. After your first recording, everything Divo picks up shows here in plain English.'}
        </p>
      </section>
    )
  }

  return (
    <section className="mt-5 overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-5 py-4">
        <div>
          <h2 className="text-sm font-medium">What Divo has learned</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {tree.nodes.length}{' '}
            {tree.nodes.length === 1 ? 'thing' : 'things'} across {areas.length}{' '}
            {areas.length === 1 ? 'part' : 'parts'} of your work
            {skillCount > 0
              ? ` · ${skillCount} ${skillCount === 1 ? 'task' : 'tasks'} it can now run for you`
              : ''}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          Updated {formatLearningDate(tree.updatedAt)}
        </p>
      </div>

      <div className="divide-y">
        {areas.map((area, index) => (
          <PersonaAreaSection
            key={area.scopeKey}
            area={area}
            defaultOpen={index === 0}
          />
        ))}
      </div>
    </section>
  )
}

function PersonaAreaSection({
  area,
  defaultOpen,
}: {
  area: PersonaArea
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-5 py-3.5 text-left transition-colors hover:bg-muted/40"
      >
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            !open && '-rotate-90'
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{area.title}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {area.nodes.length} {area.nodes.length === 1 ? 'thing' : 'things'}{' '}
            Divo knows
          </span>
        </span>
      </button>

      {open && (
        <div className="space-y-2.5 px-5 pb-5">
          {area.nodes.map((node) => (
            <PersonaRuleCard key={node.id} node={node} />
          ))}
        </div>
      )}
    </div>
  )
}

function PersonaRuleCard({ node }: { node: PersonaNode }) {
  const confidence = confidenceLabel(node.confidence)
  const [latest] = node.learningSources

  return (
    <article className="rounded-xl border bg-background/60 p-4">
      {/* The instruction is the content. It is the sentence the manager
          taught, so it leads — not the key it happens to be stored under. */}
      <p className="text-sm leading-6">{node.instruction}</p>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className={confidence.tone}>{confidence.text}</span>
        {latest && (
          <span className="text-muted-foreground">
            Learned {formatLearningDate(latest.learnedAt)}
            {latest.source === 'teach' ? ' from a recording' : ' from a chat'}
          </span>
        )}
      </div>

      {node.linkedSkills.length > 0 && (
        <div className="mt-3 space-y-2 rounded-lg border border-violet-500/25 bg-violet-500/[0.05] p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-violet-500">
            <Sparkles className="size-3.5" /> Divo can do this for you
          </p>
          {node.linkedSkills.map((skill) => (
            <div key={skill.id}>
              <p className="text-xs font-medium">{skill.name}</p>
              {skill.summary && (
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {skill.summary}
                </p>
              )}
              {skill.toolIds.length > 0 && (
                <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Wrench className="size-3" />
                  Uses {skill.toolIds.map(readableKey).join(', ')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Everything an engineer might need, and nothing a manager has to read
          past to understand what Divo learned. */}
      <details className="group mt-3">
        <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
          Technical details
        </summary>
        <div className="mt-2 space-y-2 border-l pl-3">
          <p className="font-mono text-[10px] text-muted-foreground">
            {node.scopeKey} · {node.ruleKey} · {node.kind} ·{' '}
            {Math.round(node.confidence * 100)}% confidence
          </p>
          {node.learningSources.length > 0 && (
            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-[11px] font-medium">
                <BookOpen className="size-3" /> Why Divo believes this
              </p>
              {node.learningSources.map((source) => (
                <p
                  key={`${source.source}-${source.sourceId}-${source.learnedAt}`}
                  className="text-[11px] leading-5 text-muted-foreground"
                >
                  {source.rationale}
                </p>
              ))}
            </div>
          )}
        </div>
      </details>
    </article>
  )
}
