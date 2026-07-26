import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AlertTriangle, Building2, MoreHorizontal, RefreshCw, Search, ShieldCheck, UserPlus } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApprovalInbox } from '@/components/approvals/ApprovalInbox'
import { ToolCatalogueCard } from '@/components/tool-catalogue/ToolCatalogueCard'
import { ToolListTable, type ToolRow } from '@/components/tool-catalogue/ToolListTable'
import { PeopleTableSkeleton, RoleCardGridSkeleton, ToolCardGridSkeleton } from '@/components/tool-catalogue/ToolSkeletons'
import { DepartmentTeamDialog, type DepartmentTeamDialogFocus } from '@/components/tool-access/DepartmentTeamDialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import HeaderPage from '@/containers/HeaderPage'
import { route } from '@/constants/routes'
import {
  getDivoDepartmentManageSnapshot,
  getDivoDepartmentToolCoverage,
  getDivoToolsInventory,
  toolSearchText,
  type DepartmentCoverage,
  type DepartmentManagementMember,
  type DepartmentManagementRole,
  type DepartmentManagementSnapshot,
  type DivoToolInventoryItem,
} from '@/lib/divo-tools'
import { PERSONAL_CONNECTABLE_PLUGIN_IDS } from '@/lib/plugins'
import { isInUse } from '@/lib/tool-access-model'
import { readToolAccessScope, writeToolAccessScope } from '@/lib/tool-scope'
import { groupToolInventory, type ToolPresentationGroup } from '@/lib/tool-presentation'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/plugins/' as never)({
  component: PluginsRoute,
})

type WorkspaceView = 'tools' | 'people' | 'roles'

/**
 * Tools.
 *
 * The first choice on this page is *where am I working* — company policy, one
 * department, or a comparison — because a company admin managing a ceiling and
 * a manager granting access to their team are different jobs that used to share
 * one screen and one department dropdown buried in a stat card.
 */
