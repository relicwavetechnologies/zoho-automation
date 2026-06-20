import type * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { GoogleWorkspaceLogo } from '@/components/integration-plugins/GoogleWorkspaceLogo'
import { PageLoader } from '@/components/page-loader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TextTab } from '@/components/ui/text-tab'
import { getIntegrationPlugins, startIntegrationPluginOAuth } from '@/hermes'
import { Globe, Sparkles } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import type {
  IntegrationPluginCapabilityStatus,
  IntegrationPluginConnectionStatus,
  IntegrationPluginRow,
  IntegrationPluginsResponse
} from '@/types/integration-plugins'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { PAGE_INSET_X } from '../layout-constants'
import { PageSearchShell } from '../page-search-shell'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

interface IntegrationsViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

const STATUS_LABELS: Record<IntegrationPluginConnectionStatus, string> = {
  connected: 'Connected',
  not_connected: 'Not connected',
  needs_reconnect: 'Needs reconnect',
  revoked: 'Revoked'
}

const CAPABILITY_STATUS_LABELS: Record<IntegrationPluginCapabilityStatus, string> = {
  available: 'Available',
  needs_connection: 'Connect first',
  needs_scope: 'Needs scope',
  unavailable: 'Unavailable'
}

type StatusFilter = 'all' | IntegrationPluginConnectionStatus

const OAUTH_POLL_MS = 2_000
const OAUTH_POLL_TIMEOUT_MS = 120_000

function connectionStatusLabel(
  plugin: IntegrationPluginRow,
  awaitingOAuthPluginId: string | null
): string {
  if (awaitingOAuthPluginId === plugin.id && plugin.connection.status !== 'connected') {
    return 'Connecting…'
  }
  return STATUS_LABELS[plugin.connection.status]
}

function isPluginBusy(pluginId: string, connectBusy: string | null, awaitingOAuthPluginId: string | null): boolean {
  return connectBusy === pluginId || awaitingOAuthPluginId === pluginId
}

function parseApiError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Request failed'
  try {
    const match = message.match(/^\d+:\s*(.+)$/s)
    const bodyText = match?.[1]?.trim() ?? message
    const parsed = JSON.parse(bodyText) as { detail?: unknown; error?: string }
    const detail = parsed.detail
    if (typeof detail === 'string') return detail
    if (detail && typeof detail === 'object') {
      const record = detail as Record<string, unknown>
      const code = String(record.error ?? record.message ?? '')
      const hint = String(record.hint ?? '')
      if (code && hint) return `${code}: ${hint}`
      if (code) return code
    }
    if (parsed.error) return parsed.error
  } catch {
    /* fall through */
  }
  return message
}

function PluginLogo({ logoKey, className }: { logoKey: string; className?: string }) {
  if (logoKey === 'google-workspace') {
    return <GoogleWorkspaceLogo className={className} />
  }
  return <Globe className={className} />
}

function connectLabel(plugin: IntegrationPluginRow): string {
  if (plugin.connection.status === 'connected') {
    return 'Reconnect your account'
  }
  if (plugin.id === 'google-workspace') {
    return 'Connect your Google account'
  }
  return 'Connect'
}

