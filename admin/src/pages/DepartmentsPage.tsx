import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Plus, Search, Building2, Users, Shield, Terminal, BookOpen, Settings, MoreHorizontal, Trash2, Archive, Globe, Lock, RefreshCw } from 'lucide-react'

import { useAdminAuth } from '../auth/AdminAuthProvider'
import { api } from '../lib/api'
import { roleLabel } from '../lib/labels'
import { cn } from '../lib/utils'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '../components/ui/avatar'
import { Input } from '../components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Skeleton } from '../components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Textarea } from '../components/ui/textarea'
import { ScrollArea } from '../components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip'
import { toast } from '../components/ui/use-toast'
import { Separator } from '../components/ui/separator'

type DepartmentListItem = {
  id: string
  companyId: string
  name: string
  slug: string
  description?: string | null
  status: string
  managerCount: number
  memberCount: number
  hasAgentConfig: boolean
  createdAt: string
  updatedAt: string
}

type DepartmentRole = {
  id: string
  name: string
  slug: string
  isSystem: boolean
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

type DepartmentMembership = {
  id: string
  userId: string
  name?: string | null
  email?: string | null
  roleId: string
  roleSlug: string
  roleName: string
  status: string
  createdAt: string
  updatedAt: string
}

type DepartmentToolPermission = {
  id: string
  roleId: string
  toolId: string
  allowed: boolean
}

type DepartmentUserOverride = {
  id: string
  userId: string
  toolId: string
  allowed: boolean
}

type DepartmentAvailableMember = {
  userId: string
  name?: string | null
  email?: string | null
  workspaceRole: string
  isLarkSynced?: boolean
  larkDisplayName?: string | null
  larkUserId?: string | null
  larkOpenId?: string | null
  larkSourceRoles?: string[]
}

type DepartmentCandidate = {
  channelIdentityId: string
  userId?: string
  name?: string | null
  email?: string | null
  workspaceRole?: string
  isWorkspaceMember: boolean
  isAlreadyAssigned: boolean
  larkDisplayName?: string | null
  larkUserId?: string | null
  larkOpenId?: string | null
  larkSourceRoles: string[]
}

type DepartmentAvailableTool = {
  toolId: string
  name: string
  description: string
  category: string
}

type DepartmentSkill = {
  id: string
  companyId: string
  departmentId?: string | null
  departmentName?: string | null
  scope: 'global' | 'department'
  name: string
  slug: string
  summary: string
  markdown: string
  tags: string[]
  status: string
  isSystem: boolean
  sortOrder: number
  source: 'database' | 'legacy'
  createdAt?: string
  updatedAt?: string
}

type DepartmentDetail = {
  department: {
    id: string
    companyId: string
    name: string
    slug: string
    description?: string | null
    status: string
    createdAt: string
    updatedAt: string
  }
  config: {
    systemPrompt: string
    skillsMarkdown: string
    isActive: boolean
  }
  roles: DepartmentRole[]
  memberships: DepartmentMembership[]
  toolPermissions: DepartmentToolPermission[]
  userOverrides: DepartmentUserOverride[]
  globalSkills: DepartmentSkill[]
  departmentSkills: DepartmentSkill[]
  availableMembers: DepartmentAvailableMember[]
  availableTools: DepartmentAvailableTool[]
}

const statusBadgeVariant = (status: string) =>
  status === 'active' ? 'outline' : 'secondary'

const memberLabel = (member: { name?: string | null; email?: string | null; userId: string }) =>
  member.name?.trim() || member.email?.trim() || member.userId

const DEPARTMENT_TABS = ['profile', 'prompt', 'skills', 'members', 'permissions'] as const

const isDepartmentTab = (value: string | null): value is (typeof DEPARTMENT_TABS)[number] =>
  Boolean(value && DEPARTMENT_TABS.includes(value as (typeof DEPARTMENT_TABS)[number]))

export const DepartmentsPage = () => {
  const { token, session } = useAdminAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [companyId, setCompanyId] = useState('')
  const [departments, setDepartments] = useState<DepartmentListItem[]>([])
  const [detail, setDetail] = useState<DepartmentDetail | null>(null)
  const [loadingList, setLoadingList] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isSkillDialogOpen, setIsSkillDialogOpen] = useState(false)
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null)
  const [departmentSearch, setDepartmentSearch] = useState('')

  const [newDepartmentName, setNewDepartmentName] = useState('')
  const [newDepartmentDescription, setNewDepartmentDescription] = useState('')
  const [newRoleName, setNewRoleName] = useState('')
  const [newRoleSlug, setNewRoleSlug] = useState('')
  const [membershipUserId, setMembershipUserId] = useState('')
  const [membershipRoleId, setMembershipRoleId] = useState('')
  const [memberSearch, setMemberSearch] = useState('')
  const [debouncedMemberSearch, setDebouncedMemberSearch] = useState('')
  const [candidateResults, setCandidateResults] = useState<DepartmentCandidate[]>([])
  const [searchingCandidates, setSearchingCandidates] = useState(false)
  const [pendingPermissionKey, setPendingPermissionKey] = useState<string | null>(null)
  const [overrideUserId, setOverrideUserId] = useState('')
  const [overrideToolId, setOverrideToolId] = useState('')
  const [overrideAllowed, setOverrideAllowed] = useState<'allow' | 'deny'>('allow')
  const [departmentForm, setDepartmentForm] = useState({ name: '', description: '', status: 'active' })
  const [configForm, setConfigForm] = useState({ systemPrompt: '', skillsMarkdown: '', isActive: true })
  const [skillForm, setSkillForm] = useState({
    name: '',
    slug: '',
    summary: '',
    markdown: '',
    tags: '',
    status: 'active',
  })

  const rawDepartmentId = searchParams.get('departmentId')
  const rawTab = searchParams.get('tab')
  const selectedDepartmentId = rawDepartmentId?.trim() || null
  const selectedTab: (typeof DEPARTMENT_TABS)[number] = isDepartmentTab(rawTab) ? rawTab : 'profile'

  const isSuperAdmin = session?.role === 'SUPER_ADMIN'
  const effectiveCompanyId = useMemo(
    () => (isSuperAdmin ? companyId.trim() : session?.companyId ?? ''),
    [companyId, isSuperAdmin, session?.companyId],
  )

  const updateSearchParam = useCallback(
    (updater: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(searchParams)
      updater(next)
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const selectDepartment = useCallback((departmentId: string | null) => {
    updateSearchParam((next) => {
      if (departmentId) {
        next.set('departmentId', departmentId)
      } else {
        next.delete('departmentId')
      }
    })
  }, [updateSearchParam])

  const loadDepartments = useCallback(async (options?: { silent?: boolean }) => {
    if (!token) return
    if (isSuperAdmin && !effectiveCompanyId) {
      setDepartments([])
      setDetail(null)
      selectDepartment(null)
      return
    }

    if (!options?.silent) setLoadingList(true)
    try {
      const query = effectiveCompanyId ? `?companyId=${encodeURIComponent(effectiveCompanyId)}` : ''
      const data = await api.get<DepartmentListItem[]>(`/api/admin/departments${query}`, token)
      setDepartments(data)
      const resolvedDepartmentId =
        selectedDepartmentId && data.some((department) => department.id === selectedDepartmentId)
          ? selectedDepartmentId
          : data[0]?.id ?? null
      if (resolvedDepartmentId !== selectedDepartmentId) {
        selectDepartment(resolvedDepartmentId)
      }
    } finally {
      setLoadingList(false)
    }
  }, [effectiveCompanyId, isSuperAdmin, selectDepartment, selectedDepartmentId, token])

  const loadDetail = useCallback(async (departmentId: string, options?: { silent?: boolean }) => {
    if (!token) return
    if (!options?.silent) setLoadingDetail(true)
    try {
      const data = await api.get<DepartmentDetail>(`/api/admin/departments/${departmentId}`, token)
      setDetail(data)
      setDepartmentForm({
        name: data.department.name,
        description: data.department.description ?? '',
        status: data.department.status,
      })
      setConfigForm({
        systemPrompt: data.config.systemPrompt,
        skillsMarkdown: data.config.skillsMarkdown,
        isActive: data.config.isActive,
      })
      setMembershipRoleId(data.roles.find((role) => role.isDefault)?.id ?? data.roles[0]?.id ?? '')
      setOverrideUserId(data.memberships[0]?.userId ?? '')
      setOverrideToolId(data.availableTools[0]?.toolId ?? '')
    } finally {
      setLoadingDetail(false)
    }
  }, [token])

  useEffect(() => {
    void loadDepartments()
  }, [effectiveCompanyId, isSuperAdmin, token]) // Reduced dependencies to avoid re-triggering on selection

  useEffect(() => {
    if (selectedDepartmentId) {
      void loadDetail(selectedDepartmentId)
    } else {
      setDetail(null)
    }
  }, [selectedDepartmentId, token])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedMemberSearch(memberSearch)
    }, 180)
    return () => window.clearTimeout(timeout)
  }, [memberSearch])

  useEffect(() => {
    if (!token || !selectedDepartmentId || !debouncedMemberSearch.trim()) {
      setCandidateResults([])
      setSearchingCandidates(false)
      return
    }

    let isActive = true
    setSearchingCandidates(true)

    void api
      .get<DepartmentCandidate[]>(
        `/api/admin/departments/${selectedDepartmentId}/candidates?query=${encodeURIComponent(debouncedMemberSearch.trim())}`,
        token,
      )
      .then((data) => {
        if (!isActive) return
        setCandidateResults(data)
      })
      .catch(() => {
        if (!isActive) return
        setCandidateResults([])
      })
      .finally(() => {
        if (!isActive) return
        setSearchingCandidates(false)
      })

    return () => {
      isActive = false
    }
  }, [debouncedMemberSearch, selectedDepartmentId, token])

  const refreshDetail = async () => {
    if (!selectedDepartmentId) return
    // Use silent refresh to avoid full UI flicker
    await Promise.all([
      loadDetail(selectedDepartmentId, { silent: true }),
      loadDepartments({ silent: true })
    ])
  }

  const createDepartment = async () => {
    if (!token || !newDepartmentName.trim()) return
    const created = await api.post<{ id: string }>(
      '/api/admin/departments',
      {
        companyId: isSuperAdmin ? effectiveCompanyId : undefined,
        name: newDepartmentName.trim(),
        description: newDepartmentDescription.trim() || undefined,
      },
      token,
    )
    toast({ title: 'Department created' })
    setNewDepartmentName('')
    setNewDepartmentDescription('')
    setIsCreateDialogOpen(false)
    await loadDepartments()
    selectDepartment(created.id)
  }

  const saveDepartment = async () => {
    if (!token || !selectedDepartmentId) return
    await api.put(
      `/api/admin/departments/${selectedDepartmentId}`,
      {
        name: departmentForm.name.trim(),
        description: departmentForm.description.trim() || null,
        status: departmentForm.status,
      },
      token,
    )
    toast({ title: 'Department updated' })
    await refreshDetail()
  }

  const archiveDepartment = async () => {
    if (!token || !selectedDepartmentId) return
    await api.post(`/api/admin/departments/${selectedDepartmentId}/archive`, {}, token)
    toast({ title: 'Department archived' })
    await refreshDetail()
  }

  const saveConfig = async () => {
    if (!token || !selectedDepartmentId) return
    await api.put(
      `/api/admin/departments/${selectedDepartmentId}/config`,
      configForm,
      token,
    )
    toast({ title: 'Prompt and skills saved' })
    await refreshDetail()
  }

  const openCreateSkillDialog = () => {
    setEditingSkillId(null)
    setSkillForm({
      name: '',
      slug: '',
      summary: '',
      markdown: '',
      tags: '',
      status: 'active',
    })
    setIsSkillDialogOpen(true)
  }

  const openEditSkillDialog = (skill: DepartmentSkill) => {
    setEditingSkillId(skill.id)
    setSkillForm({
      name: skill.name,
      slug: skill.slug,
      summary: skill.summary,
      markdown: skill.markdown,
      tags: skill.tags.join(', '),
      status: skill.status === 'archived' ? 'archived' : 'active',
    })
    setIsSkillDialogOpen(true)
  }

  const saveSkill = async () => {
    if (!token || !selectedDepartmentId || !skillForm.name.trim() || !skillForm.markdown.trim()) return
    const payload = {
      name: skillForm.name.trim(),
      slug: skillForm.slug.trim() || undefined,
      summary: skillForm.summary.trim() || undefined,
      markdown: skillForm.markdown.trim(),
      tags: skillForm.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      status: skillForm.status,
    }

    if (editingSkillId) {
      await api.put(
        `/api/admin/departments/${selectedDepartmentId}/skills/${editingSkillId}`,
        payload,
        token,
      )
      toast({ title: 'Department skill updated' })
    } else {
      await api.post(
        `/api/admin/departments/${selectedDepartmentId}/skills`,
        payload,
        token,
      )
      toast({ title: 'Department skill created' })
    }

    setIsSkillDialogOpen(false)
    setEditingSkillId(null)
    await refreshDetail()
  }

  const archiveSkill = async (skillId: string) => {
    if (!token || !selectedDepartmentId) return
    await api.post(`/api/admin/departments/${selectedDepartmentId}/skills/${skillId}/archive`, {}, token)
    toast({ title: 'Department skill archived' })
    await refreshDetail()
  }

  const createRole = async () => {
    if (!token || !selectedDepartmentId || !newRoleName.trim() || !newRoleSlug.trim()) return
    await api.post(
      `/api/admin/departments/${selectedDepartmentId}/roles`,
      { name: newRoleName.trim(), slug: newRoleSlug.trim() },
      token,
    )
    toast({ title: 'Role created' })
    setNewRoleName('')
    setNewRoleSlug('')
    await refreshDetail()
  }

  const deleteRole = async (roleId: string) => {
    if (!token || !selectedDepartmentId) return
    await api.delete(`/api/admin/departments/${selectedDepartmentId}/roles/${roleId}`, {}, token)
    toast({ title: 'Role deleted' })
    await refreshDetail()
  }

  const assignMember = async () => {
    if (!token || !selectedDepartmentId || !membershipUserId) return
    await api.put(
      `/api/admin/departments/${selectedDepartmentId}/memberships`,
      { userId: membershipUserId, roleId: membershipRoleId || undefined, status: 'active' },
      token,
    )
    toast({ title: 'Department membership saved' })
    await refreshDetail()
  }

  const assignMemberCandidate = async (candidate: DepartmentCandidate) => {
    if (!token || !selectedDepartmentId) return
    setMembershipUserId(candidate.userId ?? '')
    await api.put(
      `/api/admin/departments/${selectedDepartmentId}/memberships`,
      {
        userId: candidate.userId,
        channelIdentityId: candidate.channelIdentityId,
        roleId: membershipRoleId || undefined,
        status: 'active',
      },
      token,
    )
    toast({ title: 'Department membership saved' })
    await refreshDetail()
  }

  const updateMemberRole = async (userId: string, roleId: string) => {
    if (!token || !selectedDepartmentId) return
    await api.put(
      `/api/admin/departments/${selectedDepartmentId}/memberships`,
      { userId, roleId, status: 'active' },
      token,
    )
    toast({ title: 'Member role updated' })
    await refreshDetail()
  }

  const removeMember = async (userId: string) => {
    if (!token || !selectedDepartmentId) return
    await api.delete(`/api/admin/departments/${selectedDepartmentId}/memberships/${userId}`, {}, token)
    toast({ title: 'Member removed from department' })
    await refreshDetail()
  }

  const toggleRolePermission = async (roleId: string, toolId: string, allowed: boolean) => {
    if (!token || !selectedDepartmentId) return
    const key = `${roleId}:${toolId}`
    setPendingPermissionKey(key)
    try {
      await api.put(
        `/api/admin/departments/${selectedDepartmentId}/role-permissions/${roleId}/${toolId}`,
        { allowed },
        token,
      )
      await refreshDetail()
    } finally {
      setPendingPermissionKey(null)
    }
  }

  const saveUserOverride = async () => {
    if (!token || !selectedDepartmentId || !overrideUserId || !overrideToolId) return
    await api.put(
      `/api/admin/departments/${selectedDepartmentId}/user-overrides/${overrideUserId}/${overrideToolId}`,
      { allowed: overrideAllowed === 'allow' },
      token,
    )
    toast({ title: 'User override saved' })
    await refreshDetail()
  }

  const filteredDepartments = useMemo(() => {
    const q = departmentSearch.trim().toLowerCase()
    if (!q) return departments
    return departments.filter(
      (d) => d.name.toLowerCase().includes(q) || d.slug.toLowerCase().includes(q),
    )
  }, [departments, departmentSearch])

  const availableDepartmentCandidates = useMemo(() => {
    return candidateResults.filter((c) => !c.isAlreadyAssigned)
  }, [candidateResults])

  const rolePermissionMap = useMemo(() => {
    const map = new Map<string, boolean>()
    detail?.toolPermissions.forEach((p) => {
      map.set(`${p.roleId}:${p.toolId}`, p.allowed)
    })
    return map
  }, [detail?.toolPermissions])

  const candidateLabel = (candidate: DepartmentCandidate) =>
    candidate.name?.trim() || candidate.email?.trim() || candidate.larkDisplayName?.trim() || candidate.channelIdentityId

  const defaultRole = useMemo(
    () => detail?.roles.find((role) => role.isDefault) ?? null,
    [detail?.roles],
  )

  const setSelectedTab = (tab: (typeof DEPARTMENT_TABS)[number]) => {
    updateSearchParam((next) => {
      next.set('tab', tab)
    })
  }

  const setDefaultRole = async (roleId: string, roleName: string) => {
    if (!token || !selectedDepartmentId) return
    await api.put(
      `/api/admin/departments/${selectedDepartmentId}/roles/${roleId}`,
      { name: roleName, isDefault: true },
      token,
    )
    toast({ title: 'Default department role updated' })
    await refreshDetail()
  }

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex flex-col gap-6 w-full animate-in fade-in duration-700">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
              <Building2 className="h-6 w-6 text-primary" />
              Departments
            </h1>
            <p className="text-sm text-muted-foreground">
              Configure department prompts, skills, members, and scoped tool access.
            </p>
          </div>
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-end md:gap-4">
            {isSuperAdmin ? (
              <div className="w-full md:w-[320px] relative">
                <Input
                  value={companyId}
                  onChange={(event) => setCompanyId(event.target.value)}
                  placeholder="Paste workspace UUID"
                  className="bg-secondary/30 border-border/50 h-9 text-xs"
                />
              </div>
            ) : null}
            <Button
              type="button"
              onClick={() => setIsCreateDialogOpen(true)}
              className="bg-primary text-primary-foreground h-9 shadow-sm"
            >
              <Plus className="h-4 w-4 mr-2" />
              New Department
            </Button>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row h-[calc(100vh-180px)] gap-8 overflow-hidden">
          {/* Department List Sidebar */}
          <div className="w-full lg:w-80 flex flex-col border border-border/40 rounded-2xl bg-card/30 overflow-hidden shrink-0 shadow-2xl transition-all duration-300 backdrop-blur-sm">
            <div className="p-5 border-b border-border/40 bg-muted/20">
              <div className="flex items-center justify-between mb-4">
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
                  Business Units ({filteredDepartments.length})
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 hover:bg-accent/50" onClick={() => void loadDepartments()}>
                      <RefreshCw className={cn("h-3.5 w-3.5", loadingList && "animate-spin")} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Sync Directory</TooltipContent>
                </Tooltip>
              </div>
              <div className="relative group">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 group-focus-within:text-primary transition-colors" />
                <Input
                  value={departmentSearch}
                  onChange={(event) => setDepartmentSearch(event.target.value)}
                  placeholder="Filter departments..."
                  className="bg-background/50 border-border/30 h-9 text-xs pl-9 transition-all rounded-lg"
                />
              </div>
            </div>

            <ScrollArea className="flex-1">
              <div className="p-3 flex flex-col gap-2">
                {loadingList ? (
                  <div className="space-y-3 p-2">
                    <Skeleton className="h-16 w-full rounded-xl opacity-50" />
                    <Skeleton className="h-16 w-full rounded-xl opacity-30" />
                    <Skeleton className="h-16 w-full rounded-xl opacity-10" />
                  </div>
                ) : filteredDepartments.length === 0 ? (
                  <div className="p-8 text-center border border-dashed border-border/30 rounded-xl m-2 bg-muted/5">
                    <p className="text-[11px] font-medium text-muted-foreground">No units found.</p>
                  </div>
                ) : (
                  filteredDepartments.map((department) => {
                    const isActive = selectedDepartmentId === department.id
                    return (
                      <button
                        key={department.id}
                        type="button"
                        onClick={() => selectDepartment(department.id)}
                        className={cn(
                          "w-full group flex flex-col gap-2 p-4 rounded-xl border transition-all duration-300 text-left relative overflow-hidden",
                          isActive 
                            ? "bg-primary/[0.03] border-primary/30 shadow-lg" 
                            : "border-transparent hover:bg-muted/30 hover:border-border/40"
                        )}
                      >
                        {isActive && <div className="absolute top-0 left-0 w-1 h-full bg-primary" />}
                        <div className="flex items-start justify-between gap-2">
                          <span className={cn(
                            "text-sm font-bold truncate tracking-tight",
                            isActive ? "text-primary" : "text-foreground group-hover:text-primary transition-colors"
                          )}>
                            {department.name}
                          </span>
                          <Badge variant={statusBadgeVariant(department.status)} className="text-[8px] px-1.5 h-4 uppercase font-bold tracking-widest bg-muted/50 border-border/20">
                            {department.status}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 text-[10px] text-muted-foreground/70 font-bold uppercase tracking-tighter">
                          <div className="flex items-center gap-1">
                            <Users className="h-3 w-3" />
                            <span>{department.memberCount}</span>
                          </div>
                          <span>·</span>
                          <span className="font-mono text-[9px] opacity-60">{department.slug}</span>
                        </div>
                      </button>
                    )
                  })
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Department Detail View */}
          <div className="flex-1 border border-border/40 rounded-2xl bg-card/20 overflow-hidden flex flex-col shadow-2xl transition-all duration-500 backdrop-blur-sm">
            {loadingDetail ? (
              <div className="p-10 space-y-8">
                <div className="flex items-center gap-6">
                  <Skeleton className="h-16 w-16 rounded-2xl opacity-40" />
                  <div className="space-y-3">
                    <Skeleton className="h-8 w-64 opacity-40" />
                    <Skeleton className="h-4 w-40 opacity-20" />
                  </div>
                </div>
                <Skeleton className="h-[500px] w-full rounded-2xl opacity-10" />
              </div>
            ) : !detail ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-12 bg-muted/5">
                <div className="h-24 w-24 rounded-[2rem] bg-muted/20 flex items-center justify-center mb-8 border border-border/20 shadow-inner">
                  <Building2 className="h-10 w-10 text-muted-foreground/30" />
                </div>
                <h3 className="text-2xl font-bold text-foreground mb-3 tracking-tight">Select a Business Unit</h3>
                <p className="text-muted-foreground font-medium max-w-sm leading-relaxed">
                  Choose a department from the explorer to modify agent behavior, manage rosters, and audit tool permissions.
                </p>
              </div>
            ) : (
              <>
                <div className="p-8 border-b border-border/40 bg-muted/10 flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div className="flex items-center gap-6">
                    <div className="h-16 w-16 rounded-2xl bg-primary/5 border border-primary/20 flex items-center justify-center shrink-0 shadow-lg">
                      <span className="text-2xl font-bold text-primary">{detail.department.name[0].toUpperCase()}</span>
                    </div>
                    <div>
                      <h2 className="text-2xl font-bold tracking-tight text-foreground">{detail.department.name}</h2>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground/80 mt-1 font-medium">
                        <span className="font-mono bg-muted/30 px-2 py-0.5 rounded border border-border/20">{detail.department.id}</span>
                        <span>·</span>
                        <Badge variant="outline" className="h-5 text-[9px] font-bold uppercase tracking-widest bg-emerald-500/5 text-emerald-500 border-emerald-500/20">
                          {detail.department.status}
                        </Badge>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Button variant="outline" size="sm" onClick={() => void archiveDepartment()} className="h-9 px-4 text-[10px] font-bold uppercase tracking-widest border-border/60 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/20 transition-all">
                      <Archive className="h-3.5 w-3.5 mr-2" />
                      Archive Unit
                    </Button>
                    <Button variant="default" size="sm" onClick={() => void saveDepartment()} className="h-9 px-6 text-[10px] font-bold uppercase tracking-widest shadow-[0_0_20px_rgba(var(--primary),0.2)]">
                      <Settings className="h-3.5 w-3.5 mr-2" />
                      Save Configuration
                    </Button>
                  </div>
                </div>

                <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                  <Tabs value={selectedTab} onValueChange={(value) => {
                    if (isDepartmentTab(value)) setSelectedTab(value)
                  }} className="flex-1 flex flex-col min-h-0">
                    <div className="px-6 border-b border-border/50 bg-secondary/5 shrink-0">
                      <TabsList className="bg-transparent h-12 gap-6 border-none">
                        <TabsTrigger value="profile" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-12 text-xs font-bold tracking-wider uppercase transition-all">
                          Profile
                        </TabsTrigger>
                        <TabsTrigger value="prompt" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-12 text-xs font-bold tracking-wider uppercase transition-all">
                          Prompt
                        </TabsTrigger>
                        <TabsTrigger value="skills" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-12 text-xs font-bold tracking-wider uppercase transition-all">
                          Skills
                        </TabsTrigger>
                        <TabsTrigger value="members" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-12 text-xs font-bold tracking-wider uppercase transition-all">
                          Members
                        </TabsTrigger>
                        <TabsTrigger value="permissions" className="data-[state=active]:bg-transparent data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-0 h-12 text-xs font-bold tracking-wider uppercase transition-all">
                          Permissions
                        </TabsTrigger>
                      </TabsList>
                    </div>

                    <div className="flex-1 min-h-0">
                      <TabsContent value="profile" className="mt-0 h-full animate-in slide-in-from-bottom-2 duration-300 outline-none">
                        <ScrollArea className="h-full">
                          <div className="p-8 space-y-8">
                            <div className="grid gap-8 md:grid-cols-2">
                              <div className="space-y-2">
                                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">Department Name</label>
                                <Input
                                  value={departmentForm.name}
                                  onChange={(event) => setDepartmentForm((prev) => ({ ...prev, name: event.target.value }))}
                                  className="bg-background border-border/50 h-11 focus-visible:ring-primary/30"
                                />
                              </div>
                              <div className="space-y-2">
                                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">Status</label>
                                <Select
                                  value={departmentForm.status}
                                  onValueChange={(value) => setDepartmentForm((prev) => ({ ...prev, status: value }))}
                                >
                                  <SelectTrigger className="bg-background border-border/50 h-11 focus:ring-primary/30">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="active">Active</SelectItem>
                                    <SelectItem value="archived">Archived</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                            <div className="space-y-2">
                              <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">Description</label>
                              <Textarea
                                value={departmentForm.description}
                                onChange={(event) => setDepartmentForm((prev) => ({ ...prev, description: event.target.value }))}
                                rows={4}
                                className="bg-background border-border/50 text-foreground resize-none focus-visible:ring-primary/30"
                              />
                            </div>

                            <Separator className="bg-border/50" />

                            <div className="space-y-6">
                              <div className="flex items-center justify-between">
                                <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Custom Roles</h3>
                                <Badge variant="outline" className="text-[10px] font-bold uppercase">{detail.roles.length} Total</Badge>
                              </div>
                              
                              <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto] p-4 bg-secondary/10 border border-border/30 rounded-xl">
                                <div className="space-y-1.5">
                                  <label className="text-[10px] font-bold uppercase tracking-tighter text-muted-foreground/80 ml-1">Role Name</label>
                                  <Input
                                    value={newRoleName}
                                    onChange={(event) => setNewRoleName(event.target.value)}
                                    placeholder="e.g. Sales Lead"
                                    className="bg-background border-border/50 h-9 text-sm"
                                  />
                                </div>
                                <div className="space-y-1.5">
                                  <label className="text-[10px] font-bold uppercase tracking-tighter text-muted-foreground/80 ml-1">Role Slug</label>
                                  <Input
                                    value={newRoleSlug}
                                    onChange={(event) => setNewRoleSlug(event.target.value)}
                                    placeholder="e.g. sales-lead"
                                    className="bg-background border-border/50 h-9 text-sm font-mono"
                                  />
                                </div>
                                <div className="flex items-end">
                                  <Button onClick={() => void createRole()} variant="outline" className="h-9 px-4 text-xs font-bold uppercase tracking-wider">
                                    <Plus className="h-3.5 w-3.5 mr-2" />
                                    Add Role
                                  </Button>
                                </div>
                              </div>

                              <div className="grid gap-3">
                                {detail.roles.map((role) => (
                                  <div key={role.id} className="group flex items-center justify-between p-4 rounded-xl border border-border/30 bg-background hover:border-border/60 transition-colors">
                                    <div className="flex items-center gap-3">
                                      <div className="h-8 w-8 rounded-lg bg-secondary/50 flex items-center justify-center">
                                        <Shield className="h-4 w-4 text-muted-foreground" />
                                      </div>
                                      <div>
                                        <div className="text-sm font-bold text-foreground flex items-center gap-2">
                                          {role.name}
                                          {role.isDefault && <Badge variant="secondary" className="text-[9px] h-4 font-bold uppercase">Default</Badge>}
                                          {role.isSystem && <Badge variant="outline" className="text-[9px] h-4 font-bold uppercase">System</Badge>}
                                        </div>
                                        <div className="text-xs font-mono text-muted-foreground">{role.slug}</div>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                      {!role.isDefault && (
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          onClick={() => void setDefaultRole(role.id, role.name)}
                                          className="h-8 text-[10px] font-bold uppercase tracking-wider text-muted-foreground hover:text-primary"
                                        >
                                          Set Default
                                        </Button>
                                      )}
                                      {!role.isSystem && (
                                        <Button 
                                          variant="ghost" 
                                          size="sm" 
                                          onClick={() => void deleteRole(role.id)} 
                                          className="h-8 text-[10px] font-bold uppercase tracking-wider text-destructive hover:bg-destructive/10"
                                        >
                                          <Trash2 className="h-3.5 w-3.5" />
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </ScrollArea>
                      </TabsContent>

                      <TabsContent value="prompt" className="mt-0 h-full animate-in slide-in-from-bottom-2 duration-300 outline-none">
                        <ScrollArea className="h-full">
                          <div className="p-8 space-y-8">
                            <div className="space-y-4">
                              <div className="flex items-center justify-between ml-1">
                                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                                  <Terminal className="h-3.5 w-3.5" />
                                  Department System Prompt
                                </label>
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] font-mono text-muted-foreground uppercase">{configForm.systemPrompt.length} chars</span>
                                  <Separator orientation="vertical" className="h-3" />
                                  <Button 
                                    variant="ghost" 
                                    size="sm" 
                                    className="h-6 px-2 text-[10px] font-bold uppercase tracking-tighter"
                                    onClick={() => setConfigForm(prev => ({ ...prev, isActive: !prev.isActive }))}
                                  >
                                    {configForm.isActive ? <Lock className="h-3 w-3 mr-1 text-emerald-500" /> : <Shield className="h-3 w-3 mr-1 text-muted-foreground" />}
                                    {configForm.isActive ? 'Active' : 'Disabled'}
                                  </Button>
                                </div>
                              </div>
                              <div className="relative group">
                                <div className="absolute top-3 left-3 flex gap-1 pointer-events-none opacity-20 group-hover:opacity-100 transition-opacity">
                                  <div className="h-2 w-2 rounded-full bg-red-500" />
                                  <div className="h-2 w-2 rounded-full bg-amber-500" />
                                  <div className="h-2 w-2 rounded-full bg-emerald-500" />
                                </div>
                                <Textarea
                                  value={configForm.systemPrompt}
                                  onChange={(event) => setConfigForm((prev) => ({ ...prev, systemPrompt: event.target.value }))}
                                  rows={12}
                                  className="bg-[#050505] border-border/50 text-emerald-500 font-mono text-sm leading-relaxed p-6 pt-10 focus-visible:ring-emerald-500/20 resize-y rounded-xl shadow-inner"
                                  placeholder="# You are the Finance Department Agent..."
                                />
                              </div>
                            </div>

                            <div className="space-y-4">
                              <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1 flex items-center gap-2">
                                <BookOpen className="h-3.5 w-3.5" />
                                Static Skills Knowledge Base (Markdown)
                              </label>
                              <Textarea
                                value={configForm.skillsMarkdown}
                                onChange={(event) => setConfigForm((prev) => ({ ...prev, skillsMarkdown: event.target.value }))}
                                rows={15}
                                className="bg-background border-border/50 text-foreground font-mono text-sm leading-relaxed p-6 focus-visible:ring-primary/30 resize-y rounded-xl"
                                placeholder="## Skill: Invoice Processing..."
                              />
                            </div>

                            <div className="flex justify-end pt-4">
                              <Button onClick={() => void saveConfig()} className="bg-primary text-primary-foreground font-bold uppercase tracking-wider px-8 shadow-md">
                                Update Context
                              </Button>
                            </div>
                          </div>
                        </ScrollArea>
                      </TabsContent>

                      <TabsContent value="skills" className="mt-0 h-full animate-in slide-in-from-bottom-2 duration-300 outline-none">
                        <ScrollArea className="h-full">
                          <div className="p-8 space-y-8">
                            <div className="space-y-6">
                              <div className="flex items-center justify-between">
                                <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Global Playbooks</h3>
                                <Badge variant="secondary" className="text-[10px] font-bold uppercase">System Managed</Badge>
                              </div>
                              <div className="grid gap-4">
                                {detail.globalSkills.map((skill) => (
                                  <div key={skill.id} className="p-4 rounded-xl border border-border/30 bg-background/50 hover:bg-background transition-colors flex items-start justify-between gap-4">
                                    <div className="space-y-2">
                                      <div className="flex items-center gap-2">
                                        <span className="text-sm font-bold text-foreground">{skill.name}</span>
                                        <Badge variant="outline" className="text-[9px] h-4 uppercase border-border/50">Global</Badge>
                                      </div>
                                      <p className="text-xs text-muted-foreground line-clamp-2 max-w-2xl">{skill.summary}</p>
                                      <div className="flex flex-wrap gap-1.5 pt-1">
                                        {skill.tags.map((tag) => (
                                          <Badge key={tag} variant="secondary" className="text-[9px] h-4 px-1.5 font-medium">{tag}</Badge>
                                        ))}
                                      </div>
                                    </div>
                                    <div className="h-8 w-8 rounded-lg bg-secondary/50 flex items-center justify-center shrink-0">
                                      <Shield className="h-4 w-4 text-muted-foreground" />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>

                            <Separator className="bg-border/50" />

                            <div className="space-y-6">
                              <div className="flex items-center justify-between">
                                <div>
                                  <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Department Playbooks</h3>
                                  <p className="text-xs text-muted-foreground mt-1">Reusable workflows specific to this department.</p>
                                </div>
                                <Button onClick={openCreateSkillDialog} size="sm" className="h-8 px-4 text-xs font-bold uppercase tracking-wider">
                                  <Plus className="h-3.5 w-3.5 mr-2" />
                                  New Skill
                                </Button>
                              </div>

                              <div className="grid gap-4 md:grid-cols-2">
                                {detail.departmentSkills.map((skill) => (
                                  <div key={skill.id} className="group p-5 rounded-xl border border-border/30 bg-background hover:border-primary/30 transition-all">
                                    <div className="flex items-start justify-between gap-3 mb-3">
                                      <div className="space-y-1">
                                        <div className="text-sm font-bold text-foreground group-hover:text-primary transition-colors">{skill.name}</div>
                                        <div className="text-[10px] font-mono text-muted-foreground uppercase">{skill.slug}</div>
                                      </div>
                                      <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground">
                                            <MoreHorizontal className="h-4 w-4" />
                                          </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                          <DropdownMenuItem onClick={() => openEditSkillDialog(skill)}>
                                            Edit skill
                                          </DropdownMenuItem>
                                          {skill.status !== 'archived' && (
                                            <DropdownMenuItem onClick={() => void archiveSkill(skill.id)} className="text-destructive focus:text-destructive">
                                              Archive skill
                                            </DropdownMenuItem>
                                          )}
                                        </DropdownMenuContent>
                                      </DropdownMenu>
                                    </div>
                                    <p className="text-xs text-muted-foreground line-clamp-2 h-8 mb-4">{skill.summary}</p>
                                    <div className="flex items-center justify-between">
                                      <div className="flex flex-wrap gap-1">
                                        {skill.tags.slice(0, 2).map((tag) => (
                                          <Badge key={tag} variant="secondary" className="text-[9px] px-1.5 h-4 font-medium">{tag}</Badge>
                                        ))}
                                        {skill.tags.length > 2 && <span className="text-[9px] text-muted-foreground">+{skill.tags.length - 2}</span>}
                                      </div>
                                      <Badge variant={statusBadgeVariant(skill.status)} className="text-[9px] px-1.5 h-4 uppercase font-bold tracking-tighter">
                                        {skill.status}
                                      </Badge>
                                    </div>
                                  </div>
                                ))}
                                {detail.departmentSkills.length === 0 && (
                                  <div className="col-span-full py-12 flex flex-col items-center justify-center border border-dashed border-border/50 rounded-xl bg-secondary/5">
                                    <BookOpen className="h-8 w-8 text-muted-foreground/30 mb-3" />
                                    <p className="text-sm text-muted-foreground">No department-specific skills yet.</p>
                                    <Button variant="link" onClick={openCreateSkillDialog} className="text-xs font-bold uppercase tracking-widest h-8 mt-2">
                                      Create First Skill
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </ScrollArea>
                      </TabsContent>

                      <TabsContent value="members" className="mt-0 h-full animate-in slide-in-from-bottom-2 duration-300 outline-none">
                        <ScrollArea className="h-full">
                          <div className="p-8 space-y-8">
                            <div className="p-6 rounded-xl border border-border/30 bg-secondary/10 space-y-6">
                              <div className="space-y-1">
                                <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Onboard Sync Members</h3>
                                <p className="text-xs text-muted-foreground">Search and add users from the workspace directory.</p>
                              </div>

                              <div className="grid gap-4 md:grid-cols-[1fr_200px]">
                                <div className="relative group">
                                  <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground group-focus-within:text-foreground transition-colors" />
                                  <Input
                                    value={memberSearch}
                                    onChange={(event) => setMemberSearch(event.target.value)}
                                    placeholder="Search by name, email or Lark role..."
                                    className="bg-background border-border/50 h-10 pl-9"
                                  />
                                </div>
                                <Select value={membershipRoleId} onValueChange={setMembershipRoleId}>
                                  <SelectTrigger className="bg-background border-border/50 h-10">
                                    <SelectValue placeholder="Add with role" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {detail.roles.map((role) => (
                                      <SelectItem key={role.id} value={role.id}>
                                        {role.name}{role.isDefault ? ' (Default)' : ''}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>

                              <div className="space-y-2 max-h-[300px] overflow-auto pr-2 custom-scrollbar">
                                {searchingCandidates ? (
                                  <div className="space-y-3">
                                    <Skeleton className="h-14 w-full rounded-xl" />
                                    <Skeleton className="h-14 w-full rounded-xl" />
                                  </div>
                                ) : availableDepartmentCandidates.map((member) => (
                                  <button
                                    key={member.channelIdentityId}
                                    type="button"
                                    onClick={() => void assignMemberCandidate(member)}
                                    className="w-full p-4 rounded-xl border border-border/30 bg-background hover:border-primary/30 hover:shadow-sm transition-all text-left flex items-center justify-between group"
                                  >
                                    <div className="flex items-center gap-4 min-w-0">
                                      <Avatar className="h-10 w-10 rounded-lg border border-border/50 shrink-0">
                                        <AvatarFallback className="rounded-lg bg-secondary text-secondary-foreground text-xs font-bold uppercase">
                                          {candidateLabel(member)[0]}
                                        </AvatarFallback>
                                      </Avatar>
                                      <div className="min-w-0">
                                        <div className="text-sm font-bold text-foreground group-hover:text-primary transition-colors truncate">{candidateLabel(member)}</div>
                                        <div className="text-[10px] text-muted-foreground truncate">{member.email || 'No email synced'}</div>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <Badge variant="outline" className="text-[9px] font-bold uppercase bg-secondary/30 h-5">
                                        {member.workspaceRole ? roleLabel(member.workspaceRole) : 'Synced'}
                                      </Badge>
                                      <div className="h-8 w-8 rounded-full bg-secondary/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                        <Plus className="h-4 w-4 text-primary" />
                                      </div>
                                    </div>
                                  </button>
                                ))}
                                {!searchingCandidates && debouncedMemberSearch.trim().length > 0 && availableDepartmentCandidates.length === 0 && (
                                  <div className="text-center py-8 border border-dashed border-border/50 rounded-xl">
                                    <p className="text-xs text-muted-foreground font-medium">No users matching your search.</p>
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="space-y-4">
                              <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground ml-1">Current Department Roster</h3>
                              <div className="grid gap-3">
                                {detail.memberships.map((membership) => (
                                  <div key={membership.id} className="group p-4 rounded-xl border border-border/30 bg-background hover:bg-secondary/5 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4">
                                    <div className="flex items-center gap-4 min-w-0">
                                      <Avatar className="h-10 w-10 rounded-lg border border-border/50">
                                        <AvatarFallback className="rounded-lg bg-primary/5 text-primary text-xs font-bold uppercase">
                                          {memberLabel(membership)[0]}
                                        </AvatarFallback>
                                      </Avatar>
                                      <div className="min-w-0">
                                        <div className="text-sm font-bold text-foreground truncate">{memberLabel(membership)}</div>
                                        <div className="text-xs text-muted-foreground truncate">{membership.email || 'No email'}</div>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                      <Select
                                        value={membership.roleId}
                                        onValueChange={(value) => void updateMemberRole(membership.userId, value)}
                                      >
                                        <SelectTrigger className="w-[160px] h-9 text-xs bg-background border-border/50 focus:ring-primary/20">
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {detail.roles.map((role) => (
                                            <SelectItem key={role.id} value={role.id}>
                                              {role.name}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                      <Button variant="ghost" size="icon" onClick={() => void removeMember(membership.userId)} className="h-9 w-9 text-muted-foreground hover:text-destructive hover:bg-destructive/10">
                                        <Trash2 className="h-4 w-4" />
                                      </Button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </ScrollArea>
                      </TabsContent>

                      <TabsContent value="permissions" className="mt-0 h-full animate-in slide-in-from-bottom-2 duration-300 outline-none">
                        <ScrollArea className="h-full">
                          <div className="p-8 space-y-8">
                            <div className="rounded-xl border border-border/50 bg-card overflow-hidden shadow-inner shadow-black/5">
                              <Table>
                                <TableHeader className="bg-secondary/20">
                                  <TableRow className="hover:bg-transparent border-border/50">
                                    <TableHead className="w-[240px] text-[10px] font-bold uppercase tracking-widest text-muted-foreground py-4">Control Tool</TableHead>
                                    {detail.roles.map((role) => (
                                      <TableHead key={role.id} className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground py-4 text-center">
                                        {role.name}
                                      </TableHead>
                                    ))}
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {detail.availableTools.map((tool) => (
                                    <TableRow key={tool.toolId} className="border-border/50 hover:bg-secondary/5 transition-colors">
                                      <TableCell className="py-5">
                                        <div className="text-sm font-bold text-foreground">{tool.name}</div>
                                        <div className="text-[10px] font-mono text-muted-foreground mt-0.5 uppercase tracking-tighter">{tool.toolId}</div>
                                      </TableCell>
                                      {detail.roles.map((role) => {
                                        const key = `${role.id}:${tool.toolId}`
                                        const allowed =
                                          rolePermissionMap.get(key)
                                          ?? (role.slug === 'MANAGER'
                                            ? true
                                            : tool.toolId === 'search-read' || tool.toolId === 'search-agent' || tool.toolId === 'skill-search')
                                        const isPending = pendingPermissionKey === key
                                        return (
                                          <TableCell key={key} className="text-center py-5">
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              disabled={isPending}
                                              onClick={() => void toggleRolePermission(role.id, tool.toolId, !allowed)}
                                              className={cn(
                                                "h-8 px-4 text-[10px] font-bold uppercase tracking-widest transition-all shadow-sm",
                                                allowed
                                                  ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 hover:bg-emerald-500/20"
                                                  : "bg-secondary/30 border-border/50 text-muted-foreground hover:bg-secondary/50"
                                              )}
                                            >
                                              {isPending ? 'Syncing...' : allowed ? 'Allowed' : 'Blocked'}
                                            </Button>
                                          </TableCell>
                                        )
                                      })}
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </div>

                            <div className="p-6 rounded-xl border border-border/30 bg-secondary/10 space-y-6">
                              <div className="space-y-1">
                                <h3 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">User-Specific Overrides</h3>
                                <p className="text-xs text-muted-foreground">Force allow or deny specific tools for individual members, bypassing role defaults.</p>
                              </div>
                              
                              <div className="grid gap-3 md:grid-cols-[1fr_1fr_120px_auto] items-end">
                                <div className="space-y-1.5">
                                  <label className="text-[10px] font-bold uppercase tracking-tighter text-muted-foreground/80 ml-1">Member</label>
                                  <Select value={overrideUserId} onValueChange={setOverrideUserId}>
                                    <SelectTrigger className="bg-background border-border/50 h-9 text-xs">
                                      <SelectValue placeholder="Select member" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {detail.memberships.map((membership) => (
                                        <SelectItem key={membership.userId} value={membership.userId}>
                                          {memberLabel(membership)}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-1.5">
                                  <label className="text-[10px] font-bold uppercase tracking-tighter text-muted-foreground/80 ml-1">Tool</label>
                                  <Select value={overrideToolId} onValueChange={setOverrideToolId}>
                                    <SelectTrigger className="bg-background border-border/50 h-9 text-xs">
                                      <SelectValue placeholder="Select tool" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {detail.availableTools.map((tool) => (
                                        <SelectItem key={tool.toolId} value={tool.toolId}>
                                          {tool.name}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>
                                <div className="space-y-1.5">
                                  <label className="text-[10px] font-bold uppercase tracking-tighter text-muted-foreground/80 ml-1">Policy</label>
                                  <Select value={overrideAllowed} onValueChange={(value) => setOverrideAllowed(value as 'allow' | 'deny')}>
                                    <SelectTrigger className="bg-background border-border/50 h-9 text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="allow">Allow</SelectItem>
                                      <SelectItem value="deny">Deny</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>
                                <Button onClick={() => void saveUserOverride()} className="h-9 px-4 text-xs font-bold uppercase tracking-wider">
                                  Apply
                                </Button>
                              </div>

                              <div className="grid gap-2">
                                {detail.userOverrides.map((override) => (
                                  <div key={override.id} className="flex items-center justify-between p-3 rounded-lg border border-border/30 bg-background text-[11px]">
                                    <div className="font-medium">
                                      <span className="text-foreground">{memberLabel(detail.memberships.find((m) => m.userId === override.userId) || { userId: override.userId })}</span>
                                      <span className="text-muted-foreground mx-2">on</span>
                                      <span className="font-mono text-primary">{override.toolId}</span>
                                    </div>
                                    <Badge className={cn(
                                      "text-[9px] h-4 uppercase font-bold tracking-tighter",
                                      override.allowed ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20" : "bg-red-500/10 text-red-600 border-red-500/20"
                                    )} variant="outline">
                                      {override.allowed ? 'Force Allow' : 'Force Deny'}
                                    </Badge>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </ScrollArea>
                      </TabsContent>
                    </div>
                  </Tabs>
                </div>
              </>
            )}
          </div>
        </div>

        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
          <DialogContent className="max-w-md rounded-2xl">
            <DialogHeader>
              <DialogTitle className="text-xl font-bold">New Department</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Set up a new organizational unit to manage specific AI workflows and access.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-5 py-4">
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">Department Name</label>
                <Input
                  value={newDepartmentName}
                  onChange={(event) => setNewDepartmentName(event.target.value)}
                  placeholder="e.g. Technical Support"
                  className="h-11 bg-secondary/20 border-border/50"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">Description</label>
                <Textarea
                  value={newDepartmentDescription}
                  onChange={(event) => setNewDepartmentDescription(event.target.value)}
                  placeholder="What does this department do?"
                  rows={3}
                  className="bg-secondary/20 border-border/50 resize-none"
                />
              </div>
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="ghost" onClick={() => setIsCreateDialogOpen(false)} className="font-bold uppercase tracking-widest text-xs h-10">
                Cancel
              </Button>
              <Button onClick={() => void createDepartment()} className="bg-primary text-primary-foreground font-bold uppercase tracking-widest text-xs h-10 px-6">
                Create Department
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={isSkillDialogOpen} onOpenChange={setIsSkillDialogOpen}>
          <DialogContent className="max-w-4xl rounded-2xl h-[90vh] flex flex-col p-0 overflow-hidden">
            <div className="p-6 border-b border-border/50">
              <DialogHeader>
                <DialogTitle className="text-xl font-bold flex items-center gap-2">
                  <BookOpen className="h-5 w-5 text-primary" />
                  {editingSkillId ? 'Edit Skill Playbook' : 'New Skill Playbook'}
                </DialogTitle>
                <DialogDescription>
                  Define detailed procedures and knowledge for the department agent.
                </DialogDescription>
              </DialogHeader>
            </div>
            
            <ScrollArea className="flex-1 p-6">
              <div className="space-y-6 pb-4">
                <div className="grid gap-6 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">Skill Name</label>
                    <Input
                      value={skillForm.name}
                      onChange={(event) => setSkillForm((prev) => ({ ...prev, name: event.target.value }))}
                      placeholder="e.g. Return Policy Verification"
                      className="bg-secondary/20 border-border/50 h-10"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">Slug</label>
                    <Input
                      value={skillForm.slug}
                      onChange={(event) => setSkillForm((prev) => ({ ...prev, slug: event.target.value }))}
                      placeholder="e.g. return-policy-verification"
                      className="bg-secondary/20 border-border/50 h-10 font-mono"
                    />
                  </div>
                </div>
                
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">Summary</label>
                  <Input
                    value={skillForm.summary}
                    onChange={(event) => setSkillForm((prev) => ({ ...prev, summary: event.target.value }))}
                    placeholder="Briefly describe what this playbook covers"
                    className="bg-secondary/20 border-border/50 h-10"
                  />
                </div>

                <div className="grid gap-6 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">Tags (Comma Separated)</label>
                    <Input
                      value={skillForm.tags}
                      onChange={(event) => setSkillForm((prev) => ({ ...prev, tags: event.target.value }))}
                      placeholder="e.g. policy, returns, support"
                      className="bg-secondary/20 border-border/50 h-10"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">Status</label>
                    <Select value={skillForm.status} onValueChange={(value) => setSkillForm((prev) => ({ ...prev, status: value }))}>
                      <SelectTrigger className="bg-secondary/20 border-border/50 h-10">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="archived">Archived</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase tracking-widest text-muted-foreground ml-1">Markdown Body</label>
                  <Textarea
                    value={skillForm.markdown}
                    onChange={(event) => setSkillForm((prev) => ({ ...prev, markdown: event.target.value }))}
                    className="bg-[#050505] border-border/50 text-foreground font-mono text-sm min-h-[400px] p-6 focus-visible:ring-primary/20 leading-relaxed"
                    placeholder="# Playbook: Procedure for..."
                  />
                </div>
              </div>
            </ScrollArea>

            <div className="p-6 border-t border-border/50 bg-secondary/5">
              <DialogFooter className="gap-2 sm:gap-0">
                <Button variant="ghost" onClick={() => setIsSkillDialogOpen(false)} className="font-bold uppercase tracking-widest text-xs h-10">
                  Cancel
                </Button>
                <Button onClick={() => void saveSkill()} className="bg-primary text-primary-foreground font-bold uppercase tracking-widest text-xs h-10 px-8 shadow-md">
                  {editingSkillId ? 'Update Playbook' : 'Create Playbook'}
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}
