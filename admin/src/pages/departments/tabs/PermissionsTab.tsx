import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { departmentsApi, type BooksModulePermission } from "@/lib/api"
import { adminQueryKeys, getAdminQueryScope } from "@/lib/query-client"
import type { DepartmentAvailableTool, DepartmentMembership, DepartmentRole, DepartmentToolPermission, DepartmentUserOverride } from "@/lib/api"
import type { DepartmentToolCatalogEntry } from "../use-department-data"

type Props = {
  departmentId: string
  roles: DepartmentRole[]
  memberships: DepartmentMembership[]
  availableTools: DepartmentAvailableTool[]
  toolPermissions: DepartmentToolPermission[]
  userOverrides: DepartmentUserOverride[]
  toolCatalogById: Record<string, DepartmentToolCatalogEntry>
  onSetRolePermission: (departmentId: string, roleId: string, toolId: string, actionGroup: string, allowed: boolean) => Promise<void>
  onSetUserOverride: (departmentId: string, userId: string, toolId: string, actionGroup: string, allowed: boolean) => Promise<void>
}

const familyClass: Record<DepartmentToolCatalogEntry["family"], string> = {
  zoho: "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
  lark: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  google: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  context: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  execution: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  internal: "bg-secondary text-muted-foreground",
}

export function PermissionsTab({
  departmentId,
  roles,
  memberships,
  availableTools,
  toolPermissions,
  userOverrides,
  toolCatalogById,
  onSetRolePermission,
  onSetUserOverride,
}: Props) {
  const { token } = useAdminAuth()
  const scope = getAdminQueryScope(token)
  const queryClient = useQueryClient()
  const [selectedUserId, setSelectedUserId] = useState("")
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const booksModulesKey = adminQueryKeys.apiList(scope, `/api/admin/departments/${departmentId}/books-modules`, "books")
  const booksModulesQuery = useQuery({
    queryKey: booksModulesKey,
    enabled: Boolean(token && departmentId),
    queryFn: () => departmentsApi.getBookModulePermissions(departmentId, token!),
  })
  const booksModuleMap = useMemo(() => {
    const m = new Map<string, boolean>()
    for (const p of booksModulesQuery.data ?? []) m.set(`${p.roleId}:${p.module}`, p.enabled)
    return m
  }, [booksModulesQuery.data])

  useEffect(() => {
    if (!memberships.find((membership) => membership.userId === selectedUserId)) {
      setSelectedUserId(memberships[0]?.userId ?? "")
    }
  }, [memberships, selectedUserId])

  const permissionMap = useMemo(
    () =>
      new Map(
        toolPermissions.map((permission) => [
          `${permission.roleId}:${permission.toolId}:${permission.actionGroup}`,
          permission.allowed,
        ]),
      ),
    [toolPermissions],
  )

  const overrideMap = useMemo(
    () =>
      new Map(
        userOverrides.map((override) => [
          `${override.userId}:${override.toolId}:${override.actionGroup}`,
          override.allowed,
        ]),
      ),
    [userOverrides],
  )

  // Local, always-on capabilities (e.g. Terminal) — gated per-action on the
  // user's own machine, so they are exempt from RBAC and shown read-only.
  const alwaysOnTools = useMemo(
    () => Object.values(toolCatalogById).filter((t) => t.family === "execution" && !t.deprecated),
    [toolCatalogById],
  )

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div>
          <p className="text-[13px] font-semibold">Role permissions</p>
          <p className="text-[11px] text-muted-foreground">
            Only checked action groups are allowed for this department role. Unchecked means not allowed.
          </p>
        </div>

        {availableTools.length === 0 ? (
          <div className="rounded-lg bg-card p-4 text-[12px] text-muted-foreground shadow-soft">
            No tool catalog is available for this department.
          </div>
        ) : null}

        <div className="space-y-3">
          {availableTools.map((tool) => {
            const meta = toolCatalogById[tool.toolId]
            return (
              <div key={tool.toolId} className="rounded-lg bg-card p-3 shadow-soft">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <p className="text-[13px] font-semibold">{meta?.name ?? tool.toolId}</p>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${familyClass[meta?.family ?? "internal"]}`}>
                    {meta?.family ?? "internal"}
                  </span>
                  <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {tool.toolId}
                  </span>
                </div>
                {meta?.description ? <p className="mb-3 text-[11px] text-muted-foreground">{meta.description}</p> : null}

                <div className="overflow-x-auto">
                  <div
                    className="grid min-w-[520px] gap-2"
                    style={{ gridTemplateColumns: `minmax(140px, 1.2fr) repeat(${tool.supportedActionGroups.length}, minmax(88px, 1fr))` }}
                  >
                    <div className="px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Role</div>
                    {tool.supportedActionGroups.map((actionGroup) => (
                      <div key={actionGroup} className="px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {actionGroup}
                      </div>
                    ))}

                    {roles.map((role) => (
                      <div key={role.id} className="contents">
                        <div className="rounded-md bg-secondary/50 px-2 py-2 text-[12px] font-medium text-foreground/85">
                          {role.name}
                        </div>
                        {tool.supportedActionGroups.map((actionGroup) => {
                          const key = `${role.id}:${tool.toolId}:${actionGroup}`
                          const checked = permissionMap.get(key) === true
                          return (
                            <label key={key} className="flex items-center justify-center rounded-md border border-border/40 bg-card px-2 py-2">
                              <Checkbox
                                checked={checked}
                                disabled={busyKey === key}
                                onCheckedChange={async (value) => {
                                  setBusyKey(key)
                                  try {
                                    await onSetRolePermission(departmentId, role.id, tool.toolId, actionGroup, value === true)
                                  } finally {
                                    setBusyKey(null)
                                  }
                                }}
                              />
                            </label>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {alwaysOnTools.length > 0 ? (
        <div className="space-y-3">
          <div>
            <p className="text-[13px] font-semibold">Always-on local tools</p>
            <p className="text-[11px] text-muted-foreground">
              These run on the member&apos;s own machine via the desktop app and are gated per-command by
              the user (Run / Decline). They are not governed by RBAC — always available, not toggleable.
            </p>
          </div>
          {alwaysOnTools.map((tool) => (
            <div key={tool.toolId} className="rounded-lg bg-card p-3 shadow-soft">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <p className="text-[13px] font-semibold">{tool.name}</p>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${familyClass.execution}`}>
                  {tool.family}
                </span>
                <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {tool.toolId}
                </span>
                <span className="ml-auto rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                  Always on · local · user-approved
                </span>
              </div>
              {tool.description ? (
                <p className="text-[11px] text-muted-foreground">{tool.description}</p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="space-y-3">
        <div>
          <p className="text-[13px] font-semibold">User overrides</p>
          <p className="text-[11px] text-muted-foreground">
            Apply per-member exceptions on top of the role matrix when someone needs broader or narrower access.
          </p>
        </div>

        {memberships.length > 0 ? (
          <div className="space-y-3">
            <div className="max-w-sm space-y-1.5">
              <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Member</Label>
              <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                <SelectTrigger className="h-9 bg-card text-[13px]">
                  <SelectValue placeholder="Select a member" />
                </SelectTrigger>
                <SelectContent>
                  {memberships.map((membership) => (
                    <SelectItem key={membership.userId} value={membership.userId}>
                      {membership.name || membership.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedUserId ? (
              <div className="space-y-3">
                {availableTools.map((tool) => {
                  const meta = toolCatalogById[tool.toolId]
                  return (
                    <div key={`${selectedUserId}:${tool.toolId}`} className="rounded-lg bg-card p-3 shadow-soft">
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <p className="text-[12px] font-semibold">{meta?.name ?? tool.toolId}</p>
                        <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {tool.toolId}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {tool.supportedActionGroups.map((actionGroup) => {
                          const key = `${selectedUserId}:${tool.toolId}:${actionGroup}`
                          const checked = overrideMap.get(key) === true
                          return (
                            <label key={key} className="flex items-center gap-2 rounded-md border border-border/40 bg-card px-3 py-2 text-[12px]">
                              <Checkbox
                                checked={checked}
                                disabled={busyKey === key}
                                onCheckedChange={async (value) => {
                                  setBusyKey(key)
                                  try {
                                    await onSetUserOverride(departmentId, selectedUserId, tool.toolId, actionGroup, value === true)
                                  } finally {
                                    setBusyKey(null)
                                  }
                                }}
                              />
                              {actionGroup}
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg bg-card p-4 text-[12px] text-muted-foreground shadow-soft">
            Add a department member before configuring user-specific overrides.
          </div>
        )}
      </div>

      {/* ── Books module access ──────────────────────────────────────────── */}
      <div className="space-y-2">
        <div>
          <p className="text-[13px] font-semibold">Zoho Books module access</p>
          <p className="text-[11px] text-muted-foreground">
            Control which Books modules each role can query. Disabled modules return access denied even if the tool is allowed above.
          </p>
        </div>

        <div className="rounded-lg bg-card p-3 shadow-soft">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-semibold">Books Modules</p>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${familyClass.zoho}`}>zoho</span>
          </div>

          {(() => {
            const modules = ["invoices", "contacts", "bills", "payments", "estimates", "expenses", "purchase_orders", "credit_notes"]
            return (
              <div className="overflow-x-auto">
                <div
                  className="grid min-w-[520px] gap-2"
                  style={{ gridTemplateColumns: `minmax(140px, 1.2fr) repeat(${modules.length}, minmax(68px, 1fr))` }}
                >
                  <div className="px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Role</div>
                  {modules.map((mod) => (
                    <div key={mod} className="px-2 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {mod.replace("_", " ")}
                    </div>
                  ))}

                  {roles.map((role) => (
                    <div key={role.id} className="contents">
                      <div className="rounded-md bg-secondary/50 px-2 py-2 text-[12px] font-medium text-foreground/85">
                        {role.name}
                      </div>
                      {modules.map((mod) => {
                        const key = `bm:${role.id}:${mod}`
                        const checked = booksModuleMap.get(`${role.id}:${mod}`) ?? true
                        return (
                          <label key={key} className="flex items-center justify-center rounded-md border border-border/40 bg-card px-2 py-2">
                            <Checkbox
                              checked={checked}
                              disabled={busyKey === key}
                              onCheckedChange={async (value) => {
                                setBusyKey(key)
                                try {
                                  await departmentsApi.setBookModulePermission(departmentId, role.id, mod, value === true, token!)
                                  void queryClient.invalidateQueries({ queryKey: booksModulesKey })
                                } finally {
                                  setBusyKey(null)
                                }
                              }}
                            />
                          </label>
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}
        </div>
      </div>
    </div>
  )
}
