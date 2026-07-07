import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronRight,
  ExternalLink,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  User,
  Users,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { route } from '@/constants/routes'
import {
  getPlugin,
  googleWorkspaceServices,
  type DivoConnection,
  type DivoConnectionAccess,
} from '@/lib/plugins'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/plugins/$pluginId' as any)({
  component: PluginDetailRoute,
})

async function openExternalUrl(url: string): Promise<void> {
  if (IS_TAURI) {
    await openUrl(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

type GoogleStatusConnection = {
  connectionId: string
  label: string
  accountEmail: string | null
  accountName: string | null
  ownerType: 'user' | 'company'
  access: DivoConnectionAccess
  scopes: string[]
  connectedAt: string
  lastUsedAt: string | null
}

type GoogleStatusResponse = {
  success: boolean
  data?: {
    connected: boolean
    connections: GoogleStatusConnection[]
  }
  message?: string
}

type LocalLarkStatus = {
  installed: boolean
  configured: boolean
  connected: boolean
  accountLabel?: string
  statusText?: string
  cliPath?: string
  homePath: string
  usesConfiguredApp: boolean
  version?: string
  error?: string
}

type LocalLarkSetupStart = {
  started: boolean
  completed: boolean
  authorizeUrl?: string
}

type LocalLarkSetupStatus = {
  running: boolean
  completed: boolean
  success: boolean
  output: string
}

type LocalLarkAuthStart = {
  authorizeUrl: string
  deviceCode?: string
  raw: unknown
}

type ConnectionState =
  | { status: 'loading'; connections: DivoConnection[]; error?: never }
  | { status: 'ready'; connections: DivoConnection[]; error?: never }
  | { status: 'error'; connections: DivoConnection[]; error: string }

function toConnectionModel(connection: GoogleStatusConnection): DivoConnection {
  const account = connection.accountEmail ?? connection.accountName ?? 'Google account'
  const isShared = connection.ownerType === 'company'
  const scopeLabels = formatGoogleScopes(connection.scopes)

  return {
    id: connection.connectionId,
    pluginId: 'google-workspace',
    label: connection.label || account,
    accountEmail: account,
    kind: isShared ? 'company_shared' : 'personal',
    status: 'connected',
    access: connection.access,
    owner: connection.accountName ?? account,
    scopes: scopeLabels.length ? scopeLabels : ['Google Workspace'],
    piAlias: connection.label || account,
    recommendedFor: buildConnectionRecommendation(connection.access, scopeLabels),
    lastUsedAt: formatRelativeDate(connection.lastUsedAt),
  }
}

function buildConnectionRecommendation(access: DivoConnectionAccess, scopes: string[]): string {
  const services = scopes.length ? scopes.join(', ') : 'Google Workspace'
  if (access === 'read_only') return `Read-only access for ${services}.`
  if (access === 'admin') return `Admin access for ${services}.`
  return `Read/write access for ${services}.`
}

function formatGoogleScopes(scopes: string[]): string[] {
  const raw = new Set(scopes)
  const labels: string[] = []
  const add = (label: string) => {
    if (!labels.includes(label)) labels.push(label)
  }

  if (raw.has('https://www.googleapis.com/auth/gmail.modify')) add('Gmail read/write')
  else if (
    raw.has('https://www.googleapis.com/auth/gmail.send') ||
    raw.has('https://www.googleapis.com/auth/gmail.compose')
  ) add('Gmail send')
  else if (raw.has('https://www.googleapis.com/auth/gmail.readonly')) add('Gmail read')

  if (raw.has('https://www.googleapis.com/auth/drive.file')) add('Drive app files')
  else if (raw.has('https://www.googleapis.com/auth/drive.readonly')) add('Drive read')

  if (raw.has('https://www.googleapis.com/auth/calendar.events')) add('Calendar read/write')
  else if (raw.has('https://www.googleapis.com/auth/calendar.readonly')) add('Calendar read')

  if (
    raw.has('https://www.googleapis.com/auth/userinfo.email') ||
    raw.has('https://www.googleapis.com/auth/userinfo.profile') ||
    raw.has('openid')
  ) add('Profile')

  return labels.length ? labels : scopes
}

function formatRelativeDate(value: string | null): string {
  if (!value) return 'Never'
  const timestamp = new Date(value).getTime()
  if (Number.isNaN(timestamp)) return value

  const diffMs = Date.now() - timestamp
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60_000))
  if (diffMinutes < 1) return 'Just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp)
}

function PluginDetailRoute() {
  const navigate = useNavigate()
  const { pluginId } = Route.useParams()
  const [addOpen, setAddOpen] = useState(false)
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    status: 'loading',
    connections: [],
  })
  const plugin = getPlugin(pluginId)

  const loadConnections = useCallback(async () => {
    if (pluginId !== 'google-workspace') {
      setConnectionState({ status: 'ready', connections: [] })
      return
    }

    setConnectionState((current) => ({ status: 'loading', connections: current.connections }))
    console.debug('[DivoPlugins] google_status.start')
    try {
      const response = await invoke<GoogleStatusResponse>('divo_google_status')
      if (!response.success) {
        throw new Error(response.message ?? 'Google status request failed')
      }

      const connections = (response.data?.connections ?? []).map(toConnectionModel)
      console.debug('[DivoPlugins] google_status.ok', {
        connectionCount: connections.length,
      })
      setConnectionState({ status: 'ready', connections })
    } catch (error) {
      console.error('[DivoPlugins] google_status.failed', error)
      setConnectionState((current) => ({
        status: 'error',
        connections: current.connections,
        error: String(error),
      }))
    }
  }, [pluginId])

  useEffect(() => {
    void loadConnections()
  }, [loadConnections])

  const connections = connectionState.connections

  if (!plugin) {
    return (
      <div className="flex h-full items-center justify-center bg-background px-6">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-medium">Plugin not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This plugin is not available in the desktop catalog yet.
          </p>
          <Button className="mt-4" asChild>
            <Link to={route.plugins.index}>Back to Plugins</Link>
          </Button>
        </div>
      </div>
    )
  }

  const Icon = plugin.icon
  if (pluginId === 'lark-personal') {
    return (
      <LocalLarkPluginDetail
        plugin={plugin}
        onBack={() => navigate({ to: route.plugins.index } as any)}
      />
    )
  }

  const personalCount = connections.filter((connection) => connection.kind === 'personal').length
  const sharedCount = connections.filter((connection) => connection.kind === 'company_shared').length
  const activeCount = connections.filter((connection) => connection.status === 'connected').length

  return (
    <div className="h-svh min-h-0 overflow-y-auto overscroll-contain bg-background">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6 lg:px-8">
        <header className="flex flex-col gap-5 rounded-lg border border-border/70 bg-card/30 p-5">
          <div className="flex items-center justify-between gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate({ to: route.plugins.index } as any)}
            >
              <ArrowLeft className="size-4" />
              Plugins
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm">
                Manage access
                <ChevronRight className="size-4" />
              </Button>
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="size-4" />
                Add connection
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div className="flex gap-4">
              <div
                className={cn(
                  'flex size-14 items-center justify-center rounded-lg border',
                  plugin.accentClassName
                )}
              >
                <Icon className="size-7" />
              </div>
              <div>
                <h1 className="text-2xl font-medium tracking-normal">
                  {plugin.name}
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Connect multiple Google accounts, expose the right account to Pi,
                  and keep shared company access controlled by backend grants.
                </p>
              </div>
            </div>

            <div className="grid min-w-72 grid-cols-3 gap-2">
              <Metric value={String(activeCount)} label="Active" />
              <Metric value={String(personalCount)} label="Personal" />
              <Metric value={String(sharedCount)} label="Shared" />
            </div>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-medium">Connections</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Pi sees these accounts as separate choices with account, purpose,
                  and access level.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void loadConnections()}>
                  <RotateCw className="size-4" />
                  Refresh
                </Button>
                <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                  <Plus className="size-4" />
                  Add
                </Button>
              </div>
            </div>

            <div className="grid gap-3">
              {connectionState.status === 'loading' && connections.length === 0 ? (
                <ConnectionListState
                  title="Loading Google connections"
                  description="Checking the Divo backend for accounts available to this desktop session."
                />
              ) : null}
              {connectionState.status === 'error' ? (
                <ConnectionListState
                  title="Could not load Google connections"
                  description={connectionState.error}
                  action={<Button size="sm" onClick={() => void loadConnections()}>Retry</Button>}
                />
              ) : null}
              {connectionState.status === 'ready' && connections.length === 0 ? (
                <ConnectionListState
                  title="No Google connections yet"
                  description="Connect a Google account to make it available to Pi through the Divo backend."
                  action={<Button size="sm" onClick={() => setAddOpen(true)}>Add connection</Button>}
                />
              ) : null}
              {connections.map((connection) => (
                <ConnectionCard key={connection.id} connection={connection} />
              ))}
            </div>
          </div>

          <aside className="space-y-4">
            <div className="rounded-lg border border-border/70 bg-card/30 p-4">
              <h2 className="text-sm font-medium">Available services</h2>
              <div className="mt-3 space-y-3">
                {googleWorkspaceServices.map((service) => {
                  const ServiceIcon = service.icon
                  return (
                    <div key={service.name} className="flex gap-3">
                      <span className="flex size-9 items-center justify-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground">
                        <ServiceIcon className="size-4" />
                      </span>
                      <div>
                        <p className="text-sm font-medium">{service.name}</p>
                        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                          {service.description}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <PiContextCard connections={connections} />
          </aside>
        </section>
      </main>

      <AddConnectionDialog
        open={addOpen}
        onConnected={() => void loadConnections()}
        onOpenChange={setAddOpen}
      />
    </div>
  )
}

function LocalLarkPluginDetail({
  plugin,
  onBack,
}: {
  plugin: NonNullable<ReturnType<typeof getPlugin>>
  onBack: () => void
}) {
  const Icon = plugin.icon
  const [status, setStatus] = useState<LocalLarkStatus | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [setupOutput, setSetupOutput] = useState('')
  const [deviceCode, setDeviceCode] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    setIsLoading(true)
    try {
      const next = await invoke<LocalLarkStatus>('divo_lark_local_status')
      setStatus(next)
    } catch (error) {
      toast.error('Could not read Lark status', { description: String(error) })
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const startSetup = async () => {
    setIsBusy(true)
    try {
      const result = await invoke<LocalLarkSetupStart>('divo_lark_local_setup_start')
      if (result.authorizeUrl) {
        await openExternalUrl(result.authorizeUrl)
        toast.success('Lark setup opened')
        return
      }
      if (result.completed) {
        toast.success('Lark app configured')
        await loadStatus()
        await startAuth()
        return
      }
      toast.message('Lark setup started')
    } catch (error) {
      toast.error('Lark setup failed', { description: String(error) })
    } finally {
      setIsBusy(false)
    }
  }

  const checkSetup = async () => {
    setIsBusy(true)
    try {
      const result = await invoke<LocalLarkSetupStatus>('divo_lark_local_setup_status')
      setSetupOutput(result.output)
      if (result.running) {
        toast.message('Lark setup is still waiting in the browser')
        return
      }
      if (result.completed && result.success) {
        toast.success('Lark CLI setup completed')
        await loadStatus()
        return
      }
      toast.error('Lark setup has not completed yet')
    } catch (error) {
      toast.error('Could not check Lark setup', { description: String(error) })
    } finally {
      setIsBusy(false)
    }
  }

  const startAuth = async () => {
    setIsBusy(true)
    try {
      const result = await invoke<LocalLarkAuthStart>('divo_lark_local_auth_start')
      setDeviceCode(result.deviceCode ?? null)
      await openExternalUrl(result.authorizeUrl)
      toast.success('Lark authorization opened')
    } catch (error) {
      toast.error('Lark authorization failed', { description: String(error) })
    } finally {
      setIsBusy(false)
    }
  }

  const completeAuth = async () => {
    if (!deviceCode) {
      toast.error('Start Lark authorization first')
      return
    }
    setIsBusy(true)
    try {
      await invoke('divo_lark_local_auth_complete', {
        deviceCode,
        device_code: deviceCode,
      })
      setDeviceCode(null)
      toast.success('Lark connected')
      await loadStatus()
    } catch (error) {
      toast.error('Could not complete Lark authorization', { description: String(error) })
    } finally {
      setIsBusy(false)
    }
  }

  const disconnect = async () => {
    setIsBusy(true)
    try {
      await invoke('divo_lark_local_disconnect')
      setDeviceCode(null)
      toast.success('Lark disconnected')
      await loadStatus()
    } catch (error) {
      toast.error('Could not disconnect Lark', { description: String(error) })
    } finally {
      setIsBusy(false)
    }
  }

  const connected = Boolean(status?.connected)
  const configured = Boolean(status?.configured)
  const installed = Boolean(status?.installed)

  return (
    <div className="h-svh min-h-0 overflow-y-auto overscroll-contain bg-background">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6 lg:px-8">
        <header className="flex flex-col gap-5 rounded-lg border border-border/70 bg-card/30 p-5">
          <div className="flex items-center justify-between gap-4">
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeft className="size-4" />
              Plugins
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void loadStatus()}>
                <RotateCw className="size-4" />
                Refresh
              </Button>
              {connected ? (
                <Button variant="outline" size="sm" onClick={() => void disconnect()} disabled={isBusy}>
                  Disconnect
                </Button>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div className="flex gap-4">
              <div
                className={cn(
                  'flex size-14 items-center justify-center rounded-lg border',
                  plugin.accentClassName
                )}
              >
                <Icon className="size-7" />
              </div>
              <div>
                <h1 className="text-2xl font-medium tracking-normal">
                  {plugin.name}
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Connect a personal Lark account to the bundled desktop CLI. This stays local to
                  this device and is exposed to Pi as an isolated `lark-cli` command.
                </p>
              </div>
            </div>

            <div className="grid min-w-72 grid-cols-3 gap-2">
              <Metric value={installed ? 'Yes' : 'No'} label="Bundled" />
              <Metric value={status?.usesConfiguredApp ? 'Org app' : configured ? 'Ready' : 'Setup'} label="CLI app" />
              <Metric value={connected ? 'On' : 'Off'} label="Account" />
            </div>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-medium">Local connection</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The Desktop app uses its bundled Lark CLI and an isolated local home, never your
                global Mac `lark-cli` install.
              </p>
            </div>

            {isLoading ? (
              <ConnectionListState
                title="Checking local Lark"
                description="Reading bundled CLI state from the Divo local tool home."
              />
            ) : null}

            {!isLoading && !installed ? (
              <ConnectionListState
                title="Lark CLI is not bundled yet"
                description="Run the Jan vendoring step so the desktop app can package @larksuite/cli."
              />
            ) : null}

            {!isLoading && installed ? (
              <article className="rounded-lg border border-border/70 bg-card/30 p-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusDot status={connected ? 'connected' : 'disconnected'} />
                      <h3 className="text-sm font-medium">
                        {status?.accountLabel ?? 'Lark local account'}
                      </h3>
                      <Badge tone="neutral">Personal</Badge>
                      <Badge tone={connected ? 'green' : configured ? 'amber' : 'neutral'}>
                        {connected ? 'Connected' : configured ? 'Needs auth' : 'Needs setup'}
                      </Badge>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      {status?.statusText ??
                        'Available to Pi through the desktop-local lark-cli wrapper.'}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!configured ? (
                      <>
                        <Button size="sm" onClick={() => void startSetup()} disabled={isBusy}>
                          <KeyRound className="size-4" />
                          {status?.usesConfiguredApp ? 'Connect Lark' : 'Set up Lark'}
                          {status?.usesConfiguredApp ? null : <ExternalLink className="size-4" />}
                        </Button>
                        {status?.usesConfiguredApp ? null : (
                          <Button variant="outline" size="sm" onClick={() => void checkSetup()} disabled={isBusy}>
                            Check setup
                          </Button>
                        )}
                      </>
                    ) : !connected ? (
                      <>
                        <Button size="sm" onClick={() => void startAuth()} disabled={isBusy}>
                          <KeyRound className="size-4" />
                          Authorize Lark
                          <ExternalLink className="size-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void completeAuth()}
                          disabled={isBusy || !deviceCode}
                        >
                          I approved
                        </Button>
                      </>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => void disconnect()} disabled={isBusy}>
                        Disconnect
                      </Button>
                    )}
                  </div>
                </div>

                <div className="mt-4 grid gap-3 border-t border-border/70 pt-4 md:grid-cols-3">
                  <ConnectionFact icon={ShieldCheck} label="Runtime" value="bundled lark-cli" />
                  <ConnectionFact
                    icon={Lock}
                    label="Local home"
                    value={status?.homePath ?? 'Not initialized'}
                  />
                  <ConnectionFact
                    icon={Check}
                    label="Version"
                    value={status?.version ?? 'Unknown'}
                  />
                </div>

                {setupOutput ? (
                  <pre className="mt-4 max-h-40 overflow-auto rounded-md border border-border/70 bg-background/50 p-3 text-xs text-muted-foreground">
                    {setupOutput}
                  </pre>
                ) : null}
              </article>
            ) : null}
          </div>

          <aside className="space-y-4">
            <div className="rounded-lg border border-border/70 bg-card/30 p-4">
              <h2 className="text-sm font-medium">Pi orchestration</h2>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Pi receives `DIVO_LARK_CLI`, `DIVO_LARK_CLI_HOME`, and a first-in-PATH wrapper.
                Lark tasks can call `lark-cli` directly without using your global shell install.
              </p>
              <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                <p className="rounded-md border border-border/70 bg-background/40 p-2">
                  Personal Lark stays local to this desktop.
                </p>
                <p className="rounded-md border border-border/70 bg-background/40 p-2">
                  Company/shared SaaS access still goes through the Divo backend gateway.
                </p>
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  )
}

function ConnectionListState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-card/30 p-5">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        {description}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg border border-border/70 bg-background/40 px-3 py-2">
      <div className="text-base font-medium">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function ConnectionCard({ connection }: { connection: DivoConnection }) {
  const isShared = connection.kind === 'company_shared'
  const isReadOnly = connection.access === 'read_only'

  return (
    <article className="rounded-lg border border-border/70 bg-card/30 p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot status={connection.status} />
            <h3 className="text-sm font-medium">{connection.label}</h3>
            <Badge tone={isShared ? 'blue' : 'neutral'}>
              {isShared ? 'Shared' : 'Personal'}
            </Badge>
            <Badge tone={isReadOnly ? 'amber' : 'green'}>
              {isReadOnly ? 'Read-only' : connection.access === 'admin' ? 'Admin' : 'Read/write'}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {connection.accountEmail}
          </p>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            {connection.recommendedFor}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {connection.status === 'needs_attention' ? (
            <Button variant="outline" size="sm">
              <RefreshCw className="size-4" />
              Reconnect
            </Button>
          ) : (
            <Button variant="outline" size="sm">
              Manage
            </Button>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-3 border-t border-border/70 pt-4 md:grid-cols-3">
        <ConnectionFact
          icon={isShared ? Users : User}
          label={isShared ? 'Connection owner' : 'Owner'}
          value={connection.grantedBy ?? connection.owner}
        />
        <ConnectionFact
          icon={ShieldCheck}
          label="Pi alias"
          value={connection.piAlias}
        />
        <ConnectionFact
          icon={CalendarDays}
          label="Last used"
          value={connection.lastUsedAt}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {connection.scopes.map((scope) => (
          <span
            key={scope}
            className="rounded-md border border-border/70 bg-muted/30 px-2 py-1 text-xs text-muted-foreground"
          >
            {scope}
          </span>
        ))}
      </div>
    </article>
  )
}

function ConnectionFact({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-sm">{value}</p>
      </div>
    </div>
  )
}

function PiContextCard({ connections }: { connections: DivoConnection[] }) {
  return (
    <div className="rounded-lg border border-border/70 bg-card/30 p-4">
      <h2 className="text-sm font-medium">What Pi will see</h2>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        Connection routing will be delivered as skill context. Pi should select
        by alias, account, grant, and task intent before using Google tools.
      </p>
      <div className="mt-3 space-y-2">
        {connections.slice(0, 4).map((connection) => (
          <div
            key={connection.id}
            className="rounded-md border border-border/70 bg-background/40 p-2"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-xs font-medium">{connection.piAlias}</p>
              <span className="shrink-0 text-xs text-muted-foreground">
                {connection.access === 'read_only' ? 'read' : 'write'}
              </span>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {connection.accountEmail}
            </p>
          </div>
        ))}
      </div>
    </div>
  )
}

function AddConnectionDialog({
  open,
  onConnected,
  onOpenChange,
}: {
  open: boolean
  onConnected: () => void | Promise<void>
  onOpenChange: (open: boolean) => void
}) {
  const [isStartingOAuth, setIsStartingOAuth] = useState(false)

  const handleContinueWithGoogle = async () => {
    setIsStartingOAuth(true)
    console.debug('[DivoPlugins] google_oauth.start')
    try {
      const authorizeUrl = await invoke<string>('divo_google_authorize_url')
      console.debug('[DivoPlugins] google_oauth.authorize_url_received', {
        hasUrl: Boolean(authorizeUrl),
      })
      await openExternalUrl(authorizeUrl)
      console.debug('[DivoPlugins] google_oauth.browser_opened')
      toast.success('Google sign-in opened')
      onOpenChange(false)
      setTimeout(() => void onConnected(), 1500)
    } catch (error) {
      console.error('[DivoPlugins] google_oauth.failed', error)
      toast.error('Google connection failed', {
        description: String(error),
      })
    } finally {
      setIsStartingOAuth(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-64px)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Google Workspace connection</DialogTitle>
          <DialogDescription>
            OAuth will be handled by Divo backend. This UI is ready for personal
            accounts and admin-shared company accounts.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <ConnectionOption
            icon={User}
            title="Personal account"
            description="Connect a Google account only you can use by default."
          />
          <ConnectionOption
            icon={Users}
            title="Company shared account"
            description="Connect once, then grant users, departments, or roles access."
          />
          <div className="rounded-lg border border-border/70 bg-muted/30 p-3">
            <div className="flex gap-2">
              <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-xs leading-5 text-muted-foreground">
                Tokens should be encrypted in backend storage for shared accounts.
                Desktop-local secrets should use Keychain, not project files.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void handleContinueWithGoogle()} disabled={isStartingOAuth}>
            <KeyRound className="size-4" />
            {isStartingOAuth ? 'Opening Google...' : 'Continue with Google'}
            <ExternalLink className="size-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConnectionOption({
  icon: Icon,
  title,
  description,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  description: string
}) {
  return (
    <button
      type="button"
      className="flex items-center gap-3 rounded-lg border border-border/70 bg-card/30 p-3 text-left transition-colors hover:bg-accent/50"
    >
      <span className="flex size-10 items-center justify-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-sm leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
      <Check className="ml-auto size-4 text-muted-foreground" />
    </button>
  )
}

function StatusDot({ status }: { status: DivoConnection['status'] }) {
  return (
    <span
      className={cn(
        'size-2 rounded-full',
        status === 'connected' && 'bg-emerald-400',
        status === 'needs_attention' && 'bg-amber-400',
        status === 'disconnected' && 'bg-muted-foreground'
      )}
    />
  )
}

function Badge({
  children,
  tone,
}: {
  children: ReactNode
  tone: 'neutral' | 'blue' | 'amber' | 'green'
}) {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-xs',
        tone === 'neutral' && 'border-border/70 bg-muted/40 text-muted-foreground',
        tone === 'blue' && 'border-sky-400/20 bg-sky-400/10 text-sky-400',
        tone === 'amber' && 'border-amber-400/20 bg-amber-400/10 text-amber-400',
        tone === 'green' && 'border-emerald-400/20 bg-emerald-400/10 text-emerald-400'
      )}
    >
      {children}
    </span>
  )
}
