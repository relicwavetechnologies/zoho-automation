import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AlertTriangle, Building2, MoreHorizontal, RefreshCw, Search, ShieldCheck, UserPlus } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApprovalInbox } from '@/components/approvals/ApprovalInbox'
import { ToolCatalogueCard } from '@/components/tool-catalogue/ToolCatalogueCard'
import { PeopleTableSkeleton, RoleCardGridSkeleton, ToolCardGridSkeleton } from '@/components/tool-catalogue/ToolSkeletons'
import { DepartmentAccessMatrix } from '@/components/tool-access/DepartmentAccessMatrix'
import { DepartmentTeamDialog, type DepartmentTeamDialogFocus } from '@/components/tool-access/DepartmentTeamDialog'
import { ToolAccessSection } from '@/components/tool-access/ToolAccessSection'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { route } from '@/constants/routes'
import {
  getDivoDepartmentManageSnapshot,
  getDivoToolsInventory,
  toolSearchText,
  type DepartmentManagementMember,
  type DepartmentManagementRole,
  type DepartmentManagementSnapshot,
  type DivoToolInventoryItem,
} from '@/lib/divo-tools'
import { PERSONAL_CONNECTABLE_PLUGIN_IDS } from '@/lib/plugins'
import { groupToolInventory, type ToolPresentationGroup } from '@/lib/tool-presentation'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/plugins/' as never)({
  component: PluginsRoute,
})

type WorkspaceView = 'tools' | 'people' | 'roles' | 'access'
type ToolFilter = 'all' | 'ready' | 'approval' | 'attention'