function PluginDetailPanel({
  plugin,
  busy,
  awaitingOAuth,
  onClose,
  onConnect
}: {
  plugin: IntegrationPluginRow
  busy: boolean
  awaitingOAuth: boolean
  onClose: () => void
  onConnect: (pluginId: string) => void
}) {
  const { manifest, connection, capabilities, actions } = plugin

  return (
    <div className="rounded-xl border border-(--ui-border-subtle) bg-(--ui-bg-secondary) p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-(--ui-border-subtle) bg-(--ui-bg-tertiary) p-2.5">
            <PluginLogo logoKey={manifest.logo_key} className="h-8 w-8" />
          </div>
          <div className="min-w-0">
            <div className="text-base font-medium">{manifest.name}</div>
            <p className="mt-1 text-xs text-muted-foreground">{manifest.description}</p>
          </div>
        </div>
        <Button aria-label="Close details" onClick={onClose} size="sm" variant="ghost">
          Close
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge variant={connection.status === 'connected' ? 'default' : 'muted'}>
          {awaitingOAuth && connection.status !== 'connected' ? 'Connecting…' : STATUS_LABELS[connection.status]}
        </Badge>
        <Badge variant="muted">{manifest.category}</Badge>
        {connection.account_email ? (
          <Badge className="font-mono text-[10px]" variant="muted">
            {connection.account_email}
          </Badge>
        ) : null}
      </div>

      {connection.granted_scopes.length > 0 ? (
        <div className="mt-4 rounded-lg border border-(--ui-border-subtle) bg-(--ui-bg-tertiary) p-3">
          <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Your granted scopes
          </div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {connection.granted_scopes.map(scope => (
              <li className="break-all font-mono" key={scope}>
                {scope}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4">
        <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Requested permissions
        </div>
        <ul className="space-y-2">
          {manifest.oauth_scopes.map(scope => (
            <li className="rounded-lg border border-(--ui-border-subtle) px-3 py-2" key={scope.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{scope.label}</span>
                <Badge variant={scope.required ? 'default' : 'muted'}>
                  {scope.required ? 'Required' : 'Phase 3'}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{scope.description}</p>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4">
        <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Capabilities
        </div>
        <ul className="space-y-2">
          {capabilities.map(capability => (
            <li
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-(--ui-border-subtle) px-3 py-2"
              key={capability.id}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium">{capability.label}</div>
                <p className="text-xs text-muted-foreground">{capability.description}</p>
              </div>
              <Badge variant={capability.status === 'available' ? 'default' : 'muted'}>
                {CAPABILITY_STATUS_LABELS[capability.status]}
              </Badge>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4">
        <Button disabled={!actions.can_connect || busy} onClick={() => onConnect(plugin.id)} size="sm">
          {busy ? (awaitingOAuth ? 'Finishing connection…' : 'Connecting…') : connectLabel(plugin)}
        </Button>
      </div>
    </div>
  )
}

function PluginCard({
  plugin,
  selected,
  busy,
  awaitingOAuth,
  onSelect,
  onConnect
}: {
  plugin: IntegrationPluginRow
  selected: boolean
  busy: boolean
  awaitingOAuth: boolean
  onSelect: (pluginId: string) => void
  onConnect: (pluginId: string) => void
}) {
  const { manifest, connection, actions } = plugin

  return (
    <div
      className={cn(
        'rounded-xl border p-4 transition-colors',
        selected
          ? 'border-(--ui-accent-primary)/40 ring-1 ring-(--ui-accent-primary)/20'
          : 'border-(--ui-border-subtle) bg-(--ui-bg-secondary)'
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-(--ui-border-subtle) bg-(--ui-bg-tertiary) p-2.5">
            <PluginLogo logoKey={manifest.logo_key} className="h-7 w-7" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-medium">{manifest.name}</div>
              {manifest.featured ? (
                <Badge className="gap-1 text-[10px]" variant="muted">
                  <Sparkles className="h-3 w-3" />
                  Featured
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{manifest.description}</p>
          </div>
        </div>
        <Badge variant={connection.status === 'connected' ? 'default' : 'muted'}>
          {connectionStatusLabel(plugin, awaitingOAuth ? plugin.id : null)}
        </Badge>
      </div>

      <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
        {manifest.examples.slice(0, 3).map(example => (
          <li className="flex items-start gap-2" key={example}>
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-(--ui-accent-primary)/70" />
            <span>{example}</span>
          </li>
        ))}
      </ul>

      {connection.account_email ? (
        <div className="mt-3 text-xs text-muted-foreground">
          Connected as <span className="font-mono">{connection.account_email}</span>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button disabled={!actions.can_connect || busy} onClick={() => onConnect(plugin.id)} size="sm">
          {busy
            ? awaitingOAuth
              ? 'Finishing connection…'
              : 'Connecting…'
            : connectLabel(plugin)}
        </Button>
        <Button onClick={() => onSelect(plugin.id)} size="sm" variant="ghost">
          Details
        </Button>
      </div>
    </div>
  )
}

export function IntegrationsView({ setStatusbarItemGroup: _setStatusbarItemGroup, ...props }: IntegrationsViewProps) {
  const [data, setData] = useState<IntegrationPluginsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [connectBusy, setConnectBusy] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [awaitingOAuthPluginId, setAwaitingOAuthPluginId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const load = useCallback(async () => {
    const response = await getIntegrationPlugins()
    setData(response)
    return response
  }, [])

  const pollOAuthCompletion = useCallback(async () => {
    if (!awaitingOAuthPluginId) {
      return
    }
    const response = await load()
    const plugin = response.plugins.find(item => item.id === awaitingOAuthPluginId)
    if (plugin?.connection.status === 'connected') {
      setAwaitingOAuthPluginId(null)
      const email = plugin.connection.account_email
      notify({
        kind: 'success',
        message: email ? `Google connected as ${email}` : 'Google connected'
      })
    }
  }, [awaitingOAuthPluginId, load])

  useEffect(() => {
    setLoading(true)
    void load()
      .catch((error: unknown) => notifyError(parseApiError(error), 'Could not load integrations'))
      .finally(() => setLoading(false))
  }, [load])

  useEffect(() => {
    if (!awaitingOAuthPluginId) {
      return
    }

    let cancelled = false
    let attempts = 0
    const maxAttempts = Math.ceil(OAUTH_POLL_TIMEOUT_MS / OAUTH_POLL_MS)

    const tick = () => {
      if (cancelled) {
        return
      }
      attempts += 1
      void pollOAuthCompletion().catch((error: unknown) =>
        notifyError(parseApiError(error), 'Could not refresh connection status')
      )
      if (attempts >= maxAttempts) {
        setAwaitingOAuthPluginId(null)
      }
    }

    void pollOAuthCompletion().catch((error: unknown) =>
      notifyError(parseApiError(error), 'Could not refresh connection status')
    )
    const timer = window.setInterval(tick, OAUTH_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [awaitingOAuthPluginId, pollOAuthCompletion])

  useEffect(() => {
    if (!awaitingOAuthPluginId) {
      return
    }

    const refreshOnReturn = () => {
      if (document.visibilityState === 'visible') {
        void pollOAuthCompletion().catch((error: unknown) =>
          notifyError(parseApiError(error), 'Could not refresh connection status')
        )
      }
    }

    window.addEventListener('focus', refreshOnReturn)
    document.addEventListener('visibilitychange', refreshOnReturn)
    return () => {
      window.removeEventListener('focus', refreshOnReturn)
      document.removeEventListener('visibilitychange', refreshOnReturn)
    }
  }, [awaitingOAuthPluginId, pollOAuthCompletion])

  useRefreshHotkey(() => {
    void load().catch((error: unknown) => notifyError(parseApiError(error), 'Could not refresh integrations'))
  })

  const onConnect = useCallback(async (pluginId: string) => {
    setConnectBusy(pluginId)
    try {
      const response = await startIntegrationPluginOAuth(pluginId)
      if (response.authorize_url) {
        setAwaitingOAuthPluginId(pluginId)
        await window.hermesDesktop.openExternal(response.authorize_url)
        notify({
          kind: 'info',
          message: 'Complete Google sign-in in your browser, then return here.'
        })
        return
      }
      notify({
        kind: 'info',
        message: 'Redirecting to Google...'
      })
    } catch (error: unknown) {
      notifyError(parseApiError(error), 'Could not connect integration')
    } finally {
      setConnectBusy(null)
    }
  }, [])

  const filteredPlugins = useMemo(() => {
    const plugins = data?.plugins ?? []
    const needle = query.trim().toLowerCase()
    return plugins.filter(plugin => {
      if (statusFilter !== 'all' && plugin.connection.status !== statusFilter) {
        return false
      }
      if (!needle) return true
      const haystack = [plugin.manifest.name, plugin.manifest.description, plugin.manifest.category, ...plugin.manifest.examples]
        .join(' ')
        .toLowerCase()
      return haystack.includes(needle)
    })
  }, [data?.plugins, query, statusFilter])

  const selectedPlugin =
    filteredPlugins.find(plugin => plugin.id === selectedId) ??
    data?.plugins.find(plugin => plugin.id === selectedId) ??
    null

  const statusFilters: StatusFilter[] = ['all', 'connected', 'not_connected', 'needs_reconnect']

  return (
    <PageSearchShell
      {...props}
      filters={
        <>
          {statusFilters.map(value => (
            <TextTab active={statusFilter === value} key={value} onClick={() => setStatusFilter(value)}>
              {value === 'all' ? 'All' : STATUS_LABELS[value]}
            </TextTab>
          ))}
        </>
      }
      onSearchChange={setQuery}
      searchHidden={(data?.plugins.length ?? 0) === 0}
      searchPlaceholder="Search your plugins..."
      searchValue={query}
    >
      <div className={cn('h-full overflow-y-auto py-3', PAGE_INSET_X)}>
        <div className="mb-4 max-w-3xl">
          <h1 className="text-lg font-semibold tracking-tight">Your plugins</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Connect your apps so Divo can work with your Gmail, Calendar, and Drive. Connections are personal to
            your account.
          </p>
          {data?.actor.company_user_id ? (
            <p className="mt-2 text-[0.68rem] text-muted-foreground">
              Signed in as employee <span className="font-mono">{data.actor.company_user_id}</span>
            </p>
          ) : null}
        </div>

        {loading ? (
          <PageLoader label="Loading your plugins..." />
        ) : (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
            <div className="grid gap-4 md:grid-cols-2">
              {filteredPlugins.length === 0 ? (
                <p className="text-sm text-muted-foreground">No plugins match your filters.</p>
              ) : (
                filteredPlugins.map(plugin => (
                  <PluginCard
                    awaitingOAuth={awaitingOAuthPluginId === plugin.id}
                    busy={isPluginBusy(plugin.id, connectBusy, awaitingOAuthPluginId)}
                    key={plugin.id}
                    onConnect={id => void onConnect(id)}
                    onSelect={setSelectedId}
                    plugin={plugin}
                    selected={selectedId === plugin.id}
                  />
                ))
              )}
            </div>

            <div className="xl:sticky xl:top-4 xl:self-start">
              {selectedPlugin ? (
                <PluginDetailPanel
                  awaitingOAuth={awaitingOAuthPluginId === selectedPlugin.id}
                  busy={isPluginBusy(selectedPlugin.id, connectBusy, awaitingOAuthPluginId)}
                  onClose={() => setSelectedId(null)}
                  onConnect={id => void onConnect(id)}
                  plugin={selectedPlugin}
                />
              ) : (
                <div className="rounded-xl border border-dashed border-(--ui-border-subtle) p-6 text-sm text-muted-foreground">
                  <Sparkles className="mb-2 h-4 w-4 text-(--ui-accent-primary)/80" />
                  Select a plugin to review scopes, capabilities, and your connection details.
                </div>
              )}
            </div>
          </div>
        )}

        {data?.oauth && !data.oauth.google_configured ? (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs text-muted-foreground">
            Google OAuth is not configured on the server yet. An admin must set GOOGLE_OAUTH_CLIENT_ID and
            GOOGLE_OAUTH_CLIENT_SECRET before you can connect Google Workspace.
          </div>
        ) : null}
      </div>
    </PageSearchShell>
  )
}
