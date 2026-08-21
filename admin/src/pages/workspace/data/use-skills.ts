import { useCallback, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { notify } from "@/lib/notify"
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
import { humanizeId } from "./trace-step"

/** "1 skill" / "3 skills" — so a count never reads as `1 skill(s)`. */
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

type ToolRegistryEntry = { toolId: string; name: string }

/**
 * Tool id → display label, sourced from the live registry.
 *
 * The fallback humanises rather than returning the id, because the registry is
 * a network read: it is empty on first paint and stays empty if the request
 * fails or the company's registry omits a tool a skill still names. Returning
 * the id meant those cases rendered `larkBase` and `zohoCrm` at a person — an
 * identifier leaking through a label. `humanizeId` is the same helper the chat
 * trace already degrades through, so the two surfaces agree on the wording.
 */
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
  return useCallback((id: string) => map.get(id) ?? humanizeId(id), [map])
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
        // Named, because the tree can be long enough that a new folder lands
        // below the fold and "Folder created" is then a claim you cannot check.
        notify.done('Folder created', input.name)
        await invalidateTree()
      } catch { /* the api layer already said why */ }
    },
    [companyId, token, invalidateTree],
  )

  const renameFolder = useCallback(
    async (folderId: string, name: string) => {
      try {
        await skillRegistryApi.renameFolder(folderId, name, companyId, token ?? undefined)
        notify.done('Folder renamed', `It is called ${name} now.`)
        await invalidateTree()
      } catch { /* the api layer already said why */ }
    },
    [companyId, token, invalidateTree],
  )

  const moveFolder = useCallback(
    async (folderId: string, parentId: string | null) => {
      try {
        await skillRegistryApi.moveFolder(folderId, parentId, companyId, token ?? undefined)
        notify.done('Folder moved', parentId ? null : 'It sits at the top level now.')
        await invalidateTree()
      } catch { /* the api layer already said why */ }
    },
    [companyId, token, invalidateTree],
  )

  const archiveFolder = useCallback(
    async (folderId: string) => {
      try {
        const res = await skillRegistryApi.archiveFolder(folderId, companyId, token ?? undefined)
        /*
         * What happened to the skills inside is the part worth saying. They are
         * not archived with the folder — they are moved to the top level, and
         * somebody who reads only "Folder archived" will go looking for them
         * where they used to be. Said in words rather than as
         * "3 skill(s) detached to root", which is the database's account of it.
         */
        notify.done(
          'Folder archived',
          res.detachedSkills > 0
            ? `${plural(res.detachedSkills, 'skill')} moved to the top level. Nothing was deleted.`
            : 'It was empty, so nothing moved.',
        )
        await invalidateTree()
      } catch { /* the api layer already said why */ }
    },
    [companyId, token, invalidateTree],
  )

  const moveSkill = useCallback(
    async (skillId: string, folderId: string | null) => {
      try {
        await skillRegistryApi.moveSkill(skillId, folderId, companyId, token ?? undefined)
        // Worth a toast either way: the skill leaves the folder you were
        // looking at, so the screen you are on stops showing the thing you
        // just acted on.
        notify.done('Skill moved', folderId ? null : 'It sits at the top level now.')
        await invalidateTree()
        await queryClient.invalidateQueries({ queryKey: adminQueryKeys.skillDetail(scope, skillId) })
      } catch { /* the api layer already said why */ }
    },
    [companyId, token, invalidateTree, queryClient, scope],
  )

  const backfill = useCallback(async () => {
    try {
      const res = await skillRegistryApi.backfill(companyId, token ?? undefined)
      /*
       * A bulk change across the whole library, and almost none of it is on
       * screen — so this is the one toast on this page that is carrying the
       * entire result. It also has a real "nothing happened" case, which the
       * old wording reported as "0 folder(s), 0 skill(s) placed" and left
       * looking like a failure.
       */
      const madeNothing = res.foldersCreated === 0 && res.skillsPlaced === 0
      notify.done(
        madeNothing ? 'Everything was already tidy' : 'Tidied the library',
        madeNothing
          ? 'No loose skills and no missing folders — nothing needed moving.'
          : `Made ${plural(res.foldersCreated, 'folder')} and filed ${plural(res.skillsPlaced, 'skill')} into them.`,
      )
      await invalidateTree()
    } catch { /* the api layer already said why */ }
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
        // Sharing is an authority change, so it says what it did rather than
        // reporting that a write succeeded.
        notify.done('Shared', 'They can run this skill now.')
        await queryClient.invalidateQueries({ queryKey: key })
      } catch { /* the api layer already said why */ }
    },
    [skillId, companyId, token, queryClient, key],
  )

  const revoke = useCallback(
    async (granteeType: SkillGranteeType, granteeId: string) => {
      if (!skillId) return
      try {
        await skillRegistryApi.revokeAccess(skillId, granteeType, granteeId, companyId, token ?? undefined)
        notify.done('Stopped sharing', 'They can no longer run this skill.')
        await queryClient.invalidateQueries({ queryKey: key })
      } catch { /* the api layer already said why */ }
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