export function PluginsRoute() {
  const navigate = useNavigate()
  const [inventory, setInventory] = useState<DivoToolInventoryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [view, setView] = useState<WorkspaceView>('tools')
  const [toolFilter, setToolFilter] = useState<ToolFilter>('all')
  const [teamSnapshots, setTeamSnapshots] = useState<Record<string, DepartmentManagementSnapshot>>({})
  const [selectedDepartmentId, setSelectedDepartmentId] = useState('')
  const [teamDialog, setTeamDialog] = useState<{ department: { id: string; name: string }; focus: DepartmentTeamDialogFocus } | null>(null)
  const [managedGroupId, setManagedGroupId] = useState<string | null>(null)
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
      const departments = managedDepartments(response.tools)
      const snapshots = await Promise.allSettled(departments.map(async department => [department.id, await getDivoDepartmentManageSnapshot(department.id)] as const))
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

  const departments = useMemo(() => managedDepartments(inventory ?? []), [inventory])
  useEffect(() => {
    if (!departments.length) {
      setSelectedDepartmentId('')
      setView('tools')
      return
    }
    if (!departments.some(department => department.id === selectedDepartmentId)) setSelectedDepartmentId(departments[0]!.id)
  }, [departments, selectedDepartmentId])

  const selectedDepartment = departments.find(department => department.id === selectedDepartmentId) ?? null
  const selectedSnapshot = selectedDepartment ? teamSnapshots[selectedDepartment.id] : undefined
  const allGroups = useMemo(() => groupToolInventory(inventory ?? []), [inventory])
  // The inventory is already server-filtered for the signed-in member. A
  // management scope is the server-authoritative signal that this member is a
  // department manager or company admin, so do not rely on a cached desktop
  // role to decide whether to expose the administration workspace.
  const hasManagementAccess = (inventory ?? []).some(item => item.managementScopes.length > 0)
  const personalGroups = useMemo(
    () => allGroups.filter(group => PERSONAL_CONNECTABLE_PLUGIN_IDS.includes(group.id)),
    [allGroups],
  )
  const managedGroup = managedGroupId ? allGroups.find(group => group.id === managedGroupId) ?? null : null
  const searchQuery = search.trim().toLocaleLowerCase()

  const visibleTools = useMemo(() => (inventory ?? []).filter(item => {
    if (searchQuery && !toolSearchText(item).includes(searchQuery)) return false
    if (toolFilter === 'ready') return item.readiness === 'ready' || item.readiness === 'not_applicable'
    if (toolFilter === 'approval') return item.tool.hitlRequired
    if (toolFilter === 'attention') return item.readiness === 'connection_required' || item.readiness === 'admin_connection_required'
    return true
  }), [inventory, searchQuery, toolFilter])
  const visibleGroups = useMemo(() => groupToolInventory(visibleTools), [visibleTools])
  const visibleMembers = useMemo(() => filterMembers(selectedSnapshot?.memberships ?? [], searchQuery), [searchQuery, selectedSnapshot])
  const visibleRoles = useMemo(() => filterRoles(selectedSnapshot?.roles ?? [], searchQuery), [searchQuery, selectedSnapshot])
  const attentionCount = (inventory ?? []).filter(item => item.readiness === 'connection_required' || item.readiness === 'admin_connection_required').length

  const openTeamDialog = (focus: DepartmentTeamDialogFocus) => {
    if (selectedDepartment) setTeamDialog({ department: selectedDepartment, focus })
  }

  return (
    <div className="h-svh min-h-0 overflow-y-auto overscroll-contain bg-background">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-7 lg:px-8">
        <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="flex flex-col gap-1">
            {inventory !== null && !error && hasManagementAccess ? <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><span className="size-1.5 rounded-full bg-foreground" />Live company policy</div> : null}
            <h1 className="text-2xl font-medium tracking-tight">Tools</h1>
            <p className="text-sm text-muted-foreground">{inventory !== null && !error && !hasManagementAccess ? 'Connect the Google Workspace account you use with Divo.' : 'Control what your department can use, and who can do what.'}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void loadInventory()} disabled={inventory === null && !error}>
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
        </header>

        {/* A paused action outranks the catalogue: it is work someone is
            blocked on, not something to browse. It sits above everything and
            disappears when there is nothing waiting. */}
        {inventory !== null && !error ? <ApprovalInbox /> : null}

        {inventory !== null && !error && hasManagementAccess && selectedDepartment ? (
          <DepartmentScopeBar department={selectedDepartment} departments={departments} snapshot={selectedSnapshot} attentionCount={attentionCount} onDepartmentChange={setSelectedDepartmentId} />
        ) : null}

        {inventory !== null && !error ? (
          hasManagementAccess ? <Tabs value={view} onValueChange={next => { setView(next as WorkspaceView); setSearch('') }} className="gap-5">
            <div className="flex flex-col justify-between gap-3 border-b sm:flex-row sm:items-end">
              <TabsList variant="line" className="max-w-full justify-start overflow-x-auto">
                <TabsTrigger value="tools">Tools <CountBadge>{allGroups.length}</CountBadge></TabsTrigger>
                {selectedDepartment ? <TabsTrigger value="people">People <CountBadge>{selectedSnapshot?.memberships.length ?? 0}</CountBadge></TabsTrigger> : null}
                {selectedDepartment ? <TabsTrigger value="roles">Roles <CountBadge>{selectedSnapshot?.roles.length ?? 0}</CountBadge></TabsTrigger> : null}
                {selectedDepartment ? <TabsTrigger value="access">Access map</TabsTrigger> : null}
              </TabsList>
              {selectedDepartment ? (
                <div className="flex gap-2 pb-2">
                  <Button variant="outline" size="sm" onClick={() => openTeamDialog('roles')}><ShieldCheck data-icon="inline-start" />New role</Button>
                  <Button size="sm" onClick={() => openTeamDialog('people')}><UserPlus data-icon="inline-start" />Add person</Button>
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={event => setSearch(event.target.value)} className="h-10 rounded-lg border-border/70 bg-muted/30 pl-9" placeholder={searchPlaceholder(view)} aria-label="Search tools workspace" />
              </div>
              {view === 'tools' ? <ToolFilters value={toolFilter} onChange={setToolFilter} count={visibleGroups.length} /> : null}
            </div>

            <TabsContent value="tools" className="flex flex-col gap-5">
              {attentionCount > 0 ? (
                <Alert className="border-border/70 bg-card/40">
                  <AlertTriangle />
                  <AlertTitle>{attentionCount} {attentionCount === 1 ? 'tool needs' : 'tools need'} attention</AlertTitle>
                  <AlertDescription className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center"><span>One or more backend-owned integrations need a connection before configured access becomes usable.</span><Button variant="outline" size="sm" onClick={() => setToolFilter('attention')}>Review</Button></AlertDescription>
                </Alert>
              ) : null}
              <section className="flex flex-col gap-3" aria-label="Available tools">
                <div><h2 className="text-base font-medium">{selectedDepartment ? `Available while managing ${selectedDepartment.name}` : 'Available tools'}</h2><p className="mt-1 text-xs text-muted-foreground">Effective access, readiness, approval requirements, and management entry points.</p></div>
                {visibleGroups.length > 0 ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{visibleGroups.map(group => <ToolCatalogueCard key={group.id} group={group} onManage={() => setManagedGroupId(group.id)} onOpenDetails={() => navigate({ to: route.plugins.detail, params: { pluginId: group.id } } as never)} />)}</div> : <ToolsState title="No matching tools" description="Try a tool name, category, action, access source, or clear the active filter." />}
              </section>
            </TabsContent>

            {selectedDepartment ? <TabsContent value="people"><PeopleView loading={!selectedSnapshot} members={visibleMembers} onManage={() => openTeamDialog('people')} /></TabsContent> : null}
            {selectedDepartment ? <TabsContent value="roles"><RolesView loading={!selectedSnapshot} roles={visibleRoles} members={selectedSnapshot?.memberships ?? []} onManage={() => openTeamDialog('roles')} /></TabsContent> : null}
            {selectedDepartment && selectedSnapshot ? <TabsContent value="access"><DepartmentAccessMatrix department={selectedDepartment} items={inventory} query={searchQuery} roles={selectedSnapshot.roles} onUpdated={() => void loadInventory()} /></TabsContent> : null}
          </Tabs> : <PersonalToolsView groups={personalGroups} onOpenDetails={group => navigate({ to: route.plugins.detail, params: { pluginId: group.id } } as never)} />
        ) : null}

        {/* The catalogue grid, drawn before it has content. A dashed "Checking
            your tool access" box used to stand in here — it reported the page
            as empty rather than as arriving, and collapsed the layout so the
            whole view jumped when the inventory landed. */}
        {inventory === null && !error ? (
          <section className="flex flex-col gap-3" aria-label="Available tools">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-3 w-96 max-w-full" />
            </div>
            <ToolCardGridSkeleton label="Checking your tool access" />
          </section>
        ) : null}
        {error ? <ToolsState title="Could not load tools" description="Your tool catalogue could not be checked against current access." action={<Button onClick={() => void loadInventory()}>Try again</Button>} /> : null}
      </main>

      {teamDialog ? <DepartmentTeamDialog department={teamDialog.department} initialFocus={teamDialog.focus} open onOpenChange={open => { if (!open) setTeamDialog(null) }} onChanged={() => void loadInventory()} /> : null}
      <ManagedToolSheet group={managedGroup} open={managedGroup !== null} onOpenChange={open => { if (!open) setManagedGroupId(null) }} onUpdated={() => void loadInventory()} />
    </div>
  )
}

function PersonalToolsView({ groups, onOpenDetails }: { groups: ToolPresentationGroup[]; onOpenDetails: (group: ToolPresentationGroup) => void }) {
  return (
    <section className="flex max-w-xl flex-col gap-3" aria-label="Your tools">
      <div>
        <h2 className="text-base font-medium">Your connections</h2>
        <p className="mt-1 text-sm text-muted-foreground">Connect and manage the services you use with Divo.</p>
      </div>
      {groups.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {groups.map(group => <ToolCatalogueCard key={group.id} group={group} onManage={() => undefined} onOpenDetails={() => onOpenDetails(group)} />)}
        </div>
      ) : (
        <ToolsState compact title="Connections are not available" description="Ask your company admin to enable a connection for your role." />
      )}
    </section>
  )
}