export function PluginsRoute() {
  const navigate = useNavigate()
  const [inventory, setInventory] = useState<DivoToolInventoryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [view, setView] = useState<WorkspaceView>('tools')
  const [teamSnapshots, setTeamSnapshots] = useState<Record<string, DepartmentManagementSnapshot>>({})
  const [coverage, setCoverage] = useState<Record<string, DepartmentCoverage>>({})
  const [scopeId, setScopeId] = useState('')
  const [teamDialog, setTeamDialog] = useState<{ department: { id: string; name: string }; focus: DepartmentTeamDialogFocus } | null>(null)
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
      const [snapshots, coverages] = await Promise.all([
        Promise.allSettled(departments.map(async department => [department.id, await getDivoDepartmentManageSnapshot(department.id)] as const)),
        Promise.allSettled(departments.map(async department => [department.id, await getDivoDepartmentToolCoverage(department.id)] as const)),
      ])
      if (requestGeneration !== inventoryRequestGeneration.current) return
      setTeamSnapshots(Object.fromEntries(snapshots.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])))
      setCoverage(Object.fromEntries(coverages.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])))
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
  // A company scope exists only for someone who can edit the ceiling, which is
  // exactly the person the inventory hands a global management scope to.
  const canEditCompanyPolicy = (inventory ?? []).some(item => item.managementScopes.some(scope => scope.kind === 'global'))
  const scopes = useMemo(() => [
    ...(canEditCompanyPolicy ? [{ id: 'company', label: 'Company policy', hint: 'What every department is allowed to grant' }] : []),
    ...departments.map(department => ({ id: department.id, label: department.name, hint: 'Access inside this department' })),
  ], [canEditCompanyPolicy, departments])

  useEffect(() => {
    if (!scopes.length) { setScopeId(''); return }
    if (!scopes.some(scope => scope.id === scopeId)) {
      // Come back to the scope you were last working in, not always the first.
      const remembered = readToolAccessScope()
      const next = scopes.find(scope => scope.id === remembered)?.id ?? scopes[0]!.id
      setScopeId(next)
      writeToolAccessScope(next)
    }
  }, [scopes, scopeId])

  const selectedDepartment = departments.find(department => department.id === scopeId) ?? null
  const selectedSnapshot = selectedDepartment ? teamSnapshots[selectedDepartment.id] : undefined
  const selectedCoverage = selectedDepartment ? coverage[selectedDepartment.id] : undefined
  const allGroups = useMemo(() => groupToolInventory(inventory ?? []), [inventory])
  const hasManagementAccess = (inventory ?? []).some(item => item.managementScopes.length > 0)
  const personalGroups = useMemo(
    () => allGroups.filter(group => PERSONAL_CONNECTABLE_PLUGIN_IDS.includes(group.id)),
    [allGroups],
  )
  const searchQuery = search.trim().toLocaleLowerCase()

  const rows = useMemo<ToolRow[]>(() => allGroups
    .filter(group => !searchQuery || group.childTools.some(item => toolSearchText(item).includes(searchQuery)) || group.title.toLocaleLowerCase().includes(searchQuery))
    .map(group => ({
      group,
      coverage: (selectedCoverage?.tools ?? []).filter(entry => group.childTools.some(item => item.tool.toolId === entry.tool.toolId)),
    })), [allGroups, searchQuery, selectedCoverage])

  const inUse = rows.filter(row => row.coverage.some(isInUse))
  const notInUse = rows.filter(row => !row.coverage.some(isInUse))
  const visibleMembers = useMemo(() => filterMembers(selectedSnapshot?.memberships ?? [], searchQuery), [searchQuery, selectedSnapshot])
  const visibleRoles = useMemo(() => filterRoles(selectedSnapshot?.roles ?? [], searchQuery), [searchQuery, selectedSnapshot])
  const attention = (inventory ?? []).filter(item => item.readiness === 'connection_required' || item.readiness === 'admin_connection_required')

  const openTool = (group: ToolPresentationGroup) => navigate({
    to: route.plugins.detail,
    params: { pluginId: group.id },
  } as never)
  const openTeamDialog = (focus: DepartmentTeamDialogFocus) => {
    if (selectedDepartment) setTeamDialog({ department: selectedDepartment, focus })
  }

  return (
    <div className="flex h-svh w-full min-h-0 flex-col bg-background">
      {/* Every other route wears this titlebar. Without it, collapsing the
          sidebar here left the window with no navigation and no way back. */}
      <HeaderPage>
        <div className="mr-2 flex w-full items-center justify-end pr-3">
          <Button variant="outline" size="sm" onClick={() => void loadInventory()} disabled={inventory === null && !error}>
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
        </div>
      </HeaderPage>
      <main className="mx-auto flex w-full min-h-0 max-w-6xl flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-5 pt-2 pb-7 lg:px-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-medium tracking-tight">Tools</h1>
          <p className="text-sm text-muted-foreground">
            {inventory !== null && !error && !hasManagementAccess
              ? 'Connect the accounts you use with Divo, and see what you are allowed to do.'
              : canEditCompanyPolicy
                ? 'Set what the company allows, then manage any department in detail.'
                : 'Give your people the access they need, inside what the company allows.'}
          </p>
        </header>

        {/* A paused action outranks the catalogue: it is work someone is
            blocked on, not something to browse. */}
        {inventory !== null && !error ? <ApprovalInbox /> : null}

        {inventory !== null && !error ? (
          hasManagementAccess ? (
            <>
              {scopes.length > 1 ? (
                <div className="flex flex-wrap items-center gap-3">
                  <div className="inline-flex overflow-hidden rounded-lg border">
                    {scopes.map((scope, index) => (
                      <Button
                        key={scope.id}
                        variant={scopeId === scope.id ? 'secondary' : 'ghost'}
                        size="sm"
                        className={cn('rounded-none border-0', index > 0 && 'border-l')}
                        onClick={() => { setScopeId(scope.id); writeToolAccessScope(scope.id); setView('tools'); setSearch('') }}
                      >
                        {scope.id === 'company' ? <ShieldCheck data-icon="inline-start" /> : <Building2 data-icon="inline-start" />}
                        {scope.label}
                      </Button>
                    ))}
                  </div>
                  <span className="text-xs text-muted-foreground">{scopes.find(scope => scope.id === scopeId)?.hint}</span>
                </div>
              ) : selectedDepartment ? (
                <p className="text-xs text-muted-foreground">{selectedDepartment.name} · you manage this department</p>
              ) : null}

              {selectedDepartment ? (
                <DepartmentStats
                  people={selectedSnapshot?.memberships.length}
                  roles={selectedSnapshot?.roles.length}
                  inUse={selectedCoverage ? inUse.length : undefined}
                  attention={attention.length}
                />
              ) : null}

              <Tabs value={view} onValueChange={next => { setView(next as WorkspaceView); setSearch('') }} className="gap-5">
                <div className="flex flex-col justify-between gap-3 border-b sm:flex-row sm:items-end">
                  <TabsList variant="line" className="max-w-full justify-start overflow-x-auto">
                    <TabsTrigger value="tools">Tools <CountBadge>{allGroups.length}</CountBadge></TabsTrigger>
                    {selectedDepartment ? <TabsTrigger value="people">People <CountBadge>{selectedSnapshot?.memberships.length ?? 0}</CountBadge></TabsTrigger> : null}
                    {selectedDepartment ? <TabsTrigger value="roles">Groups <CountBadge>{selectedSnapshot?.roles.length ?? 0}</CountBadge></TabsTrigger> : null}
                  </TabsList>
                  {selectedDepartment ? (
                    <div className="flex gap-2 pb-2">
                      <Button variant="outline" size="sm" onClick={() => openTeamDialog('roles')}><ShieldCheck data-icon="inline-start" />New group</Button>
                      <Button size="sm" onClick={() => openTeamDialog('people')}><UserPlus data-icon="inline-start" />Add person</Button>
                    </div>
                  ) : null}
                </div>

                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={search} onChange={event => setSearch(event.target.value)} className="h-10 rounded-lg border-border/70 bg-muted/30 pl-9" placeholder={searchPlaceholder(view)} aria-label="Search tools workspace" />
                </div>

                <TabsContent value="tools" className="flex flex-col gap-5">
                  {attention.length > 0 ? (
                    <Alert className="border-border/70 bg-card/40">
                      <AlertTriangle />
                      <AlertTitle>{attention.length} {attention.length === 1 ? 'tool needs' : 'tools need'} a connection</AlertTitle>
                      <AlertDescription>
                        {[...new Set(attention.map(item => item.tool.name))].join(', ')} — access can be configured now, and starts working the moment an account is connected.
                      </AlertDescription>
                    </Alert>
                  ) : null}

                  {scopeId === 'company' ? (
                    <ToolSection
                      title="Company policy"
                      description="What any department is allowed to grant. Nothing here gives a tool to anybody."
                      rows={rows}
                      totalPeople={0}
                      showCoverage={false}
                      onOpen={openTool}
                    />
                  ) : selectedCoverage === undefined ? (
                    <ToolCardGridSkeleton label="Checking department access" />
                  ) : (
                    <>
                      <ToolSection
                        title={`In use by ${selectedDepartment?.name ?? 'this department'}`}
                        description="Effective access, approval rules, and connection readiness."
                        rows={inUse}
                        totalPeople={selectedCoverage.totalPeople}
                        showCoverage
                        onOpen={openTool}
                      />
                      {notInUse.length ? (
                        <ToolSection
                          title="Available, not turned on"
                          description="Nobody here has these yet. Open one to give a group access."
                          rows={notInUse}
                          totalPeople={selectedCoverage.totalPeople}
                          showCoverage
                          onOpen={openTool}
                        />
                      ) : null}
                    </>
                  )}
                </TabsContent>

                {selectedDepartment ? <TabsContent value="people"><PeopleView loading={!selectedSnapshot} members={visibleMembers} onManage={() => openTeamDialog('people')} /></TabsContent> : null}
                {selectedDepartment ? <TabsContent value="roles"><RolesView loading={!selectedSnapshot} roles={visibleRoles} members={selectedSnapshot?.memberships ?? []} onManage={() => openTeamDialog('roles')} /></TabsContent> : null}
              </Tabs>
            </>
          ) : <PersonalToolsView groups={personalGroups} onOpenDetails={openTool} />
        ) : null}

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
    </div>
  )
}

