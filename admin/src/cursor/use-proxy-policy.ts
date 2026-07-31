import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { getAdminQueryScope } from "@/lib/query-client"

/*
 * Per-member proxy guardrails — REAL data from /api/admin/proxy-policy.
 *
 * These are the block / budget / rate / allowed-model controls the backend
 * proxy enforces in gate(). `companyId` is only needed for SUPER_ADMIN callers
 * (use useCompanyScope()); company-admins resolve from their session.
 *
 * New members with no explicit policy default to Flash-only (isDefault=true) —
 * Pro must be explicitly granted here.
 */

/**
 * Which model actually answers for this member.
 *
 * The grant is a set, so something has to break the tie, and the backend breaks
 * it by preference order — the catalogue endpoint returns the models in exactly
 * that order, best first. Mirroring the rule here rather than the list keeps the
 * panel from describing a choice the backend does not make.
 */
export function activeModel<T extends { id: string }>(
  catalogue: readonly T[] | undefined,
  allowedModels: readonly string[],
): T | undefined {
  if (!catalogue || catalogue.length === 0) return undefined
  // The last entry is the least-privileged model, which is what a member with no
  // usable grant falls back to — the same rule the backend applies.
  return catalogue.find((model) => allowedModels.includes(model.id)) ?? catalogue[catalogue.length - 1]
}

export interface ProxyPolicy {
  userId: string
  blocked: boolean
  monthlyBudgetUsd: number | null
  rateLimitRpm: number | null
  allowedModels: string[]
  isDefault: boolean
}

export interface ProxyPolicyInput {
  blocked: boolean
  monthlyBudgetUsd: number | null
  rateLimitRpm: number | null
  allowedModels: string[]
}

const scoped = (path: string, companyId?: string): string =>
  companyId ? `${path}?companyId=${encodeURIComponent(companyId)}` : path

const policyKey = (scope: string, companyId?: string) =>
  ["admin", scope, "proxy-policy", companyId ?? ""] as const

/** All explicit member policies for the company (keyed by userId). */
export function useProxyPolicies(token: string | null, companyId?: string) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: policyKey(scope, companyId),
    enabled: Boolean(token),
    queryFn: () => api.get<ProxyPolicy[]>(scoped("/api/admin/proxy-policy", companyId), token!),
  })
}

/** One member's effective policy (falls back to Flash-only default). */
export function useProxyPolicy(token: string | null, userId: string | undefined, companyId?: string) {
  const scope = getAdminQueryScope(token)
  return useQuery({
    queryKey: [...policyKey(scope, companyId), userId ?? "none"] as const,
    enabled: Boolean(token && userId),
    queryFn: () => api.get<ProxyPolicy>(scoped(`/api/admin/proxy-policy/${userId}`, companyId), token!),
  })
}

/** Upsert a member's policy; invalidates both the list and single-member queries. */
export function useSaveProxyPolicy(token: string | null, companyId?: string) {
  const scope = getAdminQueryScope(token)
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: ProxyPolicyInput }) =>
      api.put<ProxyPolicy>(scoped(`/api/admin/proxy-policy/${userId}`, companyId), input, token!),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: policyKey(scope, companyId) })
    },
  })
}