function DepartmentScopeBar({ department, departments, snapshot, attentionCount, onDepartmentChange }: { department: { id: string; name: string }; departments: Array<{ id: string; name: string }>; snapshot?: DepartmentManagementSnapshot; attentionCount: number; onDepartmentChange: (id: string) => void }) {
  const managerCount = snapshot?.memberships.filter(member => member.roleSlug === 'MANAGER').length ?? 0
  return (
    <Card className="overflow-hidden border-border/70 bg-card/40 shadow-none">
      <CardContent className="grid p-0 md:grid-cols-[minmax(280px,1.3fr)_repeat(4,minmax(100px,.5fr))]">
        <div className="flex items-center gap-3 p-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted/40"><Building2 className="size-5 text-muted-foreground" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Managing department</p>
            <Select value={department.id} onValueChange={onDepartmentChange}>
              <SelectTrigger className="mt-1 h-8 w-full max-w-56 border-0 bg-transparent px-0 text-base font-medium shadow-none"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{departments.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
            <p className="truncate text-xs text-muted-foreground">You manage this department · Company policy is the ceiling</p>
          </div>
        </div>
        <ScopeMetric label="People" value={snapshot?.memberships.length} />
        <ScopeMetric label="Roles" value={snapshot?.roles.length} />
        <ScopeMetric label="Managers" value={snapshot ? managerCount : undefined} />
        <ScopeMetric label="Need attention" value={attentionCount} emphasize={attentionCount > 0} />
      </CardContent>
    </Card>
  )
}

function ScopeMetric({ label, value, emphasize = false }: { label: string; value?: number; emphasize?: boolean }) {
  return <div className="flex min-h-20 flex-col justify-center border-t border-border/60 px-4 md:border-l md:border-t-0">{value === undefined ? <Skeleton className="h-6 w-10" /> : <p className={cn('text-xl font-medium', emphasize && 'text-destructive')}>{value}</p>}<p className="text-xs text-muted-foreground">{label}</p></div>
}

function ToolFilters({ value, onChange, count }: { value: ToolFilter; onChange: (filter: ToolFilter) => void; count: number }) {
  const filters: Array<{ value: ToolFilter; label: string }> = [{ value: 'all', label: 'All' }, { value: 'ready', label: 'Ready' }, { value: 'approval', label: 'Approval required' }, { value: 'attention', label: 'Needs attention' }]
  return <div className="flex flex-wrap items-center gap-2">{filters.map(filter => <Button key={filter.value} variant={value === filter.value ? 'secondary' : 'outline'} size="sm" onClick={() => onChange(filter.value)}>{filter.label}</Button>)}<span className="ml-auto text-xs text-muted-foreground">{count} {count === 1 ? 'group' : 'groups'}</span></div>
}

function PeopleView({ loading, members, onManage }: { loading: boolean; members: DepartmentManagementMember[]; onManage: () => void }) {
  if (loading) return <PeopleTableSkeleton />
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3"><div><h2 className="text-base font-medium">Department people</h2><p className="mt-1 text-xs text-muted-foreground">Role assignment and effective team structure. Manager assignments remain company-admin managed.</p></div><Button variant="ghost" size="sm" onClick={onManage}>Manage team</Button></div>
      <Card className="overflow-hidden border-border/70 bg-card/30 shadow-none"><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Department role</TableHead><TableHead>Status</TableHead><TableHead className="w-14"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader><TableBody>{members.length ? members.map(member => <TableRow key={member.id}><TableCell><div className="flex items-center gap-3"><Avatar className="size-8"><AvatarFallback>{initials(member.name ?? member.email)}</AvatarFallback></Avatar><div className="min-w-0"><p className="truncate font-medium">{member.name ?? member.email}</p><p className="truncate text-xs text-muted-foreground">{member.email}</p></div></div></TableCell><TableCell><Badge variant="outline">{member.roleName}{member.roleSlug === 'MANAGER' ? ' · protected' : ''}</Badge></TableCell><TableCell><Badge variant="secondary">{member.status}</Badge></TableCell><TableCell><Button variant="ghost" size="icon" aria-label={`Manage ${member.email}`} onClick={onManage}><MoreHorizontal /></Button></TableCell></TableRow>) : <TableRow><TableCell colSpan={4} className="h-28 text-center text-muted-foreground">No people match this search.</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
    </section>
  )
}

function RolesView({ loading, roles, members, onManage }: { loading: boolean; roles: DepartmentManagementRole[]; members: DepartmentManagementMember[]; onManage: () => void }) {
  if (loading) return <RoleCardGridSkeleton />
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3"><div><h2 className="text-base font-medium">Department roles</h2><p className="mt-1 text-xs text-muted-foreground">Roles are the default access bundle; individual member exceptions stay exceptional.</p></div><Button variant="ghost" size="sm" onClick={onManage}>Manage roles</Button></div>
      {roles.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{roles.map(role => { const memberCount = members.filter(member => member.roleId === role.id).length; return <Card key={role.id} className="border-border/70 bg-card/30 shadow-none"><CardHeader className="gap-3 p-4 pb-2"><div className="flex items-start justify-between"><span className="flex size-9 items-center justify-center rounded-lg border bg-muted/40"><ShieldCheck className="size-4 text-muted-foreground" /></span><Badge variant={role.isSystem ? 'outline' : 'secondary'}>{role.isSystem ? 'Built-in' : 'Custom'}</Badge></div><div className="flex flex-col gap-1"><CardTitle className="text-base">{role.name}</CardTitle><CardDescription className="text-xs">{role.isSystem ? 'Protected department role' : 'Department-scoped custom role'}</CardDescription></div></CardHeader><CardContent className="p-4 pt-2"><p className="text-sm font-medium">{memberCount} {memberCount === 1 ? 'person' : 'people'}</p><p className="text-xs text-muted-foreground">Zoho visibility: {role.zohoReadScope}</p></CardContent><CardFooter className="border-t p-3"><Button className="w-full" variant="ghost" size="sm" onClick={onManage}>{role.isSystem ? 'View role' : 'Edit role'}</Button></CardFooter></Card> })}</div> : <ToolsState compact title="No matching roles" description="Try a role name or clear the search." />}
    </section>
  )
}

