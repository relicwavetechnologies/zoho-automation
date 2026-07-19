import { useMemo, useState, type ReactNode } from 'react'
import {
  BookOpenCheck,
  ChevronRight,
  GitBranch,
  Network,
  Sparkles,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ManagerPersonaTree } from '@/lib/divo-teach'

type PersonaNode = ManagerPersonaTree['nodes'][number]

type PersonaDomain = {
  scopeKey: string
  nodes: PersonaNode[]
}

const formatLearningDate = (value: string) => new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}).format(new Date(value))

const readableKey = (value: string) => value
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .split(/[-_]/g)
  .filter(Boolean)
  .map(word => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
  .join(' ')

export function PersonaGraph({
  tree,
  loading,
}: {
  tree: ManagerPersonaTree | null
  loading: boolean
}) {
  const domains = useMemo<PersonaDomain[]>(() => {
    const grouped = new Map<string, PersonaNode[]>()
    for (const node of tree?.nodes ?? []) {
      grouped.set(node.scopeKey, [...(grouped.get(node.scopeKey) ?? []), node])
    }
    return [...grouped.entries()].map(([scopeKey, nodes]) => ({ scopeKey, nodes }))
  }, [tree])
  const [selectedScope, setSelectedScope] = useState<string>()
  const [selectedNodeId, setSelectedNodeId] = useState<string>()

  const activeDomain = domains.find(domain => domain.scopeKey === selectedScope) ?? domains[0]
  const activeNode = activeDomain?.nodes.find(node => node.id === selectedNodeId) ?? activeDomain?.nodes[0]
  const skillCount = new Set((tree?.nodes ?? []).flatMap(node => node.linkedSkills.map(skill => skill.id))).size

  const selectDomain = (domain: PersonaDomain) => {
    setSelectedScope(domain.scopeKey)
    setSelectedNodeId(domain.nodes[0]?.id)
  }

  return (
    <section className="mt-5 overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div className="flex items-center gap-2">
          <Network className="size-4 text-violet-500" />
          <div>
            <h2 className="text-sm font-medium">Department persona graph</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Domains route matching work through rules to reusable skills
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {tree?.nodes.length ? (
            <>
              <Badge variant="secondary">{domains.length} {domains.length === 1 ? 'domain' : 'domains'}</Badge>
              <Badge variant="secondary">{tree.nodes.length} {tree.nodes.length === 1 ? 'rule' : 'rules'}</Badge>
              <Badge variant="secondary">{skillCount} {skillCount === 1 ? 'skill' : 'skills'}</Badge>
            </>
          ) : null}
          <Badge variant="outline">{tree ? `Revision ${tree.revision}` : 'Empty'}</Badge>
        </div>
      </div>

      {activeDomain && activeNode ? (
        <div className="overflow-x-auto">
          <div
            aria-label="Department persona routing graph"
            className="grid min-w-[860px] grid-cols-[13rem_1rem_18rem_1rem_minmax(20rem,1fr)]"
          >
            <GraphColumn title="Domains" subtitle="Where this applies">
              {domains.map(domain => {
                const selected = domain.scopeKey === activeDomain.scopeKey
                return (
                  <button
                    key={domain.scopeKey}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => selectDomain(domain)}
                    className={cn(
                      'w-full rounded-lg border px-3 py-3 text-left transition-colors',
                      selected
                        ? 'border-violet-500/40 bg-violet-500/10'
                        : 'border-transparent bg-muted/35 hover:border-border hover:bg-muted/60'
                    )}
                  >
                    <span className="flex items-start gap-2">
                      <GitBranch className={cn('mt-0.5 size-3.5 shrink-0', selected ? 'text-violet-500' : 'text-muted-foreground')} />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium">{readableKey(domain.scopeKey)}</span>
                        <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{domain.scopeKey}</span>
                        <span className="mt-2 block text-[10px] text-muted-foreground">
                          {domain.nodes.length} {domain.nodes.length === 1 ? 'rule' : 'rules'}
                        </span>
                      </span>
                    </span>
                  </button>
                )
              })}
            </GraphColumn>

            <GraphConnector />

            <GraphColumn title="Rules" subtitle={`Inside ${readableKey(activeDomain.scopeKey)}`}>
              {activeDomain.nodes.map(node => {
                const selected = node.id === activeNode.id
                return (
                  <button
                    key={node.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSelectedNodeId(node.id)}
                    className={cn(
                      'w-full rounded-lg border px-3 py-3 text-left transition-colors',
                      selected
                        ? 'border-violet-500/40 bg-violet-500/10'
                        : 'border-transparent bg-muted/35 hover:border-border hover:bg-muted/60'
                    )}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-[11px]">{node.ruleKey}</span>
                        <span className="mt-1 block text-[10px] capitalize text-muted-foreground">{node.kind}</span>
                      </span>
                      <Badge variant="outline" className="shrink-0 text-[9px]">
                        {Math.round(node.confidence * 100)}%
                      </Badge>
                    </span>
                  </button>
                )
              })}
            </GraphColumn>

            <GraphConnector />

            <div className="min-w-0 p-4">
              <div className="mb-3">
                <p className="text-xs font-medium">Selected rule</p>
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{activeNode.ruleKey}</p>
              </div>

              <div className="rounded-lg border bg-background/50 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className="capitalize">{activeNode.kind}</Badge>
                  <Badge variant="outline">{Math.round(activeNode.confidence * 100)}% confidence</Badge>
                </div>
                <p className="mt-3 text-sm leading-6">{activeNode.instruction}</p>
              </div>

              <div className="ml-5 border-l pl-4">
                <div className="py-4">
                  <div className="flex items-center gap-2 text-xs font-medium">
                    <Sparkles className="size-3.5 text-violet-500" />
                    Uses skills
                  </div>
                  {activeNode.linkedSkills.length ? (
                    <div className="mt-2 grid gap-2">
                      {activeNode.linkedSkills.map(skill => (
                        <div key={skill.id} className="rounded-lg border border-violet-500/25 bg-violet-500/5 p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-xs font-medium text-violet-500">{skill.name}</p>
                            <Badge variant="outline" className="text-[9px]">v{skill.revision}</Badge>
                          </div>
                          <p className="mt-1 font-mono text-[10px] text-muted-foreground">{skill.slug}</p>
                          {skill.summary && <p className="mt-2 text-xs leading-5 text-muted-foreground">{skill.summary}</p>}
                          {skill.toolIds.length > 0 && (
                            <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-violet-500/15 pt-2">
                              <span className="mr-1 text-[10px] text-muted-foreground">Requires</span>
                              {skill.toolIds.map(toolId => (
                                <Badge key={toolId} variant="secondary" className="text-[9px]">
                                  {readableKey(toolId)}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">No reusable skill is linked to this rule yet.</p>
                  )}
                </div>

                <div className="border-t py-4">
                  <div className="flex items-center gap-2 text-xs font-medium">
                    <BookOpenCheck className="size-3.5 text-emerald-500" />
                    Learned from
                  </div>
                  {activeNode.learningSources.length ? (
                    <div className="mt-2 space-y-2">
                      {activeNode.learningSources.map(source => (
                        <details
                          key={`${source.source}-${source.sourceId}-${source.learnedAt}`}
                          className="rounded-lg border bg-muted/20 px-3 py-2 text-xs"
                        >
                          <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                            <span className="capitalize">{source.source}</span>
                            {' · '}{formatLearningDate(source.learnedAt)}
                          </summary>
                          <p className="mt-2 leading-5 text-muted-foreground">{source.rationale}</p>
                        </details>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">No recent source is available for this rule.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <p className="px-5 py-6 text-sm text-muted-foreground">
          {loading ? 'Loading persona graph…' : 'No persona rules have been learned yet.'}
        </p>
      )}
    </section>
  )
}

function GraphColumn({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: ReactNode
}) {
  return (
    <div className="border-r p-4">
      <p className="text-xs font-medium">{title}</p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{subtitle}</p>
      <div className="mt-3 max-h-[32rem] space-y-2 overflow-y-auto pr-1">{children}</div>
    </div>
  )
}

function GraphConnector() {
  return (
    <div className="relative border-r bg-muted/10" aria-hidden="true">
      <div className="absolute left-0 top-20 w-full border-t border-violet-500/35" />
      <ChevronRight className="absolute -right-2 top-[4.55rem] size-4 rounded-full bg-card text-violet-500" />
    </div>
  )
}
