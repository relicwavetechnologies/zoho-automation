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
import type { ConnectionGovernance, ConnectionGovernancePolicy } from './connection-policy'

// Re-exported so a screen reaches for one module rather than two to render a
// connection. The policy logic lives apart because it is pure and tested.
export {
  CONNECTION_ACTIONS, defaultGovernancePolicy, samePolicy, scopeLabel, setActionPolicy,
} from './connection-policy'
export type {
  ConnectionAction, ConnectionActionPolicy, ConnectionApprovalMode,
  ConnectionGovernance, ConnectionGovernancePolicy,
} from './connection-policy'

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
 * Providers whose authorize-url accepts a `label`.
 *
 * These hold several connections per company, so the person naming one is
 * distinguishing it from the others. Google keys its connections by Google
 * account and shows the address, and Lark holds one — neither has anything to
 * disambiguate, and the backend ignores the parameter for both.
 */
export const LABELLED: Provider[] = ['canva', 'airtable']

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
   * The popup says when it is done, rather than this guessing.
   *
   * Polling `popup.closed` was the only signal, and it only ever worked for
   * the providers whose callback closed itself — Canva and Airtable answered
   * with bare text and no `window.close()`, so their popup sat open, the poll
   * never resolved and the list never refreshed. The callback now posts back
   * to this origin the moment the connection is written.
   *
   * The message is a nudge, not data: it carries only which provider finished,
   * and the refetch re-reads `/status` from the backend. Anything arriving
   * from another origin is ignored outright.
   */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const data = event.data as { source?: string; ok?: boolean } | null
      if (data?.source !== 'divo-connection' || !data.ok) return
      void load()
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [load])

  /**
   * Coming back to the tab is also a reason to re-read.
   *
   * Covers the cases the message cannot: a popup blocked into a full tab, a
   * consent finished in a different window, or a browser that tore the opener
   * link down. Cheap — six small reads, only when the tab regains focus.
   */
  useEffect(() => {
    const onFocus = () => { void load() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [load])

  /**
   * Runs the provider's OAuth hop in a popup and refetches when it closes.
   *
   * Watching for the close rather than polling a nonce: the connect routes park
   * nothing to poll for — the callback writes the connection straight to the
   * database — so the honest signal that something may have changed is the
   * window going away.
   */
  const connect = useCallback(async (provider: Provider, options?: { label?: string }) => {
    if (!token) return
    const authorizePath = AUTHORIZE_PATH[provider]
    if (!authorizePath) {
      throw new Error('This app is connected with an API key rather than a sign-in, so there is nothing to authorize here.')
    }
    setConnecting(provider)
    try {
      // Only where the backend accepts it. Sending `label` to a provider that
      // holds one account per company would be a name nothing ever reads.
      const named = options?.label && LABELLED.includes(provider)
        ? `${authorizePath}?label=${encodeURIComponent(options.label)}`
        : authorizePath
      const { authorizeUrl } = await api.get<{ authorizeUrl: string }>(
        named,
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
  grantedBy: { id: string; email: string; name: string | null } | null
}

export type GranteeType = ConnectionGrant['granteeType']

export type ManageCandidates = {
  users: { id: string; name: string | null; email: string; role: string }[]
  departments: { id: string; name: string; slug: string }[]
  roles: { id: string; name: string; kind: string; department?: string }[]
  company: { id: string; name: string } | null
}

export type AccessLevel = { value: string; label: string; description: string }

export type ConnectionManage = {
  connection: {
    connectionId: string
    label: string
    accountEmail: string | null
    accountName: string | null
    ownerType: string
    /** Null for a company-owned connection nobody personally holds. */
    ownerUser: { id: string; email: string; name: string | null } | null
    access: string
    scopes: string[]
    readOnlyEnforced?: boolean
    connectedAt: string
  }
  grants: ConnectionGrant[]
  candidates: ManageCandidates
  accessLevels: AccessLevel[]
  governance: ConnectionGovernance
}

/**
 * Everything needed to decide who else may act through one connection.
 *
 * One call rather than several: the route returns the grants, the people,
 * departments and roles they could be given to, and the access levels this
 * provider actually supports — Zoho collapses to read-only when its scopes say
 * so, and inventing that list on the client would offer a level the backend
 * then refuses.
 *
 * A 403 is a normal answer, not a failure: the route admits only the owner, an
 * admin grantee, or a company admin. It resolves to `refused` so the drawer can
 * say who may do this instead of rendering an empty sharing panel that looks
 * like nobody has access.
 */
export function useConnectionManage(provider: Provider, connectionId?: string) {
  const { token } = useAdminAuth()
  const [data, setData] = useState<ConnectionManage | null>(null)
  const [loading, setLoading] = useState(true)
  const [refused, setRefused] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const base = `/api/desktop/auth/${SEGMENT[provider]}/connections/${connectionId ?? ''}`

  const load = useCallback(async () => {
    if (!token || !connectionId) { setLoading(false); return }
    setLoading(true)
    try {
      const payload = await api.get<ConnectionManage>(`${base}/manage`, token, { quiet: true })
      setData(payload)
      setRefused(false)
      setError(null)
    } catch (e) {
      setData(null)
      setRefused(e instanceof ApiError && (e.status === 403 || e.status === 401))
      setError(e instanceof ApiError && e.status === 403 ? null : 'Could not read who can use this connection.')
    } finally {
      setLoading(false)
    }
  }, [token, base, connectionId])

  useEffect(() => { void load() }, [load])

  const grant = useCallback(async (granteeType: GranteeType, granteeId: string, access: string) => {
    if (!token || !connectionId) return
    setSaving(true)
    try {
      await api.post(`${base}/grants`, { granteeType, granteeId, access }, token)
      await load()
    } finally {
      setSaving(false)
    }
  }, [token, base, connectionId, load])

  const revoke = useCallback(async (grantId: string) => {
    if (!token || !connectionId) return
    setSaving(true)
    try {
      await api.delete(`${base}/grants/${grantId}`, {}, token)
      await load()
    } finally {
      setSaving(false)
    }
  }, [token, base, connectionId, load])

  /**
   * Saves the connection's own operating rules.
   *
   * Not under the provider segment — governance is one route for every
   * provider, because the policy is about the connection rather than about
   * what it connects to. The response carries the stored governance back, so
   * the whole payload is re-read rather than patched locally: the backend
   * normalises the policy and increments a version, and adopting our own copy
   * would leave the screen a version behind its own save.
   */
  const saveGovernance = useCallback(async (managerPolicy: ConnectionGovernancePolicy) => {
    if (!token || !connectionId) return
    setSaving(true)
    try {
      await api.put(
        `/api/desktop/auth/connections/${connectionId}/governance`,
        { managerPolicy },
        token,
      )
      await load()
    } finally {
      setSaving(false)
    }
  }, [token, connectionId, load])

  return { data, loading, refused, error, saving, grant, revoke, saveGovernance, refresh: load }
}