function ManagedToolSheet({ group, open, onOpenChange, onUpdated }: { group: ToolPresentationGroup | null; open: boolean; onOpenChange: (open: boolean) => void; onUpdated: () => void }) {
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent className="w-full overflow-y-auto sm:max-w-2xl"><SheetHeader className="border-b"><SheetTitle>{group ? `Manage ${group.title}` : 'Manage tool access'}</SheetTitle><SheetDescription>Configured and effective access returned by Divo. Company policy remains authoritative.</SheetDescription></SheetHeader>{group ? <div className="p-4"><ToolAccessSection items={group.childTools} embedded onUpdated={onUpdated} /></div> : null}</SheetContent></Sheet>
}

function CountBadge({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{children}</span>
}

/**
 * The dashed box is now for genuine dead ends only — no results, no access, a
 * failed load. Loading has its own shapes in `ToolSkeletons`, because "nothing
 * here" and "not here yet" are different things to say.
 */
function ToolsState({ title, description, action, compact = false }: { title: string; description: string; action?: ReactNode; compact?: boolean }) {
  return <div className={cn('rounded-lg border border-dashed border-border/70 text-center', compact ? 'p-4' : 'p-8')}><h2 className="font-medium">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p>{action ? <div className="mt-4">{action}</div> : null}</div>
}

function managedDepartments(items: DivoToolInventoryItem[]): Array<{ id: string; name: string }> {
  return [...new Map(items.flatMap(item => item.managementScopes.flatMap(scope => scope.kind === 'department' ? [[scope.department.id, scope.department] as const] : [])).values()).values()]
}

function filterMembers(members: DepartmentManagementMember[], query: string): DepartmentManagementMember[] {
  if (!query) return members
  return members.filter(member => [member.name, member.email, member.roleName, member.status].filter(Boolean).join(' ').toLocaleLowerCase().includes(query))
}

function filterRoles(roles: DepartmentManagementRole[], query: string): DepartmentManagementRole[] {
  if (!query) return roles
  return roles.filter(role => [role.name, role.slug, role.zohoReadScope, role.isSystem ? 'built-in protected' : 'custom'].join(' ').toLocaleLowerCase().includes(query))
}

function initials(value: string): string {
  return value.split(/\s|@/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?'
}

function searchPlaceholder(view: WorkspaceView): string {
  if (view === 'people') return 'Search people, email, or department role'
  if (view === 'roles') return 'Search roles or visibility scope'
  if (view === 'access') return 'Search tools or capabilities in the access map'
  return 'Search tools, categories, actions, or access source'
}
