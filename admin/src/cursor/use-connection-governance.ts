import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { getAdminQueryScope } from "@/lib/query-client"

export const CONNECTION_ACTIONS = ["read", "create", "update", "delete", "send", "execute"] as const
export type ConnectionAction = typeof CONNECTION_ACTIONS[number]
export type ApprovalMode = "none" | "connection_owner" | "company_admin"

export type ActionGovernance = {
  mode: "inherit" | "enforced"
  requestsPerMinute?: number | null
  requestsPerDay?: number | null
  approval?: ApprovalMode
}

export type ConnectionGovernancePolicy = {
  version: 1
  actions: Record<ConnectionAction, ActionGovernance>
}

export type GovernedConnection = {
  id: string
  provider: string
  ownerType: "user" | "company" | string
  ownerUserId: string | null
  createdBy: string | null
  label: string
  accountEmail: string | null
  accountName: string | null
  status: string
  scopes: string[]
  connectedAt: string
  lastUsedAt: string | null
  owner: { id: string; name: string | null; email: string } | null
  grants: Array<{
    id: string
    granteeType: string
    granteeId: string
    access: string
    grantedAt: string
    grantedBy: { id: string; name: string | null; email: string } | null
  }>
  governance: {
    managerPolicy: ConnectionGovernancePolicy | null
    managerConfiguredBy: string | null
    managerConfiguredAt: string | null
    adminOverride: ConnectionGovernancePolicy
    adminOverriddenBy: string | null
    adminOverriddenAt: string | null
    source: "platform_default" | "manager_policy" | "company_admin_override"
    version: number
  }
}

export type CompanyCapabilityGovernance = {
  id: "webSearch" | "sharedSkills" | "sharedPersonaMemory"
  label: string
  description: string
  policy: {
    version: 1
    enabled: boolean
    requestsPerMinute: number | null
    requestsPerDay: number | null
    approval: "none" | "company_admin"
  }
  source: "platform_default" | "company_admin"
  configuredAt: string | null
  configuredBy: string | null
  version: number
}

const scoped = (path: string, companyId?: string) =>
  companyId ? `${path}?${new URLSearchParams({ companyId }).toString()}` : path

export function defaultConnectionGovernancePolicy(): ConnectionGovernancePolicy {
  return {
    version: 1,
    actions: Object.fromEntries(CONNECTION_ACTIONS.map((action) => [action, { mode: "inherit" }])) as ConnectionGovernancePolicy["actions"],
  }
}

export function useMemberConnection(token: string | null, userId: string | undefined, connectionId: string | undefined, companyId?: string) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: ["admin", scope, "member-connection", userId ?? "none", connectionId ?? "none", companyId ?? ""] as const,
    enabled: Boolean(token && userId && connectionId),
    queryFn: () => api.get<GovernedConnection>(scoped(`/api/admin/company/members/${userId}/connections/${connectionId}`, companyId), token!),
  })
}

export function useSaveConnectionGovernance(token: string | null, companyId?: string) {
  const queryClient = useQueryClient()
  const scope = getAdminQueryScope(token)
  return useMutation({
    mutationFn: ({ connectionId, adminOverride }: { connectionId: string; adminOverride: ConnectionGovernancePolicy }) =>
      api.put(`/api/admin/company/connections/${connectionId}/governance`, { adminOverride, ...(companyId ? { companyId } : {}) }, token!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", scope, "member-connections"] })
      await queryClient.invalidateQueries({ queryKey: ["admin", scope, "member-connection"] })
    },
  })
}
