/**
 * Real connection state for the You scope.
 *
 * Every provider exposes the same three routes under /api/desktop/auth —
 * `{provider}/status`, `{provider}/authorize-url` and a disconnect — so this is
 * one shape fetched six times rather than six bespoke integrations.
 *
 * What the backend does NOT tell us is whether a token has gone stale. Expiry
 * is stored and never evaluated, so there is no `needs_reauth` to read; the UI
 * says so rather than implying a healthy connection it cannot vouch for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import type { Provider } from '../fixtures'

/** Providers that answer the shared status/authorize surface. */
export const CONNECTABLE: Provider[] = [
  'google_workspace', 'lark', 'canva', 'airtable', 'aitable', 'zoho',
]

/**
 * Route segment per provider. Google's connection routes live under `google`
 * while its `Provider` id is `google_workspace`, which is the one place the two
 * vocabularies disagree.
 */
const SEGMENT: Record<Provider, string> = {
  google_workspace: 'google',
  lark: 'lark',
  canva: 'canva',
  airtable: 'airtable',
  aitable: 'aitable',
  zoho: 'zoho',
}

/**
 * Where each provider's *connect* flow starts — and why this cannot be derived.
 *
 * Lark owns two authorize routes that differ by one path segment and by
 * everything else. `/lark/authorize-url` is the unauthenticated desktop
 * sign-in hop: it signs `kind: 'desktop_lark_login'` and its callback parks the
 * code for `/lark/poll`, writing no connection at all. The connect flow is
 * `/lark/connections/authorize-url`, behind memberAuth, whose callback is the
 * one that actually stores an `IntegrationConnection`.
 *
 * Deriving the path from the segment picked the first one, so Connect ran a
 * whole consent screen, closed the popup, refetched status, found nothing, and
 * put the button back to "Connect" — no error anywhere. A wrong route that
 * resolves to a real route is worse than a 404, so the mapping is written out
 * rather than computed.
 *
 * `null` means the provider has no OAuth to start. AITable is key-based: its
 * connection is created by posting a key, not by a redirect.
 */
const AUTHORIZE_PATH: Record<Provider, string | null> = {
  google_workspace: '/api/desktop/auth/google/authorize-url',
  lark: '/api/desktop/auth/lark/connections/authorize-url',
  canva: '/api/desktop/auth/canva/authorize-url',
  airtable: '/api/desktop/auth/airtable/authorize-url',
  aitable: null,
  zoho: '/api/desktop/auth/zoho/authorize-url',
}

/**
 * How each provider's connection is taken away.
 *
 * Five providers answer `DELETE {provider}/connections/:id`. AITable does not
 * have that route at all — it revokes through `POST .../revoke` — so the shared
 * shape 404'd and toasted a bare `Error 404` while the connection stayed live.
 */
const disconnectRequest = (provider: Provider, connectionId: string): { method: 'delete' | 'post'; path: string } =>
  provider === 'aitable'
    ? { method: 'post', path: `/api/desktop/auth/aitable/connections/${connectionId}/revoke` }
    : { method: 'delete', path: `/api/desktop/auth/${SEGMENT[provider]}/connections/${connectionId}` }

export type LiveConnection = {
  connectionId: string
  label: string
  accountEmail: string | null
  accountName: string | null
  ownerType: 'user' | 'company'
  access: string
  scopes?: string[]
  connectedAt?: string
  lastUsedAt?: string | null
}

export type ProviderStatus = {
  provider: Provider
  connected: boolean
  connections: LiveConnection[]
  /**
   * Set when this provider's status could not be read. Kept per provider so one
   * misconfigured integration does not blank the whole page — the others are
   * still true, and this one says what happened.
   */
  error?: string
}

type StatusResponse = { connected: boolean; connections: LiveConnection[] }

