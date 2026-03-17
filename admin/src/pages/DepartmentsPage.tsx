import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'

import { useAdminAuth } from '../auth/AdminAuthProvider'
import { api } from '../lib/api'
import { roleLabel } from '../lib/labels'
import { cn } from '../lib/utils'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Skeleton } from '../components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table'
import { Textarea } from '../components/ui/textarea'
import { ScrollArea } from '../components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip'
import { toast } from '../components/ui/use-toast'

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

const pillForStatus = (status: string): string =>
  status === 'active'
    ? 'bg-emerald-950 text-emerald-300 border-emerald-900'
    : 'bg-zinc-900 text-zinc-400 border-zinc-800'

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
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
  const isDepartmentManager = session?.role === 'DEPARTMENT_MANAGER'
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

  const loadDepartments = useCallback(async () => {
    if (!token) return
    if (isSuperAdmin && !effectiveCompanyId) {
      setDepartments([])
      setDetail(null)
      selectDepartment(null)
      return
    }

    setLoadingList(true)
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

  const loadDetail = useCallback(async (departmentId: string) => {
    if (!token) return
    setLoadingDetail(true)
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
      setMembershipRoleId(data.roles[0]?.id ?? '')
      setOverrideUserId(data.memberships[0]?.userId ?? '')
      setOverrideToolId(data.availableTools[0]?.toolId ?? '')
    } finally {
      setLoadingDetail(false)
    }
  }, [token])

  useEffect(() => {
    void loadDepartments()
  }, [loadDepartments])

  useEffect(() => {
    if (selectedDepartmentId) {
      void loadDetail(selectedDepartmentId)
    } else {
      setDetail(null)
    }
  }, [loadDetail, selectedDepartmentId])

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
    await loadDetail(selectedDepartmentId)
    await loadDepartments()
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
    if (!token || !selectedDepartmentId || !membershipUserId || !membershipRoleId) return
    await api.put(
      `/api/admin/departments/${selectedDepartmentId}/memberships`,
      { userId: membershipUserId, roleId: membershipRoleId, status: 'active' },
      token,
    )
    toast({ title: 'Department membership saved' })
    await refreshDetail()
  }

  const assignMemberCandidate = async (candidate: DepartmentCandidate) => {
    if (!token || !selectedDepartmentId || !membershipRoleId) return
    setMembershipUserId(candidate.userId ?? '')
    await api.put(
      `/api/admin/departments/${selectedDepartmentId}/memberships`,
      {
        userId: candidate.userId,
        channelIdentityId: candidate.channelIdentityId,
        roleId: membershipRoleId,
        status: 'active',
      },
      token,
    )
    toast({ title: 'Member added to department' })
    setMemberSearch('')
    setCandidateResults([])
    await refreshDetail()
  }

  const removeMember = async (userId: string) => {
    if (!token || !selectedDepartmentId) return
    await api.delete(`/api/admin/departments/${selectedDepartmentId}/memberships/${userId}`, {}, token)
    toast({ title: 'Department membership removed' })
    await refreshDetail()
  }

  const updateMemberRole = async (userId: string, roleId: string) => {
    if (!token || !selectedDepartmentId) return
    await api.put(
      `/api/admin/departments/${selectedDepartmentId}/memberships`,
      { userId, roleId, status: 'active' },
      token,
    )
    toast({ title: 'Department member updated' })
    await refreshDetail()
  }

  const toggleRolePermission = async (roleId: string, toolId: string, nextAllowed: boolean) => {
    if (!token || !selectedDepartmentId || !detail) return
    const key = `${roleId}:${toolId}`
    const previousPermissions = detail.toolPermissions

    const existing = previousPermissions.find((row) => row.roleId === roleId && row.toolId === toolId)
    const nextPermissions = existing
      ? previousPermissions.map((row) =>
        row.roleId === roleId && row.toolId === toolId
          ? { ...row, allowed: nextAllowed }
          : row,
      )
      : [
        ...previousPermissions,
        {
          id: `optimistic:${key}`,
          roleId,
          toolId,
          allowed: nextAllowed,
        },
      ]

    setPendingPermissionKey(key)
    setDetail((prev) => (prev ? { ...prev, toolPermissions: nextPermissions } : prev))

    try {
      await api.put(
        `/api/admin/departments/${selectedDepartmentId}/role-permissions/${roleId}/${toolId}`,
        { allowed: nextAllowed },
        token,
      )
    } catch (error) {
      setDetail((prev) => (prev ? { ...prev, toolPermissions: previousPermissions } : prev))
      throw error
    } finally {
      setPendingPermissionKey((current) => (current === key ? null : current))
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

  const rolePermissionMap = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const row of detail?.toolPermissions ?? []) {
      map.set(`${row.roleId}:${row.toolId}`, row.allowed)
    }
    return map
  }, [detail?.toolPermissions])

  const availableDepartmentCandidates = useMemo(
    () => candidateResults.filter((candidate) => !candidate.isAlreadyAssigned),
    [candidateResults],
  )

  const filteredDepartments = useMemo(() => {
    const query = departmentSearch.trim().toLowerCase()
    if (!query) return departments
    return departments.filter((department) => {
      const name = department.name.toLowerCase()
      const slug = department.slug.toLowerCase()
      const description = (department.description ?? '').toLowerCase()
      return name.includes(query) || slug.includes(query) || description.includes(query)
    })
  }, [departments, departmentSearch])

  const candidateLabel = (candidate: DepartmentCandidate) =>
    candidate.name?.trim() || candidate.email?.trim() || candidate.larkDisplayName?.trim() || candidate.channelIdentityId

  const setSelectedTab = (tab: (typeof DEPARTMENT_TABS)[number]) => {
    updateSearchParam((next) => {
      next.set('tab', tab)
    })
  }

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex flex-col gap-6 w-full">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold text-zinc-100">Departments</h1>
          <p className="text-sm text-zinc-500">
            Configure department-specific prompts, skills, memberships, and Vercel tool access.
          </p>
        </div>
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-end md:gap-4">
          {isSuperAdmin ? (
            <div className="w-full md:w-[360px] space-y-2">
              <div className="text-sm text-zinc-400">Workspace ID</div>
              <Input
                value={companyId}
                onChange={(event) => setCompanyId(event.target.value)}
                placeholder="Paste workspace UUID"
                className="bg-[#0a0a0a] border-[#222]"
              />
            </div>
          ) : null}
          {!isDepartmentManager ? (
            <Button
              type="button"
              onClick={() => setIsCreateDialogOpen(true)}
              className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200"
            >
              <Plus className="h-4 w-4" />
              New Department
            </Button>
          ) : null}
        </div>
      </div>

      <div className={cn(
        "grid gap-6 items-start",
        sidebarCollapsed ? "lg:grid-cols-[92px_minmax(0,1fr)]" : "lg:grid-cols-[340px_minmax(0,1fr)]",
      )}>
        <Card className="bg-[#111] border-[#1a1a1a] text-zinc-300">
          <CardHeader className={cn("border-b border-[#1a1a1a]", sidebarCollapsed ? "p-3" : "p-6")}>
            <div className={cn("flex items-start justify-between gap-2", sidebarCollapsed && "flex-col items-center")}>
              <div className={cn("space-y-1 min-w-0", sidebarCollapsed && "hidden")}>
                <CardTitle className="text-zinc-100">Departments</CardTitle>
                <CardDescription className="text-zinc-500">
                  Pick a department to manage. Selection stays in the URL.
                </CardDescription>
              </div>
              <div className={cn("flex items-center gap-1", sidebarCollapsed && "flex-col")}>
                {!isDepartmentManager ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setIsCreateDialogOpen(true)}
                        className="h-8 w-8 text-zinc-400 hover:text-zinc-100 hover:bg-[#1a1a1a]"
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right" className="bg-[#1a1a1a] text-zinc-200 border-[#333]">
                      New department
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setSidebarCollapsed((prev) => !prev)}
                      className="h-8 w-8 text-zinc-400 hover:text-zinc-100 hover:bg-[#1a1a1a]"
                    >
                      {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="bg-[#1a1a1a] text-zinc-200 border-[#333]">
                    {sidebarCollapsed ? 'Expand list' : 'Collapse list'}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </CardHeader>

          <CardContent className={cn(sidebarCollapsed ? "p-2" : "p-6 pt-4")}>
            {!sidebarCollapsed ? (
              <div className="pb-4">
                <Input
                  value={departmentSearch}
                  onChange={(event) => setDepartmentSearch(event.target.value)}
                  placeholder="Search departments..."
                  className="bg-[#0a0a0a] border-[#222]"
                />
              </div>
            ) : null}

            <ScrollArea className="h-[min(680px,calc(100vh-320px))]">
              <div className={cn("grid gap-1", sidebarCollapsed ? "px-0" : "px-0")}>
                {loadingList ? (
                  <>
                    <Skeleton className="h-11 w-full" />
                    <Skeleton className="h-11 w-full" />
                    <Skeleton className="h-11 w-full" />
                  </>
                ) : filteredDepartments.length === 0 ? (
                  <div className={cn(
                    "rounded-md border border-dashed border-[#222] bg-[#0a0a0a] p-4 text-sm text-zinc-500",
                    sidebarCollapsed && "text-center p-3 text-xs",
                  )}>
                    No departments found.
                  </div>
                ) : (
                  filteredDepartments.map((department) => {
                    const isActive = selectedDepartmentId === department.id
                    const initial = (department.name.trim()[0] ?? 'D').toUpperCase()

                    const item = (
                      <button
                        key={department.id}
                        type="button"
                        onClick={() => selectDepartment(department.id)}
                        className={cn(
                          "w-full rounded-lg border border-transparent transition-colors",
                          isActive ? "bg-[#1a1a1a] text-zinc-100" : "text-zinc-400 hover:bg-[#101010] hover:text-zinc-200",
                          sidebarCollapsed ? "p-0" : "px-3 py-2",
                        )}
                      >
                        {sidebarCollapsed ? (
                          <div className={cn(
                            "mx-auto flex h-10 w-10 items-center justify-center rounded-lg border bg-[#0a0a0a] text-sm font-semibold",
                            isActive ? "border-[#333] bg-[#151515] text-zinc-100" : "border-[#222] text-zinc-300",
                          )}>
                            {initial}
                          </div>
                        ) : (
                          <div className="flex items-center gap-3">
                            <div className={cn(
                              "flex h-9 w-9 items-center justify-center rounded-lg border bg-[#0a0a0a] text-sm font-semibold",
                              isActive ? "border-[#333] bg-[#151515] text-zinc-100" : "border-[#222] text-zinc-300",
                            )}>
                              {initial}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">{department.name}</div>
                              <div className="truncate text-xs text-zinc-500">{department.slug}</div>
                            </div>
                            <div className="flex flex-col items-end gap-1">
                              <Badge className={cn("border", pillForStatus(department.status))} variant="outline">
                                {department.status}
                              </Badge>
                              <div className="text-[11px] text-zinc-500">
                                {department.memberCount} · {department.managerCount}
                              </div>
                            </div>
                          </div>
                        )}
                      </button>
                    )

                    if (sidebarCollapsed) {
                      return (
                        <Tooltip key={department.id}>
                          <TooltipTrigger asChild>{item}</TooltipTrigger>
                          <TooltipContent side="right" className="bg-[#1a1a1a] text-zinc-200 border-[#333]">
                            {department.name}
                          </TooltipContent>
                        </Tooltip>
                      )
                    }

                    return item
                  })
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="bg-[#111] border-[#1a1a1a] text-zinc-300">
          <CardHeader className="border-b border-[#1a1a1a]">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <CardTitle className="text-zinc-100">
                  {detail?.department.name ?? 'Department Detail'}
                </CardTitle>
                <CardDescription className="text-zinc-500">
                  Department managers can edit prompt, skills, members, roles, and tool access for their departments.
                </CardDescription>
              </div>
              {detail ? (
                <Badge className={cn("border", pillForStatus(detail.department.status))} variant="outline">
                  {detail.department.status}
                </Badge>
              ) : null}
            </div>
            {detail ? (
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-500">
                <span>{detail.memberships.length} members</span>
                <span>·</span>
                <span>{detail.roles.length} roles</span>
                <span>·</span>
                <span>{detail.availableTools.length} tools</span>
              </div>
            ) : null}
          </CardHeader>
          <CardContent className="pt-6">
            {loadingDetail ? (
              <div className="space-y-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : !detail ? (
              <div className="flex min-h-[420px] items-center justify-center rounded-md border border-dashed border-[#222] bg-[#0a0a0a] text-zinc-500">
                Select a department to inspect its configuration.
              </div>
            ) : (
              <Tabs value={selectedTab} onValueChange={(value) => {
                if (isDepartmentTab(value)) setSelectedTab(value)
              }} className="w-full">
                <TabsList className="grid w-full grid-cols-5 bg-[#0a0a0a] border border-[#1a1a1a] mb-6">
                  <TabsTrigger value="profile">Profile</TabsTrigger>
                  <TabsTrigger value="prompt">Prompt</TabsTrigger>
                  <TabsTrigger value="skills">Skills</TabsTrigger>
                  <TabsTrigger value="members">Members</TabsTrigger>
                  <TabsTrigger value="permissions">Permissions</TabsTrigger>
                </TabsList>

                    <TabsContent value="profile" className="space-y-6">
                      <div className="grid gap-6 md:grid-cols-2">
                        <div className="space-y-2">
                          <div className="text-sm font-medium text-zinc-400">Department name</div>
                          <Input
                            value={departmentForm.name}
                            onChange={(event) => setDepartmentForm((prev) => ({ ...prev, name: event.target.value }))}
                            className="bg-[#0a0a0a] border-[#222] h-10"
                          />
                        </div>
                        <div className="space-y-2">
                          <div className="text-sm font-medium text-zinc-400">Status</div>
                          <Select
                            value={departmentForm.status}
                            onValueChange={(value) => setDepartmentForm((prev) => ({ ...prev, status: value }))}
                            disabled={isDepartmentManager}
                          >
                            <SelectTrigger className="bg-[#0a0a0a] border-[#222] h-10">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                              <SelectItem value="active">active</SelectItem>
                              <SelectItem value="archived">archived</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="text-sm font-medium text-zinc-400">Description</div>
                        <Textarea
                          value={departmentForm.description}
                          onChange={(event) => setDepartmentForm((prev) => ({ ...prev, description: event.target.value }))}
                          rows={4}
                          className="bg-[#0a0a0a] border-[#222] text-zinc-200 resize-none"
                        />
                      </div>
                      <div className="flex gap-3 pt-2">
                        <Button onClick={() => void saveDepartment()} className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200">
                          Save Department
                        </Button>
                        {!isDepartmentManager ? (
                          <Button variant="outline" onClick={() => void archiveDepartment()} className="border-[#333] bg-[#0a0a0a] hover:bg-[#1a1a1a] hover:text-zinc-100">
                            Archive
                          </Button>
                        ) : null}
                      </div>

                      <div className="space-y-4 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-6 mt-8">
                        <div className="text-base font-medium text-zinc-100">Custom roles</div>
                        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                          <Input
                            value={newRoleName}
                            onChange={(event) => setNewRoleName(event.target.value)}
                            placeholder="Role name"
                            className="bg-[#050505] border-[#222]"
                          />
                          <Input
                            value={newRoleSlug}
                            onChange={(event) => setNewRoleSlug(event.target.value)}
                            placeholder="Role slug"
                            className="bg-[#050505] border-[#222]"
                          />
                          <Button onClick={() => void createRole()} variant="outline" className="border-[#333] bg-[#050505] hover:bg-[#111] hover:text-zinc-100">
                            Add Role
                          </Button>
                        </div>
                        <div className="space-y-2">
                          {detail.roles.map((role) => (
                            <div key={role.id} className="flex items-center justify-between rounded-lg border border-[#1a1a1a] bg-[#050505] px-4 py-3">
                              <div>
                                <div className="text-sm font-medium text-zinc-100">{role.name}</div>
                                <div className="text-xs text-zinc-500">{role.slug}</div>
                              </div>
                              <div className="flex items-center gap-2">
                                {role.isSystem ? <Badge variant="secondary" className="bg-[#1a1a1a] text-zinc-400 border border-[#222]">System</Badge> : null}
                                {role.isDefault ? <Badge variant="secondary" className="bg-[#1a1a1a] text-zinc-400 border border-[#222]">Default</Badge> : null}
                                {!role.isSystem ? (
                                  <Button variant="outline" size="sm" onClick={() => void deleteRole(role.id)} className="border-[#333] bg-[#111] h-7 text-xs hover:bg-[#1a1a1a] hover:text-zinc-100">
                                    Delete
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </TabsContent>

                    <TabsContent value="prompt" className="space-y-6">
                      <div className="space-y-2">
                        <div className="text-sm font-medium text-zinc-400">Department system prompt</div>
                        <Textarea
                          value={configForm.systemPrompt}
                          onChange={(event) => setConfigForm((prev) => ({ ...prev, systemPrompt: event.target.value }))}
                          rows={8}
                          className="bg-[#0a0a0a] border-[#222] text-zinc-200 font-mono resize-y"
                        />
                      </div>
                      <div className="space-y-2">
                        <div className="text-sm font-medium text-zinc-400">Skills Markdown</div>
                        <Textarea
                          value={configForm.skillsMarkdown}
                          onChange={(event) => setConfigForm((prev) => ({ ...prev, skillsMarkdown: event.target.value }))}
                          rows={12}
                          className="bg-[#0a0a0a] border-[#222] text-zinc-200 font-mono resize-y"
                        />
                      </div>
                      <div className="flex items-center gap-3 pt-2">
                        <Button onClick={() => void saveConfig()} className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200">
                          Save Prompt Context
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => setConfigForm((prev) => ({ ...prev, isActive: !prev.isActive }))}
                          className="border-[#333] bg-[#0a0a0a] hover:bg-[#1a1a1a] hover:text-zinc-100"
                        >
                          {configForm.isActive ? 'Disable config' : 'Enable config'}
                        </Button>
                      </div>
                    </TabsContent>

                    <TabsContent value="skills" className="space-y-6">
                      <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-6 space-y-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-base font-medium text-zinc-100">Global skills</div>
                            <div className="text-sm text-zinc-500 mt-1">
                              Default reusable skills available across departments. These are system-managed in v1.
                            </div>
                          </div>
                        </div>
                        <div className="space-y-3">
                          {detail.globalSkills.map((skill) => (
                            <div key={skill.id} className="rounded-lg border border-[#1a1a1a] bg-[#050505] px-4 py-3">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-zinc-100">{skill.name}</div>
                                  <div className="text-sm text-zinc-500 mt-0.5">{skill.summary}</div>
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    <Badge variant="outline" className="border-[#333] bg-[#111] text-zinc-400">{skill.scope}</Badge>
                                    {skill.isSystem ? (
                                      <Badge variant="outline" className="border-sky-900 bg-sky-950/30 text-sky-300">System</Badge>
                                    ) : null}
                                    {skill.tags.map((tag) => (
                                      <Badge key={tag} variant="outline" className="border-[#333] bg-[#111] text-zinc-400">{tag}</Badge>
                                    ))}
                                  </div>
                                </div>
                                <Badge variant="outline" className={`border ${pillForStatus(skill.status)}`}>{skill.status}</Badge>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-6 space-y-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-base font-medium text-zinc-100">Department skills</div>
                            <div className="text-sm text-zinc-500 mt-1">
                              Create reusable department-specific playbooks like finance approvals, close checklists, or invoice flows.
                            </div>
                          </div>
                          <Button onClick={openCreateSkillDialog} className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200">
                            <Plus className="mr-2 h-4 w-4" />
                            New Skill
                          </Button>
                        </div>

                        <div className="space-y-3">
                          {detail.departmentSkills.map((skill) => (
                            <div key={skill.id} className="rounded-lg border border-[#1a1a1a] bg-[#050505] px-4 py-3">
                              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-zinc-100">{skill.name}</div>
                                  <div className="text-sm text-zinc-500 mt-0.5">{skill.summary}</div>
                                  <div className="mt-1 text-xs font-mono text-zinc-600">{skill.slug}</div>
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    <Badge variant="outline" className="border-[#333] bg-[#111] text-zinc-400">{skill.scope}</Badge>
                                    <Badge variant="outline" className={`border ${pillForStatus(skill.status)}`}>{skill.status}</Badge>
                                    {skill.tags.map((tag) => (
                                      <Badge key={tag} variant="outline" className="border-[#333] bg-[#111] text-zinc-400">{tag}</Badge>
                                    ))}
                                  </div>
                                </div>
                                <div className="flex gap-2">
                                  <Button variant="outline" size="sm" onClick={() => openEditSkillDialog(skill)} className="border-[#333] bg-[#111] hover:bg-[#1a1a1a] hover:text-zinc-100">
                                    Edit
                                  </Button>
                                  {skill.status !== 'archived' ? (
                                    <Button variant="outline" size="sm" onClick={() => void archiveSkill(skill.id)} className="border-[#333] bg-[#111] hover:bg-[#1a1a1a] hover:text-zinc-100">
                                      Archive
                                    </Button>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          ))}
                          {detail.departmentSkills.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-[#222] bg-[#050505] p-4 text-sm text-zinc-500 text-center">
                              No department-specific skills yet.
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </TabsContent>

                    <TabsContent value="members" className="space-y-6">
                      <div className="rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-6 space-y-4">
                        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                          <div>
                            <div className="text-base font-medium text-zinc-100">Add members from synced workspace users</div>
                            <div className="text-sm text-zinc-500 mt-1">
                              Search by name, email, Lark display name, or Lark role.
                            </div>
                          </div>
                          <div className="w-full md:w-[260px]">
                            <Select value={membershipRoleId} onValueChange={setMembershipRoleId}>
                              <SelectTrigger className="bg-[#050505] border-[#222]">
                                <SelectValue placeholder="Choose department role" />
                              </SelectTrigger>
                              <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                                {detail.roles.map((role) => (
                                  <SelectItem key={role.id} value={role.id}>
                                    {role.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <Input
                          value={memberSearch}
                          onChange={(event) => setMemberSearch(event.target.value)}
                          placeholder="Search synced Lark users from the workspace directory..."
                          className="bg-[#050505] border-[#222]"
                        />

                        {membershipUserId ? (
                          <div className="rounded-md border border-[#1a1a1a] bg-[#050505] px-3 py-2 text-xs text-zinc-400">
                            Manual selection: {memberLabel(detail.availableMembers.find((member) => member.userId === membershipUserId) ?? { userId: membershipUserId })}
                          </div>
                        ) : null}

                        <div className="space-y-2 max-h-[320px] overflow-auto custom-scrollbar">
                          {searchingCandidates ? (
                            <div className="rounded-md border border-[#1a1a1a] bg-[#050505] p-3 text-sm text-zinc-500">
                              Searching synced Lark users...
                            </div>
                          ) : null}
                          {availableDepartmentCandidates.map((member) => (
                            <button
                              key={member.channelIdentityId}
                              type="button"
                              onClick={() => void assignMemberCandidate(member)}
                              className="w-full rounded-md border border-[#1a1a1a] bg-[#050505] px-4 py-3 text-left transition-colors hover:border-[#333] hover:bg-[#090909]"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-zinc-100">{candidateLabel(member)}</div>
                                  <div className="text-xs text-zinc-500 mt-0.5">
                                    {member.email ?? 'No email'} · {member.workspaceRole ? roleLabel(member.workspaceRole) : 'Not yet a workspace member'}
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    <Badge variant="outline" className="border-sky-900 bg-sky-950/40 text-sky-300">Lark synced</Badge>
                                    {member.isWorkspaceMember ? (
                                      <Badge variant="outline" className="border-emerald-900 bg-emerald-950/30 text-emerald-300">Workspace member</Badge>
                                    ) : (
                                      <Badge variant="outline" className="border-amber-900 bg-amber-950/30 text-amber-300">Will be mapped on add</Badge>
                                    )}
                                    {member.larkDisplayName ? (
                                      <Badge variant="outline" className="border-[#333] bg-[#111] text-zinc-400">{member.larkDisplayName}</Badge>
                                    ) : null}
                                    {member.larkSourceRoles.slice(0, 3).map((role) => (
                                      <Badge key={role} variant="outline" className="border-[#333] bg-[#111] text-zinc-400">{role}</Badge>
                                    ))}
                                  </div>
                                </div>
                                <div className="text-xs text-zinc-500 shrink-0">Add</div>
                              </div>
                            </button>
                          ))}
                          {!searchingCandidates && debouncedMemberSearch.trim().length > 0 && availableDepartmentCandidates.length === 0 ? (
                            <div className="rounded-md border border-dashed border-[#222] bg-[#050505] p-3 text-sm text-zinc-500 text-center">
                              No synced Lark users matched your search.
                            </div>
                          ) : null}
                          {!searchingCandidates && debouncedMemberSearch.trim().length === 0 ? (
                            <div className="rounded-md border border-dashed border-[#222] bg-[#050505] p-3 text-sm text-zinc-500 text-center">
                              Start typing to search the synced Lark directory from the database.
                            </div>
                          ) : null}
                        </div>

                        <div className="grid gap-3 md:grid-cols-[1.2fr_auto] pt-2">
                          <Select value={membershipUserId} onValueChange={setMembershipUserId}>
                            <SelectTrigger className="bg-[#050505] border-[#222]">
                              <SelectValue placeholder="Or choose a user manually from workspace members" />
                            </SelectTrigger>
                            <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                              {detail.availableMembers.map((member) => (
                                <SelectItem key={member.userId} value={member.userId}>
                                  {memberLabel(member)} · {roleLabel(member.workspaceRole)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button onClick={() => void assignMember()} className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200">
                            Save Membership
                          </Button>
                        </div>
                      </div>

                      <div className="space-y-3">
                        {detail.memberships.map((membership) => (
                          <div key={membership.id} className="flex flex-col gap-3 rounded-lg border border-[#1a1a1a] bg-[#0a0a0a] px-4 py-3 md:flex-row md:items-center md:justify-between">
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-zinc-100">{memberLabel(membership)}</div>
                              <div className="text-xs text-zinc-500 mt-0.5">
                                {membership.email ?? 'No email'} · {membership.status}
                              </div>
                            </div>
                            <div className="flex flex-col gap-2 md:flex-row md:items-center">
                              <Select
                                value={membership.roleId}
                                onValueChange={(value) => void updateMemberRole(membership.userId, value)}
                              >
                                <SelectTrigger className="w-full min-w-[190px] bg-[#050505] border-[#222] h-9">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                                  {detail.roles.map((role) => (
                                    <SelectItem key={role.id} value={role.id}>
                                      {role.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button variant="outline" size="sm" onClick={() => void removeMember(membership.userId)} className="border-[#333] bg-[#050505] h-9 hover:bg-[#111] hover:text-zinc-100">
                                Remove
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </TabsContent>

                    <TabsContent value="permissions" className="space-y-6">
                      <div className="rounded-xl border border-[#1a1a1a] bg-[#111]">
                        <Table>
                          <TableHeader className="bg-[#0a0a0a]">
                            <TableRow className="border-b border-[#1a1a1a] hover:bg-transparent">
                              <TableHead className="w-[200px] text-zinc-500">Tool</TableHead>
                              {detail.roles.map((role) => (
                                <TableHead key={role.id} className="text-zinc-500">
                                  {role.name}
                                </TableHead>
                              ))}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {detail.availableTools.map((tool) => (
                              <TableRow key={tool.toolId} className="border-b border-[#1a1a1a] hover:bg-[#151515]">
                                <TableCell className="align-top font-medium text-zinc-100">
                                  <div>{tool.name}</div>
                                  <div className="text-xs font-normal text-zinc-500">{tool.toolId}</div>
                                </TableCell>
                                {detail.roles.map((role) => {
                                  const key = `${role.id}:${tool.toolId}`
                                  const allowed = rolePermissionMap.get(key) ?? (role.slug === 'MANAGER' ? true : tool.toolId === 'search-read' || tool.toolId === 'search-agent')
                                  const isPending = pendingPermissionKey === key
                                  return (
                                    <TableCell key={key}>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={isPending}
                                        onClick={() => void toggleRolePermission(role.id, tool.toolId, !allowed)}
                                        className={
                                          allowed
                                            ? 'border-emerald-900 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-950/60 disabled:opacity-70'
                                            : 'border-[#333] bg-[#0a0a0a] text-zinc-400 hover:bg-[#111] hover:text-zinc-300 disabled:opacity-70'
                                        }
                                      >
                                        {isPending ? 'Saving...' : allowed ? 'Allowed' : 'Blocked'}
                                      </Button>
                                    </TableCell>
                                  )
                                })}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>

                      <div className="space-y-4 rounded-xl border border-[#1a1a1a] bg-[#0a0a0a] p-6">
                        <div className="text-base font-medium text-zinc-100">User overrides</div>
                        <div className="grid gap-3 md:grid-cols-[1.2fr_1.2fr_0.8fr_auto]">
                          <Select value={overrideUserId} onValueChange={setOverrideUserId}>
                            <SelectTrigger className="bg-[#050505] border-[#222]">
                              <SelectValue placeholder="Choose department member" />
                            </SelectTrigger>
                            <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                              {detail.memberships.map((membership) => (
                                <SelectItem key={membership.userId} value={membership.userId}>
                                  {memberLabel(membership)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select value={overrideToolId} onValueChange={setOverrideToolId}>
                            <SelectTrigger className="bg-[#050505] border-[#222]">
                              <SelectValue placeholder="Choose tool" />
                            </SelectTrigger>
                            <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                              {detail.availableTools.map((tool) => (
                                <SelectItem key={tool.toolId} value={tool.toolId}>
                                  {tool.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select value={overrideAllowed} onValueChange={(value) => setOverrideAllowed(value as 'allow' | 'deny')}>
                            <SelectTrigger className="bg-[#050505] border-[#222]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                              <SelectItem value="allow">allow</SelectItem>
                              <SelectItem value="deny">deny</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button onClick={() => void saveUserOverride()} variant="outline" className="border-[#333] bg-[#050505] hover:bg-[#111] hover:text-zinc-100">
                            Save Override
                          </Button>
                        </div>

                        <div className="space-y-2">
                          {detail.userOverrides.map((override) => (
                            <div key={override.id} className="flex items-center justify-between rounded-lg border border-[#1a1a1a] bg-[#050505] px-4 py-3">
                              <div className="text-xs text-zinc-400">
                                {memberLabel(detail.memberships.find((membership) => membership.userId === override.userId) ?? { userId: override.userId })}
                                {' · '}
                                {override.toolId}
                              </div>
                              <Badge className={override.allowed ? 'border-emerald-900 bg-emerald-950/40 text-emerald-300' : 'border-red-900 bg-red-950/40 text-red-300'}>
                                {override.allowed ? 'allow' : 'deny'}
                              </Badge>
                            </div>
                          ))}
                          {detail.userOverrides.length === 0 ? (
                            <div className="text-xs text-zinc-500">No user-specific overrides yet.</div>
                          ) : null}
                        </div>
                      </div>
                    </TabsContent>
                  </Tabs>
                )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="border-[#1a1a1a] bg-[#111] text-zinc-200">
          <DialogHeader>
            <DialogTitle>Create Department</DialogTitle>
            <DialogDescription className="text-zinc-500">
              Create a new department and jump straight into configuring it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm text-zinc-400">Department name</div>
              <Input
                value={newDepartmentName}
                onChange={(event) => setNewDepartmentName(event.target.value)}
                placeholder="Support, Sales, Finance..."
                className="bg-[#0a0a0a] border-[#222]"
              />
            </div>
            <div className="space-y-2">
              <div className="text-sm text-zinc-400">Description</div>
              <Input
                value={newDepartmentDescription}
                onChange={(event) => setNewDepartmentDescription(event.target.value)}
                placeholder="Optional description"
                className="bg-[#0a0a0a] border-[#222]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)} className="border-[#333] bg-[#0a0a0a]">
              Cancel
            </Button>
            <Button onClick={() => void createDepartment()} className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200">
              Create Department
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isSkillDialogOpen} onOpenChange={setIsSkillDialogOpen}>
        <DialogContent className="border-[#1a1a1a] bg-[#111] text-zinc-200 max-w-3xl">
          <DialogHeader>
            <DialogTitle>{editingSkillId ? 'Edit Department Skill' : 'Create Department Skill'}</DialogTitle>
            <DialogDescription className="text-zinc-500">
              These skills are searchable by the agent inside this department and can be read on demand during complex workflows.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-sm text-zinc-400">Skill name</div>
                <Input
                  value={skillForm.name}
                  onChange={(event) => setSkillForm((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Invoice verification flow"
                  className="bg-[#0a0a0a] border-[#222]"
                />
              </div>
              <div className="space-y-2">
                <div className="text-sm text-zinc-400">Slug</div>
                <Input
                  value={skillForm.slug}
                  onChange={(event) => setSkillForm((prev) => ({ ...prev, slug: event.target.value }))}
                  placeholder="invoice-verification-flow"
                  className="bg-[#0a0a0a] border-[#222]"
                />
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-sm text-zinc-400">Summary</div>
              <Input
                value={skillForm.summary}
                onChange={(event) => setSkillForm((prev) => ({ ...prev, summary: event.target.value }))}
                placeholder="Short explanation of what this skill helps with"
                className="bg-[#0a0a0a] border-[#222]"
              />
            </div>
            <div className="grid gap-4 md:grid-cols-[1fr_180px]">
              <div className="space-y-2">
                <div className="text-sm text-zinc-400">Tags</div>
                <Input
                  value={skillForm.tags}
                  onChange={(event) => setSkillForm((prev) => ({ ...prev, tags: event.target.value }))}
                  placeholder="finance, invoices, approvals"
                  className="bg-[#0a0a0a] border-[#222]"
                />
              </div>
              <div className="space-y-2">
                <div className="text-sm text-zinc-400">Status</div>
                <Select value={skillForm.status} onValueChange={(value) => setSkillForm((prev) => ({ ...prev, status: value }))}>
                  <SelectTrigger className="bg-[#0a0a0a] border-[#222]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                    <SelectItem value="active">active</SelectItem>
                    <SelectItem value="archived">archived</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-sm text-zinc-400">Markdown body</div>
              <textarea
                value={skillForm.markdown}
                onChange={(event) => setSkillForm((prev) => ({ ...prev, markdown: event.target.value }))}
                rows={16}
                className="w-full rounded-md border border-[#222] bg-[#0a0a0a] px-3 py-2 text-sm text-zinc-200 outline-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsSkillDialogOpen(false)} className="border-[#333] bg-[#0a0a0a]">
              Cancel
            </Button>
            <Button onClick={() => void saveSkill()} className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200">
              {editingSkillId ? 'Save Skill' : 'Create Skill'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      </div>
    </TooltipProvider>
  )
}
