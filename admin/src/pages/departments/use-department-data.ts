import { useCallback, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import {
  agentsApi,
  departmentsApi,
  type CreateDepartmentInput,
  type CreateDepartmentRoleInput,
  type DepartmentCandidate,
  type DepartmentDetail,
  type DepartmentDetailSection,
  type DepartmentMembership,
  type DepartmentSummary,
  type UpdateDepartmentConfigInput,
  type UpdateDepartmentInput,
  type UpdateDepartmentRoleInput,
  type UpsertDepartmentMembershipInput,
} from "@/lib/api"
import { adminQueryKeys, getAdminQueryScope } from "@/lib/query-client"

type BackendToolRegistryEntry = {
  toolId: string
  name: string
  description: string | null
  category: string | null
  domain: string | null
  promptSnippet: string | null
  hitlRequired: boolean
  guardrails: string[]
  deprecated: boolean
}

type SectionLoadingMap = Record<string, Partial<Record<DepartmentDetailSection, boolean>>>

export type DepartmentToolCatalogEntry = {
  toolId: string
  name: string
  description: string
  family: "zoho" | "lark" | "google" | "context" | "execution" | "internal"
  deprecated: boolean
}

export type DepartmentDataState = {
  departments: DepartmentSummary[]
  detailById: Record<string, DepartmentDetail>
  toolCatalog: DepartmentToolCatalogEntry[]
  toolCatalogById: Record<string, DepartmentToolCatalogEntry>
  loading: boolean
  error: string | null
  stats: {
    total: number
    active: number
    archived: number
    members: number
    roles: number
  }
  refresh: () => Promise<void>
  loadDetailSection: (id: string, sections: DepartmentDetailSection | DepartmentDetailSection[], force?: boolean) => Promise<DepartmentDetail | null>
  isSectionLoaded: (id: string, section: DepartmentDetailSection) => boolean
  isSectionLoading: (id: string, section: DepartmentDetailSection) => boolean
  getSectionError: (id: string, section: DepartmentDetailSection) => string | null
  createDepartment: (data: CreateDepartmentInput) => Promise<{ id: string } | null>
  updateDepartment: (id: string, data: UpdateDepartmentInput) => Promise<void>
  archiveDepartment: (id: string) => Promise<void>
  createRole: (departmentId: string, data: CreateDepartmentRoleInput) => Promise<void>
  updateRole: (departmentId: string, roleId: string, data: UpdateDepartmentRoleInput) => Promise<void>
  deleteRole: (departmentId: string, roleId: string) => Promise<void>
  upsertMembership: (departmentId: string, data: UpsertDepartmentMembershipInput) => Promise<DepartmentMembership | null>
  removeMembership: (departmentId: string, userId: string) => Promise<void>
  searchCandidates: (departmentId: string, query: string) => Promise<DepartmentCandidate[]>
  setRolePermission: (departmentId: string, roleId: string, toolId: string, actionGroup: string, allowed: boolean) => Promise<void>
  setUserOverride: (departmentId: string, userId: string, toolId: string, actionGroup: string, allowed: boolean) => Promise<void>
  updateConfig: (departmentId: string, data: UpdateDepartmentConfigInput) => Promise<void>
}

function mapFamily(domain: string | null, category: string | null): DepartmentToolCatalogEntry["family"] {
  const value = (domain ?? category ?? "").toLowerCase()
  if (value.includes("lark")) return "lark"
  if (value.includes("google") || value.includes("gmail")) return "google"
  if (value.includes("zoho")) return "zoho"
  if (value.includes("context") || value.includes("rag") || value.includes("search")) return "context"
  if (value.includes("execution") || value.includes("terminal")) return "execution"
  return "internal"
}

function toToolCatalogEntry(tool: BackendToolRegistryEntry): DepartmentToolCatalogEntry {
  return {
    toolId: tool.toolId,
    name: tool.name,
    description: tool.description ?? "",
    family: mapFamily(tool.domain, tool.category),
    deprecated: tool.deprecated,
  }
}

function mergeDetail(previous: DepartmentDetail | undefined, incoming: DepartmentDetail): DepartmentDetail {
  if (!previous) {
    return {
      ...incoming,
      loadedSections: [...new Set(incoming.loadedSections)],
    }
  }

  const merged: DepartmentDetail = {
    ...previous,
    department: incoming.department,
    loadedSections: [...new Set([...previous.loadedSections, ...incoming.loadedSections])],
  }

  for (const section of incoming.loadedSections) {
    if (section === "config") {
      merged.config = incoming.config
      merged.departmentSkills = incoming.departmentSkills
      merged.globalSkills = incoming.globalSkills
    }

    if (section === "roles") {
      merged.roles = incoming.roles
    }

    if (section === "members") {
      merged.roles = incoming.roles
      merged.memberships = incoming.memberships
    }

    if (section === "permissions") {
      merged.roles = incoming.roles
      merged.memberships = incoming.memberships
      merged.toolPermissions = incoming.toolPermissions
      merged.userOverrides = incoming.userOverrides
      merged.availableTools = incoming.availableTools
    }
  }

  return merged
}

function toSectionArray(sections: DepartmentDetailSection | DepartmentDetailSection[]) {
  return [...new Set(Array.isArray(sections) ? sections : [sections])]
}

function patchRolePermission(
  detail: DepartmentDetail,
  roleId: string,
  toolId: string,
  actionGroup: string,
  allowed: boolean,
): DepartmentDetail {
  const existingIndex = detail.toolPermissions.findIndex(
    (permission) =>
      permission.roleId === roleId &&
      permission.toolId === toolId &&
      permission.actionGroup === actionGroup,
  )

  const toolPermissions = [...detail.toolPermissions]
  if (existingIndex >= 0) {
    toolPermissions[existingIndex] = {
      ...toolPermissions[existingIndex],
      allowed,
    }
  } else {
    toolPermissions.push({
      id: `optimistic-role:${roleId}:${toolId}:${actionGroup}`,
      roleId,
      toolId,
      actionGroup,
      allowed,
    })
  }

  return { ...detail, toolPermissions }
}

function patchUserOverride(
  detail: DepartmentDetail,
  userId: string,
  toolId: string,
  actionGroup: string,
  allowed: boolean,
): DepartmentDetail {
  const existingIndex = detail.userOverrides.findIndex(
    (override) =>
      override.userId === userId &&
      override.toolId === toolId &&
      override.actionGroup === actionGroup,
  )

  const userOverrides = [...detail.userOverrides]
  if (existingIndex >= 0) {
    userOverrides[existingIndex] = {
      ...userOverrides[existingIndex],
      allowed,
    }
  } else {
    userOverrides.push({
      id: `optimistic-user:${userId}:${toolId}:${actionGroup}`,
      userId,
      toolId,
      actionGroup,
      allowed,
    })
  }

  return { ...detail, userOverrides }
}

export function useDepartmentData(): DepartmentDataState {
  const { token } = useAdminAuth()
  const queryClient = useQueryClient()
  const scope = getAdminQueryScope(token)
  const [sectionErrorById, setSectionErrorById] = useState<Record<string, Partial<Record<DepartmentDetailSection, string | null>>>>({})
  const [sectionLoadingById, setSectionLoadingById] = useState<SectionLoadingMap>({})
  const departmentsQuery = useQuery({
    queryKey: adminQueryKeys.departments(scope),
    enabled: Boolean(token),
    queryFn: async () => {
      const departmentData = await departmentsApi.list(token ?? undefined)
      return Array.isArray(departmentData) ? departmentData : []
    },
  })
  const toolCatalogQuery = useQuery({
    queryKey: adminQueryKeys.toolRegistry(scope),
    enabled: Boolean(token),
    queryFn: async () => {
      const toolData = await agentsApi.toolRegistry<BackendToolRegistryEntry>(token ?? undefined)
      return Array.isArray(toolData) ? toolData.map(toToolCatalogEntry) : []
    },
  })
  const detailByIdQuery = useQuery({
    queryKey: adminQueryKeys.departmentDetails(scope),
    enabled: Boolean(token),
    queryFn: async () => ({} as Record<string, DepartmentDetail>),
    initialData: {} as Record<string, DepartmentDetail>,
    staleTime: Number.POSITIVE_INFINITY,
  })

  const departments = departmentsQuery.data ?? []
  const detailById = detailByIdQuery.data ?? {}
  const toolCatalog = toolCatalogQuery.data ?? []
  const loading = departmentsQuery.isPending || toolCatalogQuery.isPending
  const error = useMemo(() => {
    const source = departmentsQuery.error ?? toolCatalogQuery.error
    return source instanceof Error ? source.message : null
  }, [departmentsQuery.error, toolCatalogQuery.error])

  const isSectionLoaded = useCallback(
    (id: string, section: DepartmentDetailSection) => Boolean(detailById[id]?.loadedSections.includes(section)),
    [detailById],
  )

  const isSectionLoading = useCallback(
    (id: string, section: DepartmentDetailSection) => Boolean(sectionLoadingById[id]?.[section]),
    [sectionLoadingById],
  )

  const getSectionError = useCallback(
    (id: string, section: DepartmentDetailSection) => sectionErrorById[id]?.[section] ?? null,
    [sectionErrorById],
  )

  const loadDetailSection = useCallback(
    async (
      id: string,
      sections: DepartmentDetailSection | DepartmentDetailSection[],
      force = false,
    ): Promise<DepartmentDetail | null> => {
      if (!token) return null

      const requestedSections = toSectionArray(sections)
      const detailMapKey = adminQueryKeys.departmentDetails(scope)
      const cachedMap = queryClient.getQueryData<Record<string, DepartmentDetail>>(detailMapKey) ?? {}
      const cached = cachedMap[id]
      if (!force && cached && requestedSections.every((section) => cached.loadedSections.includes(section))) {
        return cached
      }

      setSectionLoadingById((prev) => ({
        ...prev,
        [id]: {
          ...(prev[id] ?? {}),
          ...Object.fromEntries(requestedSections.map((section) => [section, true])),
        },
      }))
      setSectionErrorById((prev) => ({
        ...prev,
        [id]: {
          ...(prev[id] ?? {}),
          ...Object.fromEntries(requestedSections.map((section) => [section, null])),
        },
      }))

      try {
        const detail = await departmentsApi.get(id, token, requestedSections)
        const merged = mergeDetail(cachedMap[id], detail)
        queryClient.setQueryData<Record<string, DepartmentDetail>>(detailMapKey, (prev = {}) => ({
          ...prev,
          [id]: mergeDetail(prev[id], detail),
        }))
        return merged
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load department detail"
        setSectionErrorById((prev) => ({
          ...prev,
          [id]: {
            ...(prev[id] ?? {}),
            ...Object.fromEntries(requestedSections.map((section) => [section, message])),
          },
        }))
        return null
      } finally {
        setSectionLoadingById((prev) => ({
          ...prev,
          [id]: {
            ...(prev[id] ?? {}),
            ...Object.fromEntries(requestedSections.map((section) => [section, false])),
          },
        }))
      }
    },
    [queryClient, scope, token],
  )

  const refreshDepartment = useCallback(
    async (departmentId: string, sections: DepartmentDetailSection | DepartmentDetailSection[]) => {
      await queryClient.invalidateQueries({ queryKey: adminQueryKeys.departments(scope) })
      await loadDetailSection(departmentId, sections, true)
    },
    [loadDetailSection, queryClient, scope],
  )

  const createDepartment = async (data: CreateDepartmentInput) => {
    if (!token) return null
    try {
      const created = await departmentsApi.create(data, token)
      toast.success("Department created")
      await queryClient.invalidateQueries({ queryKey: adminQueryKeys.departments(scope) })
      return { id: created.id }
    } catch {
      return null
    }
  }

  const updateDepartment = async (id: string, data: UpdateDepartmentInput) => {
    if (!token) return
    try {
      await departmentsApi.update(id, data, token)
      toast.success("Department updated")
      await refreshDepartment(id, "overview")
    } catch {}
  }

  const archiveDepartment = async (id: string) => {
    if (!token) return
    try {
      await departmentsApi.archive(id, token)
      toast.success("Department archived")
      await refreshDepartment(id, "overview")
    } catch {}
  }

  const createRole = async (departmentId: string, data: CreateDepartmentRoleInput) => {
    if (!token) return
    try {
      await departmentsApi.createRole(departmentId, data, token)
      toast.success("Role created")
      await refreshDepartment(departmentId, "roles")
    } catch {}
  }

  const updateRole = async (departmentId: string, roleId: string, data: UpdateDepartmentRoleInput) => {
    if (!token) return
    try {
      await departmentsApi.updateRole(departmentId, roleId, data, token)
      toast.success("Role updated")
      await refreshDepartment(departmentId, "roles")
    } catch {}
  }

  const deleteRole = async (departmentId: string, roleId: string) => {
    if (!token) return
    try {
      await departmentsApi.deleteRole(departmentId, roleId, token)
      toast.success("Role deleted")
      await refreshDepartment(departmentId, "roles")
    } catch {}
  }

  const upsertMembership = async (departmentId: string, data: UpsertDepartmentMembershipInput) => {
    if (!token) return null
    try {
      const membership = await departmentsApi.upsertMembership(departmentId, data, token)
      toast.success("Membership saved")
      await refreshDepartment(departmentId, "members")
      return membership
    } catch {
      return null
    }
  }

  const removeMembership = async (departmentId: string, userId: string) => {
    if (!token) return
    try {
      await departmentsApi.removeMembership(departmentId, userId, token)
      toast.success("Member removed")
      await refreshDepartment(departmentId, "members")
    } catch {}
  }

  const searchCandidates = async (departmentId: string, query: string) => {
    if (!token || !query.trim()) return []
    try {
      return await departmentsApi.searchCandidates(departmentId, query.trim(), token)
    } catch {
      return []
    }
  }

  const setRolePermission = async (departmentId: string, roleId: string, toolId: string, actionGroup: string, allowed: boolean) => {
    if (!token) return
    const detailMapKey = adminQueryKeys.departmentDetails(scope)
    const previousMap = queryClient.getQueryData<Record<string, DepartmentDetail>>(detailMapKey) ?? {}
    const previousDetail = previousMap[departmentId]
    if (previousDetail) {
      queryClient.setQueryData<Record<string, DepartmentDetail>>(detailMapKey, (current = {}) => ({
        ...current,
        [departmentId]: patchRolePermission(current[departmentId] ?? previousDetail, roleId, toolId, actionGroup, allowed),
      }))
    }
    try {
      await departmentsApi.setRolePermission(departmentId, roleId, toolId, actionGroup, allowed, token)
      void loadDetailSection(departmentId, "permissions", true)
    } catch {
      queryClient.setQueryData(detailMapKey, previousMap)
    }
  }

  const setUserOverride = async (departmentId: string, userId: string, toolId: string, actionGroup: string, allowed: boolean) => {
    if (!token) return
    const detailMapKey = adminQueryKeys.departmentDetails(scope)
    const previousMap = queryClient.getQueryData<Record<string, DepartmentDetail>>(detailMapKey) ?? {}
    const previousDetail = previousMap[departmentId]
    if (previousDetail) {
      queryClient.setQueryData<Record<string, DepartmentDetail>>(detailMapKey, (current = {}) => ({
        ...current,
        [departmentId]: patchUserOverride(current[departmentId] ?? previousDetail, userId, toolId, actionGroup, allowed),
      }))
    }
    try {
      await departmentsApi.setUserOverride(departmentId, userId, toolId, actionGroup, allowed, token)
      void loadDetailSection(departmentId, "permissions", true)
    } catch {
      queryClient.setQueryData(detailMapKey, previousMap)
    }
  }

  const updateConfig = async (departmentId: string, data: UpdateDepartmentConfigInput) => {
    if (!token) return
    try {
      await departmentsApi.updateConfig(departmentId, data, token)
      toast.success("Department config updated")
      await loadDetailSection(departmentId, "config", true)
    } catch {}
  }

  const toolCatalogById = useMemo(
    () => Object.fromEntries(toolCatalog.map((tool) => [tool.toolId, tool])) as Record<string, DepartmentToolCatalogEntry>,
    [toolCatalog],
  )

  const stats = useMemo(
    () => ({
      total: departments.length,
      active: departments.filter((department) => department.status === "active").length,
      archived: departments.filter((department) => department.status === "archived").length,
      members: departments.reduce((sum, department) => sum + department.memberCount, 0),
      roles: departments.reduce((sum, department) => sum + department.roleCount, 0),
    }),
    [departments],
  )

  return {
    departments,
    detailById,
    toolCatalog,
    toolCatalogById,
    loading,
    error,
    stats,
    refresh: () => Promise.all([departmentsQuery.refetch(), toolCatalogQuery.refetch()]).then(() => undefined),
    loadDetailSection,
    isSectionLoaded,
    isSectionLoading,
    getSectionError,
    createDepartment,
    updateDepartment,
    archiveDepartment,
    createRole,
    updateRole,
    deleteRole,
    upsertMembership,
    removeMembership,
    searchCandidates,
    setRolePermission,
    setUserOverride,
    updateConfig,
  }
}
