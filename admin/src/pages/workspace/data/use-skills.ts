import { useCallback, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { useCompanyScope } from "@/cursor/use-spend"
import {
  agentsApi,
  skillRegistryApi,
  type SkillAccess,
  type SkillAuditEntry,
  type SkillDetail,
  type SkillGranteeType,
  type SkillRegistryTree,
} from "@/lib/api"
import { adminQueryKeys, getAdminQueryScope } from "@/lib/query-client"

type ToolRegistryEntry = { toolId: string; name: string }

/** Tool id → display label, sourced from the live registry (falls back to id). */
export function useToolLabels(): (id: string) => string {
  const { token } = useAdminAuth()
  const scope = getAdminQueryScope(token)
  const query = useQuery({
    queryKey: adminQueryKeys.toolRegistry(scope),
    enabled: Boolean(token),
    queryFn: async () => {
      const rows = await agentsApi.toolRegistry<ToolRegistryEntry>(token ?? undefined)
      return Array.isArray(rows) ? rows : []
    },
  })
  const map = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of query.data ?? []) m.set(t.toolId, t.name)
    return m
  }, [query.data])
  return useCallback((id: string) => map.get(id) ?? id, [map])
}

export function useSkillRegistry() {
  const { token, session } = useAdminAuth()
  const scope = getAdminQueryScope(token)
  const companyId = useCompanyScope() // super-admin: selected company; company-admin: undefined
  const isSuperAdmin = session?.role === "SUPER_ADMIN"
  const needsCompany = isSuperAdmin && !companyId
  const queryClient = useQueryClient()

  const [includeArchived, setIncludeArchived] = useState(false)

  const treeQuery = useQuery({
    queryKey: adminQueryKeys.skillRegistryTree(scope, companyId ?? "self", includeArchived),
    enabled: Boolean(token) && !needsCompany,
    queryFn: () => skillRegistryApi.tree({ includeArchived, companyId }, token ?? undefined),
  })

  const tree: SkillRegistryTree | undefined = treeQuery.data
  const error = treeQuery.error instanceof Error ? treeQuery.error.message : null

  const invalidateTree = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["admin", scope, "skill-registry-tree"] }),
    [queryClient, scope],
  )

  const createFolder = useCallback(
    async (input: { name: string; parentId?: string | null; departmentId?: string | null }) => {
      try {
        await skillRegistryApi.createFolder(input, companyId, token ?? undefined)
        toast.success("Folder created")
        await invalidateTree()
      } catch { /* toast handled in api layer */ }
    },
    [companyId, token, invalidateTree],
  )

  const renameFolder = useCallback(
    async (folderId: string, name: string) => {
      try {
        await skillRegistryApi.renameFolder(folderId, name, companyId, token ?? undefined)
        toast.success("Folder renamed")
        await invalidateTree()
      } catch {}
    },
    [companyId, token, invalidateTree],
  )

  const moveFolder = useCallback(
    async (folderId: string, parentId: string | null) => {
      try {
        await skillRegistryApi.moveFolder(folderId, parentId, companyId, token ?? undefined)
        toast.success("Folder moved")
        await invalidateTree()
      } catch {}
    },
    [companyId, token, invalidateTree],
  )

  const archiveFolder = useCallback(
    async (folderId: string) => {
      try {
        const res = await skillRegistryApi.archiveFolder(folderId, companyId, token ?? undefined)
        toast.success(`Folder archived · ${res.detachedSkills} skill(s) detached to root`)
        await invalidateTree()
      } catch {}
    },
    [companyId, token, invalidateTree],
  )

  const moveSkill = useCallback(
    async (skillId: string, folderId: string | null) => {
      try {
        await skillRegistryApi.moveSkill(skillId, folderId, companyId, token ?? undefined)
        toast.success(folderId ? "Skill moved" : "Skill moved to root")
        await invalidateTree()
        await queryClient.invalidateQueries({ queryKey: adminQueryKeys.skillDetail(scope, skillId) })
      } catch {}
    },
    [companyId, token, invalidateTree, queryClient, scope],
  )

  const backfill = useCallback(async () => {
    try {
      const res = await skillRegistryApi.backfill(companyId, token ?? undefined)
      toast.success(`Backfill complete · ${res.foldersCreated} folder(s), ${res.skillsPlaced} skill(s) placed`)
      await invalidateTree()
    } catch {}
  }, [companyId, token, invalidateTree])

  return {
    tree,
    registryRevision: tree?.registryRevision ?? null,
    loading: treeQuery.isPending && !needsCompany,
    error,
    /**
     * The raw failure, not just its message.
     *
     * A 403 here is an answer — "you may not read this company's registry" —
     * and telling it apart from a genuine outage needs the status code, which
     * `error` above has already thrown away.
     */
    errorCause: treeQuery.error as unknown,
    needsCompany,
    includeArchived,
    setIncludeArchived,
    createFolder,
    renameFolder,
    moveFolder,
    archiveFolder,
    moveSkill,
    backfill,
  }
}

// ── Per-skill detail panels ────────────────────────────────────────────────────
export function useSkillDetail(skillId: string | null) {
  const { token } = useAdminAuth()
  const scope = getAdminQueryScope(token)
  const companyId = useCompanyScope()
  return useQuery<SkillDetail>({
    queryKey: adminQueryKeys.skillDetail(scope, skillId ?? "none"),
    enabled: Boolean(token && skillId),
    queryFn: () => skillRegistryApi.skill(skillId as string, companyId, token ?? undefined),
  })
}

export function useSkillAccess(skillId: string | null) {
  const { token } = useAdminAuth()
  const scope = getAdminQueryScope(token)
  const companyId = useCompanyScope()
  const queryClient = useQueryClient()
  const key = adminQueryKeys.skillAccess(scope, skillId ?? "none")

  const query = useQuery<SkillAccess>({
    queryKey: key,
    enabled: Boolean(token && skillId),
    queryFn: () => skillRegistryApi.access(skillId as string, companyId, token ?? undefined),
  })

  const grant = useCallback(
    async (granteeType: SkillGranteeType, granteeId: string) => {
      if (!skillId) return
      try {
        await skillRegistryApi.grantAccess(skillId, granteeType, granteeId, companyId, token ?? undefined)
        toast.success("Access granted")
        await queryClient.invalidateQueries({ queryKey: key })
      } catch {}
    },
    [skillId, companyId, token, queryClient, key],
  )

  const revoke = useCallback(
    async (granteeType: SkillGranteeType, granteeId: string) => {
      if (!skillId) return
      try {
        await skillRegistryApi.revokeAccess(skillId, granteeType, granteeId, companyId, token ?? undefined)
        toast.success("Access revoked")
        await queryClient.invalidateQueries({ queryKey: key })
      } catch {}
    },
    [skillId, companyId, token, queryClient, key],
  )

  return { ...query, grant, revoke }
}

export function useSkillAudit(skillId: string | null) {
  const { token } = useAdminAuth()
  const scope = getAdminQueryScope(token)
  const companyId = useCompanyScope()
  return useQuery<SkillAuditEntry[]>({
    queryKey: adminQueryKeys.skillAudit(scope, skillId ?? "none"),
    enabled: Boolean(token && skillId),
    queryFn: () => skillRegistryApi.audit(skillId as string, companyId, token ?? undefined),
  })
}