export function useConnections() {
  const { token } = useAdminAuth()
  const [statuses, setStatuses] = useState<ProviderStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState<Provider | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    // Set on every mount, not just declared once at the top.
    //
    // React's development double-mount runs a component's effects, tears them
    // down, and runs them again. A flag that is only ever set to `false` by the
    // teardown is still `false` for the second mount, so that mount's fetch
    // resolves into a guard that discards it — and `loading` never turns off.
    // The page holds its skeletons forever, in dev only, which is exactly where
    // it gets looked at.
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async () => {
    if (!token) return
    // `all` is safe here only because the mapper below never rejects: each
    // provider catches its own failure and returns a row saying so. A provider
    // that is not configured on this deployment answers 503, and that must not
    // take the other five down with it.
    const results = await Promise.all(
      CONNECTABLE.map(async (provider): Promise<ProviderStatus> => {
        try {
          const data = await api.get<StatusResponse>(
            `/api/desktop/auth/${SEGMENT[provider]}/status`,
            token,
            { quiet: true },
          )
          return { provider, connected: data.connected, connections: data.connections ?? [] }
        } catch (e) {
          return {
            provider,
            connected: false,
            connections: [],
            error: e instanceof ApiError && e.status === 503
              ? 'Not configured on this deployment'
              : 'Could not read this connection',
          }
        }
      }),
    )
    if (alive.current) {
      setStatuses(results)
      setLoading(false)
    }
  }, [token])

  useEffect(() => { void load() }, [load])

  /**
   * Runs the provider's OAuth hop in a popup and refetches when it closes.
   *
   * Watching for the close rather than polling a nonce: the connect routes park
   * nothing to poll for — the callback writes the connection straight to the
   * database — so the honest signal that something may have changed is the
   * window going away.
   */
  const connect = useCallback(async (provider: Provider) => {
    if (!token) return
    const authorizePath = AUTHORIZE_PATH[provider]
    if (!authorizePath) {
      throw new Error('This app is connected with an API key rather than a sign-in, so there is nothing to authorize here.')
    }
    setConnecting(provider)
    try {
      const { authorizeUrl } = await api.get<{ authorizeUrl: string }>(
        authorizePath,
        token,
        { quiet: true },
      )
      const popup = window.open(authorizeUrl, `divo-connect-${provider}`, 'width=520,height=720')
      if (!popup) throw new Error('Your browser blocked the connect window. Allow pop-ups and try again.')

      await new Promise<void>((resolve) => {
        const timer = window.setInterval(() => {
          if (popup.closed) { window.clearInterval(timer); resolve() }
        }, 500)
      })
      await load()
    } finally {
      if (alive.current) setConnecting(null)
    }
  }, [token, load])

  const disconnect = useCallback(async (provider: Provider, connectionId: string) => {
    if (!token) return
    const { method, path } = disconnectRequest(provider, connectionId)
    if (method === 'post') await api.post(path, {}, token)
    else await api.delete(path, {}, token)
    await load()
  }, [token, load])

  const byProvider = useMemo(
    () => new Map(statuses.map((status) => [status.provider, status])),
    [statuses],
  )

  return { statuses, byProvider, loading, connecting, connect, disconnect, refresh: load }
}

export type ConnectionGrant = {
  id: string
  granteeType: 'user' | 'department' | 'role' | 'company'
  granteeId: string
  granteeLabel: string
  granteeDetail: string | null
  access: string
  grantedAt: string
}

/**
 * Who else can act through one connection.
 *
 * A separate call from the status list because it is a separate authority: the
 * manage route refuses anyone who does not own or administer the connection, so
 * a 403 here is a normal answer and resolves to "no shares you can see" rather
 * than an error. Merging it into the list would make every page load ask six
 * questions it usually does not need answered.
 */
export function useConnectionGrants(provider: Provider, connectionId?: string): ConnectionGrant[] {
  const { token } = useAdminAuth()
  const [grants, setGrants] = useState<ConnectionGrant[]>([])

  useEffect(() => {
    if (!token || !connectionId) { setGrants([]); return }
    let live = true
    void (async () => {
      try {
        const data = await api.get<{ grants: ConnectionGrant[] }>(
          `/api/desktop/auth/${SEGMENT[provider]}/connections/${connectionId}/manage`,
          token,
          { quiet: true },
        )
        if (live) setGrants(data.grants ?? [])
      } catch {
        if (live) setGrants([])
      }
    })()
    return () => { live = false }
  }, [token, provider, connectionId])

  return grants
}
