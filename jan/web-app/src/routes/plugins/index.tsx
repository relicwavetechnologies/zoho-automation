import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { RefreshCw, Search, ShieldCheck, Users } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ToolCatalogueCard } from '@/components/tool-catalogue/ToolCatalogueCard'
import { DepartmentTeamDialog } from '@/components/tool-access/DepartmentTeamDialog'
import { Input } from '@/components/ui/input'
import { route } from '@/constants/routes'
import {
  getDivoToolsInventory,
  getDivoDepartmentManageSnapshot,
  toolSearchText,
  type DepartmentManagementSnapshot,
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
  const [teamSnapshots, setTeamSnapshots] = useState<Record<string, DepartmentManagementSnapshot>>({})
  const [managedDepartment, setManagedDepartment] = useState<{ id: string; name: string } | null>(null)
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
      const departments = new Map<string, { id: string; name: string }>()
      for (const item of response.tools) {
        for (const scope of item.managementScopes) {
          if (scope.kind === 'department') departments.set(scope.department.id, scope.department)
        }
      }
      const snapshots = await Promise.allSettled([...departments.values()].map(async department => [department.id, await getDivoDepartmentManageSnapshot(department.id)] as const))
      if (requestGeneration !== inventoryRequestGeneration.current) return
      setTeamSnapshots(Object.fromEntries(snapshots.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])))
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

        {inventory !== null && !error ? <DepartmentTeamOverview inventory={inventory} snapshots={teamSnapshots} onManage={setManagedDepartment} /> : null}

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
      {managedDepartment ? <DepartmentTeamDialog department={managedDepartment} open onOpenChange={open => { if (!open) setManagedDepartment(null) }} onChanged={() => void loadInventory()} /> : null}
    </div>
  )
}

function DepartmentTeamOverview({ inventory, snapshots, onManage }: { inventory: DivoToolInventoryItem[]; snapshots: Record<string, DepartmentManagementSnapshot>; onManage: (department: { id: string; name: string }) => void }) {
  const departments = [...new Map(inventory.flatMap(item => item.managementScopes.flatMap(scope => scope.kind === 'department' ? [[scope.department.id, scope.department] as const] : [])).values()).values()]
  if (!departments.length) return null
  return <section aria-label="Department team management" className="rounded-xl border border-border/70 bg-card/30 p-4">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-base font-medium">Your department teams</h2><p className="mt-1 text-sm text-muted-foreground">Manage people and custom roles across the department’s tools.</p></div><Users className="size-5 text-muted-foreground" /></div>
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      {departments.map(department => {
        const snapshot = snapshots[department.id]
        const memberships = snapshot?.memberships ?? []
        const roles = snapshot?.roles ?? []
        const managers = memberships.filter(member => member.roleSlug === 'MANAGER').length
        const customRoles = roles.filter(role => !role.isSystem).length
        return <div key={department.id} className="rounded-lg border border-border/70 bg-background/40 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="font-medium">{department.name}</h3><p className="mt-1 text-xs text-muted-foreground">Department management</p></div><ShieldCheck className="size-4 text-muted-foreground" /></div>
          {snapshot ? <div className="mt-4 grid grid-cols-2 gap-2 text-sm"><Metric label="People" value={memberships.length} /><Metric label="Roles" value={roles.length} /><Metric label="Managers" value={managers} /><Metric label="Custom roles" value={customRoles} /></div> : <p className="mt-4 text-sm text-muted-foreground">Loading team summary…</p>}
          <Button className="mt-4 w-full" variant="outline" size="sm" onClick={() => onManage(department)}>Manage team</Button>
        </div>
      })}
    </div>
  </section>
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-md bg-muted/40 px-3 py-2"><p className="text-lg font-medium leading-none">{value}</p><p className="mt-1 text-xs text-muted-foreground">{label}</p></div>
}

function ToolsState({ title, description, action, loading = false, compact = false }: { title: string; description: string; action?: ReactNode; loading?: boolean; compact?: boolean }) {
  return <div className={cn('rounded-lg border border-dashed border-border/70 text-center', compact ? 'p-4' : 'p-8')}><div className="flex justify-center">{loading ? <RefreshCw className="size-5 animate-spin text-muted-foreground" /> : null}</div><h2 className={cn('font-medium', loading && 'mt-2')}>{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p>{action ? <div className="mt-4">{action}</div> : null}</div>
}
