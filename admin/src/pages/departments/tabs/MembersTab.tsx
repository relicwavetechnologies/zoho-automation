import { useEffect, useMemo, useState } from "react"
import { Search, UserPlus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { DepartmentCandidate, DepartmentMembership, DepartmentRole } from "@/lib/api"

type Props = {
  departmentId: string
  memberships: DepartmentMembership[]
  roles: DepartmentRole[]
  onSearchCandidates: (departmentId: string, query: string) => Promise<DepartmentCandidate[]>
  onAddMember: (departmentId: string, data: { userId?: string; channelIdentityId?: string; roleId?: string }) => Promise<DepartmentMembership | null>
  onRemoveMember: (departmentId: string, userId: string) => Promise<void>
}

export function MembersTab({ departmentId, memberships, roles, onSearchCandidates, onAddMember, onRemoveMember }: Props) {
  const [roleDrafts, setRoleDrafts] = useState<Record<string, string>>({})
  const [candidateQuery, setCandidateQuery] = useState("")
  const [candidateRoleId, setCandidateRoleId] = useState("")
  const [candidates, setCandidates] = useState<DepartmentCandidate[]>([])
  const [searching, setSearching] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const defaultRoleId = useMemo(
    () => roles.find((role) => role.isDefault)?.id ?? roles[0]?.id ?? "",
    [roles],
  )

  useEffect(() => {
    setRoleDrafts(Object.fromEntries(memberships.map((membership) => [membership.userId, membership.roleId])))
  }, [memberships])

  useEffect(() => {
    setCandidateRoleId((current) => current || defaultRoleId)
  }, [defaultRoleId])

  useEffect(() => {
    const query = candidateQuery.trim()
    if (query.length < 2) {
      setCandidates([])
      setSearching(false)
      return
    }

    let active = true
    setSearching(true)
    const timer = window.setTimeout(async () => {
      const result = await onSearchCandidates(departmentId, query)
      if (active) {
        setCandidates(result)
        setSearching(false)
      }
    }, 250)

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [candidateQuery, departmentId, onSearchCandidates])

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-card p-3 shadow-soft">
        <div className="grid gap-3 md:grid-cols-[1.4fr_220px]">
          <div className="space-y-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Search members</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={candidateQuery}
                onChange={(event) => setCandidateQuery(event.target.value)}
                className="h-9 bg-card pl-8 text-[13px]"
                placeholder="Search synced Lark users by name or email"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Assign role</Label>
            <Select value={candidateRoleId} onValueChange={setCandidateRoleId}>
              <SelectTrigger className="h-9 bg-card text-[13px]">
                <SelectValue placeholder="Default role" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          {searching ? <p className="text-[11px] text-muted-foreground">Searching candidates…</p> : null}
          {!searching && candidateQuery.trim().length >= 2 && candidates.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No synced users matched this query.</p>
          ) : null}
          {candidates.map((candidate) => {
            const alreadyAssigned = candidate.isAlreadyAssigned
            const busy = busyKey === candidate.channelIdentityId
            return (
              <div key={candidate.channelIdentityId} className="flex flex-col gap-2 rounded-md border border-border/50 p-3 md:flex-row md:items-center">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold">
                    {candidate.name || candidate.larkDisplayName || candidate.email || "Unnamed contact"}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {candidate.email || candidate.larkUserId || candidate.larkOpenId || "No email on synced identity"}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {candidate.isWorkspaceMember ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                        Workspace member
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                        Not in workspace
                      </span>
                    )}
                    {alreadyAssigned ? (
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                        Already assigned
                      </span>
                    ) : null}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="h-8 rounded-md bg-emphasis px-3 text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90"
                  disabled={busy || alreadyAssigned || !candidateRoleId || !candidate.isWorkspaceMember}
                  onClick={async () => {
                    setBusyKey(candidate.channelIdentityId)
                    try {
                      const added = await onAddMember(departmentId, {
                        ...(candidate.userId ? { userId: candidate.userId } : { channelIdentityId: candidate.channelIdentityId }),
                        roleId: candidateRoleId,
                      })
                      if (added) {
                        setCandidateQuery("")
                        setCandidates([])
                      }
                    } finally {
                      setBusyKey(null)
                    }
                  }}
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Add
                </Button>
              </div>
            )
          })}
        </div>
      </div>

      <div className="space-y-2">
        {memberships.length === 0 ? (
          <div className="rounded-lg bg-card p-4 text-[12px] text-muted-foreground shadow-soft">
            No department members yet.
          </div>
        ) : null}

        {memberships.map((membership) => {
          const roleId = roleDrafts[membership.userId] ?? membership.roleId
          const dirty = roleId !== membership.roleId
          const busy = busyKey === membership.userId

          return (
            <div key={membership.id} className="flex flex-col gap-3 rounded-lg bg-card p-3 shadow-soft md:flex-row md:items-center">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold">{membership.name || membership.email}</p>
                <p className="truncate text-[11px] text-muted-foreground">{membership.email}</p>
              </div>

              <Select
                value={roleId}
                onValueChange={(value) => setRoleDrafts((prev) => ({ ...prev, [membership.userId]: value }))}
              >
                <SelectTrigger className="h-9 w-full bg-card text-[13px] md:w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="h-8 rounded-md bg-emphasis px-3 text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90"
                  disabled={busy || !dirty}
                  onClick={async () => {
                    setBusyKey(membership.userId)
                    try {
                      await onAddMember(departmentId, { userId: membership.userId, roleId })
                    } finally {
                      setBusyKey(null)
                    }
                  }}
                >
                  Save
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 px-2 text-[12px]"
                  disabled={busy}
                  onClick={async () => {
                    setBusyKey(membership.userId)
                    try {
                      await onRemoveMember(departmentId, membership.userId)
                    } finally {
                      setBusyKey(null)
                    }
                  }}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
