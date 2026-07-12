import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { RefreshCw, Search } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ToolCatalogueCard } from '@/components/tool-catalogue/ToolCatalogueCard'
import { Input } from '@/components/ui/input'
import { route } from '@/constants/routes'
import {
  getDivoToolsInventory,
  toolSearchText,
  type DivoToolInventoryItem,
} from '@/lib/divo-tools'
import { groupToolInventory } from '@/lib/tool-presentation'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/plugins/' as never)({
  component: PluginsRoute,
})

export function PluginsRoute() {
  const navigate = useNavigate()
  const [inventory, setInventory] = useState<DivoToolInventoryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const inventoryRequestGeneration = useRef(0)

  const invalidateInventoryRequests = useCallback(() => {
    inventoryRequestGeneration.current++
  }, [])

  const loadInventory = useCallback(async () => {
    const requestGeneration = ++inventoryRequestGeneration.current
    setError(null)
    try {
      const response = await getDivoToolsInventory()
      if (requestGeneration !== inventoryRequestGeneration.current) return
      setInventory(response.tools)
    } catch (loadError) {
      if (requestGeneration !== inventoryRequestGeneration.current) return
      setInventory(null)
      setError(String(loadError))
    }
  }, [])

  useEffect(() => {
    void loadInventory()
    return invalidateInventoryRequests
  }, [invalidateInventoryRequests, loadInventory])

  const tools = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return !query ? inventory ?? [] : (inventory ?? []).filter(tool => toolSearchText(tool).includes(query))
  }, [inventory, search])
  const groups = useMemo(() => groupToolInventory(tools), [tools])

  return (
    <div className="h-svh min-h-0 overflow-y-auto overscroll-contain bg-background">
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8 lg:px-8">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-medium tracking-normal">Tools</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The tools available through your current company and department access.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void loadInventory()} disabled={inventory === null && !error}>
            <RefreshCw className="size-4" />
            Refresh
          </Button>
        </header>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={event => setSearch(event.target.value)}
            className="h-10 rounded-lg border-border/60 bg-muted/50 pl-9"
            placeholder="Search tools, categories, or access source"
            aria-label="Search tools"
          />
        </div>

        {inventory === null && !error ? <ToolsState title="Checking your tool access" description="Divo is loading current company and department policy." loading /> : null}
        {error ? <ToolsState title="Could not load tools" description="Your tool catalogue could not be checked against current access." action={<Button onClick={() => void loadInventory()}>Try again</Button>} /> : null}
        {inventory !== null && !error && tools.length === 0 ? <ToolsState title={search ? 'No matching tools' : 'No tools available'} description={search ? 'Try a name, category, or access source.' : 'No current company or department tool access was returned.'} /> : null}

        {inventory !== null && !error && groups.length > 0 ? (
          <section aria-label="Available tools" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map(group => (
              <ToolCatalogueCard key={group.id} group={group} onOpen={() => navigate({ to: route.plugins.detail, params: { pluginId: group.id } } as never)} />
            ))}
          </section>
        ) : null}
      </main>
    </div>
  )
}

function ToolsState({ title, description, action, loading = false, compact = false }: { title: string; description: string; action?: ReactNode; loading?: boolean; compact?: boolean }) {
  return <div className={cn('rounded-lg border border-dashed border-border/70 text-center', compact ? 'p-4' : 'p-8')}><div className="flex justify-center">{loading ? <RefreshCw className="size-5 animate-spin text-muted-foreground" /> : null}</div><h2 className={cn('font-medium', loading && 'mt-2')}>{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p>{action ? <div className="mt-4">{action}</div> : null}</div>
}
