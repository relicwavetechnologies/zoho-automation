/**
 * The connection jobs that operate on company-held accounts.
 *
 * Kept apart from `use-connections`, which is the member's own provider loop:
 * these routes either require a company admin or report company-owned
 * connections with extra management state.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'

const BASE = '/api/desktop/auth'

export type ShopifyCompanyConnection = {
  connectionId: string
  label: string
  accountEmail: string | null
  accountName: string | null
  ownerType: 'user' | 'company'
  access: string
  scopes?: string[]
  connectedAt?: string
  lastUsedAt?: string | null
  reconnectRequired?: boolean
}

export type ShopifyCompanyStatus = {
  connected: boolean
  canManage: boolean
  readOnlyEnforced: boolean
  connections: ShopifyCompanyConnection[]
}

/** How much of an Airtable workspace a personal access token is allowed to do. */
export type AirtableAccessMode = 'read_only' | 'read_write'

/**
 * Connecting a provider with a key instead of a sign-in.
 *
 * Airtable and AITable both accept a token posted straight to the backend, and
 * both restrict it to company admins — the resulting connection is held by the
 * company rather than by one person, so it is not a decision a member gets to
 * make for everybody.
 *
 * The value goes to the backend and is never held here beyond the request. It
 * is not put in a query string, not logged, and not read back: neither route
 * returns the token it was given.
 */
export function useTokenConnect() {
  const { token } = useAdminAuth()
  const [saving, setSaving] = useState(false)

  const connectAirtable = useCallback(async (
    personalAccessToken: string,
    options?: { label?: string; accessMode?: AirtableAccessMode },
  ) => {
    if (!token) return
    setSaving(true)
    try {
      await api.post(`${BASE}/airtable/pat`, {
        personalAccessToken,
        ...(options?.label ? { label: options.label } : {}),
        ...(options?.accessMode ? { accessMode: options.accessMode } : {}),
      }, token, { quiet: true })
    } finally {
      setSaving(false)
    }
  }, [token])

  const connectAitable = useCallback(async (apiKey: string, options?: { label?: string }) => {
    if (!token) return
    setSaving(true)
    try {
      await api.post(`${BASE}/aitable/connect`, {
        apiKey,
        ...(options?.label ? { label: options.label } : {}),
      }, token, { quiet: true })
    } finally {
      setSaving(false)
    }
  }, [token])

  return { saving, connectAirtable, connectAitable }
}

export function useShopifyConnect() {
  const { token } = useAdminAuth()
  const [saving, setSaving] = useState(false)

  const connect = useCallback(async (input: {
    shopDomain: string
    clientId: string
    clientSecret: string
    label?: string
  }) => {
    if (!token) throw new Error('Sign in again before saving Shopify.')
    setSaving(true)
    try {
      const data = await api.post<{ status: 'connected'; shopName: string; shopDomain: string }>(
        `${BASE}/shopify/client-credentials`,
        input,
        token,
        { quiet: true },
      )
      return data
    } finally {
      setSaving(false)
    }
  }, [token])

  return { saving, connect }
}

export function useShopifyCompanyStatus() {
  const { token } = useAdminAuth()
  const [status, setStatus] = useState<ShopifyCompanyStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    if (!token) { setLoading(false); return }
    setLoading(true)
    try {
      const data = await api.get<ShopifyCompanyStatus>(`${BASE}/shopify/status`, token, { quiet: true })
      setStatus(data)
      setFailed(false)
    } catch {
      setStatus(null)
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { void load() }, [load])

  return { status, loading, failed, refresh: load }
}