function ToolSection({ title, description, rows, totalPeople, showCoverage, onOpen }: {
  title: string
  description: string
  rows: ToolRow[]
  totalPeople: number
  showCoverage: boolean
  onOpen: (group: ToolPresentationGroup) => void
}) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">{title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <span className="text-xs text-muted-foreground">{rows.length} {rows.length === 1 ? 'tool' : 'tools'}</span>
      </div>
      <ToolListTable rows={rows} totalPeople={totalPeople} showCoverage={showCoverage} onOpen={onOpen} />
    </section>
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

function DepartmentStats({ people, roles, inUse, attention }: { people?: number; roles?: number; inUse?: number; attention: number }) {
  const cells: Array<[string, number | undefined, boolean]> = [
    ['People', people, false],
    ['Groups', roles, false],
    ['Tools in use', inUse, false],
    ['Need attention', attention, attention > 0],
  ]
  return (
    <Card className="overflow-hidden border-border/70 bg-card/40 shadow-none">
      <CardContent className="grid p-0 sm:grid-cols-4">
        {cells.map(([label, value, emphasise], index) => (
          <div key={label} className={cn('flex min-h-20 flex-col justify-center px-4 py-3', index > 0 && 'border-t sm:border-l sm:border-t-0')}>
            {value === undefined ? <Skeleton className="h-6 w-10" /> : <p className={cn('text-xl font-medium', emphasise && 'text-destructive')}>{value}</p>}
            <p className="text-xs text-muted-foreground">{label}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function PeopleView({ loading, members, onManage }: { loading: boolean; members: DepartmentManagementMember[]; onManage: () => void }) {
  if (loading) return <PeopleTableSkeleton />
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3"><div><h2 className="text-base font-medium">Department people</h2><p className="mt-1 text-xs text-muted-foreground">Group assignment and effective team structure. Manager assignments remain company-admin managed.</p></div><Button variant="ghost" size="sm" onClick={onManage}>Manage team</Button></div>
      <Card className="overflow-hidden border-border/70 bg-card/30 shadow-none"><CardContent className="p-0"><Table><TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Group</TableHead><TableHead>Status</TableHead><TableHead className="w-14"><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader><TableBody>{members.length ? members.map(member => <TableRow key={member.id}><TableCell><div className="flex items-center gap-3"><Avatar className="size-8"><AvatarFallback>{initials(member.name ?? member.email)}</AvatarFallback></Avatar><div className="min-w-0"><p className="truncate font-medium">{member.name ?? member.email}</p><p className="truncate text-xs text-muted-foreground">{member.email}</p></div></div></TableCell><TableCell><Badge variant="outline">{member.roleName}{member.roleSlug === 'MANAGER' ? ' · protected' : ''}</Badge></TableCell><TableCell><Badge variant="secondary">{member.status}</Badge></TableCell><TableCell><Button variant="ghost" size="icon" aria-label={`Manage ${member.email}`} onClick={onManage}><MoreHorizontal /></Button></TableCell></TableRow>) : <TableRow><TableCell colSpan={4} className="h-28 text-center text-muted-foreground">No people match this search.</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
    </section>
  )
}

function RolesView({ loading, roles, members, onManage }: { loading: boolean; roles: DepartmentManagementRole[]; members: DepartmentManagementMember[]; onManage: () => void }) {
  if (loading) return <RoleCardGridSkeleton />
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3"><div><h2 className="text-base font-medium">Department groups</h2><p className="mt-1 text-xs text-muted-foreground">A group is the default access bundle. Personal exceptions stay exceptional.</p></div><Button variant="ghost" size="sm" onClick={onManage}>Manage groups</Button></div>
      {roles.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{roles.map(role => { const memberCount = members.filter(member => member.roleId === role.id).length; return <Card key={role.id} className="border-border/70 bg-card/30 shadow-none"><CardHeader className="gap-3 p-4 pb-2"><div className="flex items-start justify-between"><span className="flex size-9 items-center justify-center rounded-lg border bg-muted/40"><ShieldCheck className="size-4 text-muted-foreground" /></span><Badge variant={role.isSystem ? 'outline' : 'secondary'}>{role.isSystem ? 'Built-in' : 'Custom'}</Badge></div><div className="flex flex-col gap-1"><CardTitle className="text-base">{role.name}</CardTitle><CardDescription className="text-xs">{role.isSystem ? 'Protected department group' : 'Department-scoped custom group'}</CardDescription></div></CardHeader><CardContent className="p-4 pt-2"><p className="text-sm font-medium">{memberCount} {memberCount === 1 ? 'person' : 'people'}</p><p className="text-xs text-muted-foreground">Zoho visibility: {role.zohoReadScope}</p></CardContent><CardFooter className="border-t p-3"><Button className="w-full" variant="ghost" size="sm" onClick={onManage}>{role.isSystem ? 'View group' : 'Edit group'}</Button></CardFooter></Card> })}</div> : <ToolsState compact title="No matching groups" description="Try a group name or clear the search." />}
    </section>
  )
}

function CountBadge({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{children}</span>
}

/**
 * The dashed box is for genuine dead ends only — no results, no access, a
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
  if (view === 'people') return 'Search people, email, or group'
  if (view === 'roles') return 'Search groups or visibility scope'
  return 'Search tools and capabilities'
}
