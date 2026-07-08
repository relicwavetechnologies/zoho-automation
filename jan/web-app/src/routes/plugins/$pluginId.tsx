import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  ArrowLeft,
  Building2,
  CalendarDays,
  Check,
  ChevronRight,
  ExternalLink,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  ShieldCheck,
  Trash2,
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

type GoogleManageGranteeType = 'user' | 'department' | 'role' | 'company'

type GoogleManageGrant = {
  id: string
  granteeType: GoogleManageGranteeType
  granteeId: string
  granteeLabel: string
  granteeDetail: string | null
  access: DivoConnectionAccess
  grantedAt: string
  grantedBy: { id: string; email: string; name: string | null } | null
}

type GoogleManageCandidate = {
  id: string
  name?: string | null
  email?: string | null
  role?: string
  kind?: 'company' | 'department'
  department?: string
}

type GoogleManageData = {
  connection: {
    connectionId: string
    label: string
    accountEmail: string | null
    accountName: string | null
    ownerType: 'user' | 'company'
    access: DivoConnectionAccess
    scopes: string[]
    connectedAt: string
  }
  grants: GoogleManageGrant[]
  candidates: {
    users: GoogleManageCandidate[]
    departments: GoogleManageCandidate[]
    roles: GoogleManageCandidate[]
    company: { id: string; name: string } | null
  }
  accessLevels: Array<{ value: DivoConnectionAccess; label: string; description: string }>
}

type GoogleManageResponse = {
  success: boolean
  data?: GoogleManageData
  message?: string
}

type ManageAccessProvider = 'google' | 'zoho'

type ZohoStatusResponse = {
  success: boolean
  data?: {
    connected: boolean
    canManage: boolean
    connections: Array<{
      connectionId: string
      label: string
      accountEmail: string | null
      accountName: string | null
      ownerType: 'user' | 'company'
      access: DivoConnectionAccess
      scopes: string[]
      connectedAt: string
      lastUsedAt: string | null
    }>
    legacyConnection: {
      connectionId: string
      environment: string
      providerMode: string
      status: string
      scopes: string[]
      connectedAt: string
      lastSyncAt: string | null
      accessTokenExpiresAt: string | null
      tokenFailureCode: string | null
    } | null
  }
  message?: string
}

type DivoSessionStatus = {
  configured: boolean
  backendUrl?: string
  email?: string
  name?: string
  expiresAt?: string
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

type DivoSessionState =
  | { status: 'checking'; session?: never; message?: never }
  | { status: 'connected'; session: DivoSessionStatus; message?: never }
  | { status: 'disconnected'; session?: never; message?: string }

function isDivoAuthError(error: unknown): boolean {
  const message = String(error).toLowerCase()
  return (
    message.includes('no divo session') ||
    message.includes('divo session expired') ||
    message.includes('invalid or expired token') ||
    message.includes('session expired') ||
    message.includes('unauthorized')
  )
}

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
    connectedAt: connection.connectedAt,
  }
}

function toZohoConnectionModel(connection: NonNullable<ZohoStatusResponse['data']>['connections'][number]): DivoConnection {
  const account = connection.accountEmail ?? connection.accountName ?? 'Zoho account'
  const isShared = connection.ownerType === 'company'
  return {
    id: connection.connectionId,
    pluginId: 'zoho',
    label: connection.label || account,
    accountEmail: account,
    kind: isShared ? 'company_shared' : 'personal',
    status: 'connected',
    access: connection.access,
    owner: connection.accountName ?? account,
    scopes: connection.scopes.length ? connection.scopes : ['Zoho CRM', 'Zoho Books'],
    piAlias: connection.label || account,
    recommendedFor: connection.access === 'read_only'
      ? 'Read-only access for Zoho CRM and Books.'
      : connection.access === 'admin'
        ? 'Admin access for Zoho CRM and Books.'
        : 'Read/write access for Zoho CRM and Books.',
    lastUsedAt: formatRelativeDate(connection.lastUsedAt),
    connectedAt: connection.connectedAt,
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

function connectedAtTime(connection: DivoConnection): number {
  if (!connection.connectedAt) return 0
  const timestamp = new Date(connection.connectedAt).getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function pickPostOauthManageConnection(
  previousConnections: DivoConnection[],
  nextConnections: DivoConnection[]
): DivoConnection | null {
  const previousIds = new Set(previousConnections.map((connection) => connection.id))
  const adminConnections = nextConnections.filter((connection) => connection.access === 'admin')
  return (
    adminConnections.find((connection) => !previousIds.has(connection.id)) ??
    [...adminConnections].sort((a, b) => connectedAtTime(b) - connectedAtTime(a))[0] ??
    null
  )
}

function PluginDetailRoute() {
  const navigate = useNavigate()
  const { pluginId } = Route.useParams()
  const [addOpen, setAddOpen] = useState(false)
  const [manageConnection, setManageConnection] = useState<DivoConnection | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    status: 'loading',
    connections: [],
  })
  const [divoSession, setDivoSession] = useState<DivoSessionState>({
    status: 'checking',
  })
  const plugin = getPlugin(pluginId)

  const refreshDivoSession = useCallback(async (): Promise<DivoSessionState> => {
    try {
      const status = await invoke<DivoSessionStatus>('divo_get_session_status')
      if (!status.configured) {
        const next: DivoSessionState = {
          status: 'disconnected',
          message: 'Connect Divo before managing backend-owned plugins.',
        }
        setDivoSession(next)
        return next
      }

      const next: DivoSessionState = { status: 'connected', session: status }
      setDivoSession(next)
      return next
    } catch (error) {
      const next: DivoSessionState = {
        status: 'disconnected',
        message: String(error),
      }
      setDivoSession(next)
      return next
    }
  }, [])

  const loadConnections = useCallback(async () => {
    if (pluginId !== 'google-workspace') {
      setConnectionState({ status: 'ready', connections: [] })
      return []
    }

    setConnectionState((current) => ({ status: 'loading', connections: current.connections }))
    const session = await refreshDivoSession()
    if (session.status !== 'connected') {
      setConnectionState({ status: 'ready', connections: [] })
      return []
    }

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
      return connections
    } catch (error) {
      console.error('[DivoPlugins] google_status.failed', error)
      if (isDivoAuthError(error)) {
        setDivoSession({
          status: 'disconnected',
          message: 'Divo session expired. Reconnect Divo to continue.',
        })
      }
      setConnectionState((current) => ({
        status: 'error',
        connections: current.connections,
        error: String(error),
      }))
      return []
    }
  }, [pluginId, refreshDivoSession])

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
  if (pluginId === 'zoho') {
    return (
      <ZohoPluginDetail
        plugin={plugin}
        onBack={() => navigate({ to: route.plugins.index } as any)}
        onReconnectDivo={() => navigate({ to: route.settings.divo } as any)}
      />
    )
  }

  const personalCount = connections.filter((connection) => connection.kind === 'personal').length
  const sharedCount = connections.filter((connection) => connection.kind === 'company_shared').length
  const activeCount = connections.filter((connection) => connection.status === 'connected').length
  const adminConnections = connections.filter((connection) => connection.access === 'admin')
  const canManageGoogle = divoSession.status === 'connected'
  const openDivoSettings = () => navigate({ to: route.settings.divo } as any)
  const openManageConnection = (connection: DivoConnection) => {
    if (connection.access !== 'admin') {
      toast.error('Admin access required', {
        description: 'Ask the connection owner or a company admin to manage sharing.',
      })
      return
    }
    setManageConnection(connection)
  }
  const openFirstManageableConnection = () => {
    const connection = adminConnections[0]
    if (!connection) {
      toast.error('No admin-managed Google connection')
      return
    }
    openManageConnection(connection)
  }

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
              {adminConnections.length ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openFirstManageableConnection}
                >
                  Manage access
                  <ChevronRight className="size-4" />
                </Button>
              ) : null}
              <Button
                size="sm"
                onClick={() => (canManageGoogle ? setAddOpen(true) : openDivoSettings())}
              >
                <Plus className="size-4" />
                {canManageGoogle ? 'Add connection' : 'Connect Divo'}
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
                  Connect multiple Google accounts, expose the right account to Divo,
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
                  Divo sees these accounts as separate choices with account, purpose,
                  and access level.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void loadConnections()}>
                  <RotateCw className="size-4" />
                  Refresh
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => (canManageGoogle ? setAddOpen(true) : openDivoSettings())}
                >
                  <Plus className="size-4" />
                  {canManageGoogle ? 'Add' : 'Connect Divo'}
                </Button>
              </div>
            </div>

            <div className="grid gap-3">
              {divoSession.status === 'checking' ? (
                <ConnectionListState
                  title="Checking Divo session"
                  description="Verifying desktop access before loading backend-owned connections."
                />
              ) : null}
              {divoSession.status === 'disconnected' ? (
                <ConnectionListState
                  title="Connect Divo to manage Google Workspace"
                  description={
                    divoSession.message ??
                    'Google connections are owned by the Divo backend, so desktop must be signed in first.'
                  }
                  action={
                    <Button size="sm" onClick={openDivoSettings}>
                      Open Divo Settings
                    </Button>
                  }
                />
              ) : null}
              {divoSession.status === 'connected' && connectionState.status === 'loading' && connections.length === 0 ? (
                <ConnectionListState
                  title="Loading Google connections"
                  description="Checking the Divo backend for accounts available to this desktop session."
                />
              ) : null}
              {divoSession.status === 'connected' && connectionState.status === 'error' ? (
                <ConnectionListState
                  title="Could not load Google connections"
                  description={connectionState.error}
                  action={<Button size="sm" onClick={() => void loadConnections()}>Retry</Button>}
                />
              ) : null}
              {divoSession.status === 'connected' && connectionState.status === 'ready' && connections.length === 0 ? (
                <ConnectionListState
                  title="No Google connections yet"
                  description="Connect a Google account to make it available to Divo through the backend."
                  action={<Button size="sm" onClick={() => setAddOpen(true)}>Add connection</Button>}
                />
              ) : null}
              {connections.map((connection) => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  onManage={() => openManageConnection(connection)}
                />
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
        divoSession={divoSession}
        onConnected={async () => {
          const previousConnections = connections
          const nextConnections = await loadConnections()
          const connection = pickPostOauthManageConnection(previousConnections, nextConnections)
          if (connection) {
            setManageConnection(connection)
          }
        }}
        onReconnect={openDivoSettings}
        onOpenChange={setAddOpen}
      />
      <ManageAccessDialog
        connection={manageConnection}
        onOpenChange={(open) => {
          if (!open) setManageConnection(null)
        }}
        onChanged={() => void loadConnections()}
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
                  this device and is exposed to Divo as an isolated `lark-cli` command.
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
                        'Available to Divo through the desktop-local lark-cli wrapper.'}
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
              <h2 className="text-sm font-medium">Divo orchestration</h2>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Divo receives `DIVO_LARK_CLI`, `DIVO_LARK_CLI_HOME`, and a first-in-PATH wrapper.
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

function ZohoPluginDetail({
  plugin,
  onBack,
  onReconnectDivo,
}: {
  plugin: NonNullable<ReturnType<typeof getPlugin>>
  onBack: () => void
  onReconnectDivo: () => void
}) {
  const Icon = plugin.icon
  const [divoSession, setDivoSession] = useState<DivoSessionState>({ status: 'checking' })
  const [status, setStatus] = useState<ZohoStatusResponse['data'] | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manageConnection, setManageConnection] = useState<DivoConnection | null>(null)

  const loadStatus = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const session = await invoke<DivoSessionStatus>('divo_get_session_status')
      if (!session.configured) {
        setDivoSession({
          status: 'disconnected',
          message: 'Connect Divo before managing backend-owned plugins.',
        })
        setStatus(null)
        return
      }
      setDivoSession({ status: 'connected', session })
      const response = await invoke<ZohoStatusResponse>('divo_zoho_status')
      if (!response.success) {
        throw new Error(response.message ?? 'Zoho status request failed')
      }
      setStatus(response.data ?? null)
    } catch (loadError) {
      if (isDivoAuthError(loadError)) {
        setDivoSession({
          status: 'disconnected',
          message: 'Divo session expired. Reconnect Divo to continue.',
        })
      }
      setError(String(loadError))
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const connectZoho = async () => {
    if (divoSession.status !== 'connected') {
      onReconnectDivo()
      return
    }
    setIsBusy(true)
    try {
      const authorizeUrl = await invoke<string>('divo_zoho_authorize_url')
      await openExternalUrl(authorizeUrl)
      toast.success('Zoho sign-in opened')
      setTimeout(() => void loadStatus(), 1500)
    } catch (connectError) {
      toast.error('Zoho connection failed', { description: String(connectError) })
    } finally {
      setIsBusy(false)
    }
  }

  const disconnectZoho = async () => {
    setIsBusy(true)
    try {
      await invoke('divo_zoho_unlink')
      toast.success('Zoho disconnected')
      await loadStatus()
    } catch (disconnectError) {
      toast.error('Could not disconnect Zoho', { description: String(disconnectError) })
    } finally {
      setIsBusy(false)
    }
  }

  const connections = (status?.connections ?? []).map(toZohoConnectionModel)
  const adminConnections = connections.filter((connection) => connection.access === 'admin')
  const legacyConnection = status?.legacyConnection ?? null
  const connected = Boolean(status?.connected)
  const canManage = Boolean(status?.canManage)

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
              {divoSession.status !== 'connected' ? (
                <Button size="sm" onClick={onReconnectDivo}>
                  Connect Divo
                </Button>
              ) : canManage ? (
                <>
                  {adminConnections.length ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setManageConnection(adminConnections[0] ?? null)}
                    >
                      Manage access
                    </Button>
                  ) : null}
                  {connected ? (
                    <Button variant="outline" size="sm" onClick={() => void disconnectZoho()} disabled={isBusy}>
                      Disconnect all
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => void connectZoho()} disabled={isBusy}>
                    <KeyRound className="size-4" />
                    Add Zoho
                    <ExternalLink className="size-4" />
                  </Button>
                </>
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
                <h1 className="text-2xl font-medium tracking-normal">{plugin.name}</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Connect Zoho through Divo backend. Admins can share specific accounts with users,
                  departments, roles, or the whole company.
                </p>
              </div>
            </div>

            <div className="grid min-w-72 grid-cols-3 gap-2">
              <Metric value={connected ? 'On' : 'Off'} label="Connection" />
              <Metric value={connections.length ? String(connections.length) : legacyConnection ? 'Legacy' : '0'} label="Accounts" />
              <Metric value={canManage ? 'Admin' : 'Member'} label="Access" />
            </div>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-4">
            {divoSession.status === 'disconnected' ? (
              <ConnectionListState
                title="Connect Divo to manage Zoho"
                description={divoSession.message ?? 'Zoho is a backend-owned plugin.'}
                action={<Button size="sm" onClick={onReconnectDivo}>Open Divo Settings</Button>}
              />
            ) : isLoading ? (
              <ConnectionListState
                title="Checking Zoho"
                description="Reading the company Zoho connection from Divo backend."
              />
            ) : error ? (
              <ConnectionListState
                title="Could not load Zoho"
                description={error}
                action={<Button size="sm" onClick={() => void loadStatus()}>Retry</Button>}
              />
            ) : connections.length ? (
              connections.map((connection) => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  onManage={() => setManageConnection(connection)}
                />
              ))
            ) : connected && legacyConnection ? (
              <article className="rounded-lg border border-border/70 bg-card/30 p-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusDot status="connected" />
                      <h2 className="text-sm font-medium">Legacy Zoho company connection</h2>
                      <Badge tone="amber">Reconnect recommended</Badge>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      This older company connection still exists, but it is not shareable per user yet.
                      Reconnect Zoho to create a managed account with access grants.
                    </p>
                  </div>
                  {canManage ? (
                    <Button size="sm" onClick={() => void connectZoho()} disabled={isBusy}>
                      <KeyRound className="size-4" />
                      Reconnect Zoho
                      <ExternalLink className="size-4" />
                    </Button>
                  ) : null}
                </div>
                <div className="mt-4 grid gap-3 border-t border-border/70 pt-4 md:grid-cols-3">
                  <ConnectionFact icon={ShieldCheck} label="Environment" value={legacyConnection.environment} />
                  <ConnectionFact icon={CalendarDays} label="Connected" value={formatRelativeDate(legacyConnection.connectedAt)} />
                  <ConnectionFact icon={Check} label="Token" value={legacyConnection.tokenFailureCode ?? 'Healthy'} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {legacyConnection.scopes.slice(0, 8).map((scope) => (
                    <span
                      key={scope}
                      className="rounded-md border border-border/70 bg-muted/30 px-2 py-1 text-xs text-muted-foreground"
                    >
                      {scope}
                    </span>
                  ))}
                </div>
              </article>
            ) : (
              <ConnectionListState
                title="Zoho is not connected"
                description={
                  canManage
                    ? 'Connect Zoho with OAuth to enable CRM and Books tools.'
                    : 'Ask a company admin to connect Zoho.'
                }
                action={
                  canManage ? (
                    <Button size="sm" onClick={() => void connectZoho()} disabled={isBusy}>
                      <KeyRound className="size-4" />
                      Connect Zoho
                      <ExternalLink className="size-4" />
                    </Button>
                  ) : undefined
                }
              />
            )}
          </div>

	          <aside className="space-y-4">
            <div className="rounded-lg border border-border/70 bg-card/30 p-4">
              <h2 className="text-sm font-medium">Available services</h2>
              <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                <p className="rounded-md border border-border/70 bg-background/40 p-2">Zoho CRM modules</p>
                <p className="rounded-md border border-border/70 bg-background/40 p-2">Zoho Books contacts, invoices, and expenses</p>
                <p className="rounded-md border border-border/70 bg-background/40 p-2">Backend token refresh and encrypted storage</p>
              </div>
	            </div>

	            <PiContextCard connections={connections} />
	          </aside>
	        </section>
	      </main>

	      <ManageAccessDialog
	        provider="zoho"
	        connection={manageConnection}
	        onOpenChange={(open) => {
	          if (!open) setManageConnection(null)
	        }}
	        onChanged={() => void loadStatus()}
	      />
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

function ConnectionCard({
  connection,
  onManage,
}: {
  connection: DivoConnection
  onManage: () => void
}) {
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
          ) : connection.access === 'admin' ? (
            <Button variant="outline" size="sm" onClick={onManage}>
              Manage
            </Button>
          ) : null}
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
          label="Divo alias"
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
      <h2 className="text-sm font-medium">What Divo will see</h2>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        Connection routing will be delivered as skill context. Divo should select
        by alias, account, grant, and task intent before using backend tools.
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

function ManageAccessDialog({
  provider = 'google',
  connection,
  onOpenChange,
  onChanged,
}: {
  provider?: ManageAccessProvider
  connection: DivoConnection | null
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}) {
  const [data, setData] = useState<GoogleManageData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [granteeType, setGranteeType] = useState<GoogleManageGranteeType>('user')
  const [granteeId, setGranteeId] = useState('')
  const [access, setAccess] = useState<DivoConnectionAccess>('read_only')
  const [query, setQuery] = useState('')
  const open = Boolean(connection)
  const providerLabel = provider === 'zoho' ? 'Zoho' : 'Google'
  const commandNames = provider === 'zoho'
    ? {
      manage: 'divo_zoho_manage_access',
      grant: 'divo_zoho_grant_access',
      revoke: 'divo_zoho_revoke_access',
    }
    : {
      manage: 'divo_google_manage_access',
      grant: 'divo_google_grant_access',
      revoke: 'divo_google_revoke_access',
    }

  const loadManageData = useCallback(async () => {
    if (!connection) return
    setIsLoading(true)
    setError(null)
    try {
      const response = await invoke<GoogleManageResponse>(commandNames.manage, {
        connectionId: connection.id,
        connection_id: connection.id,
      })
      if (!response.success || !response.data) {
        throw new Error(response.message ?? 'Could not load access settings')
      }
      setData(response.data)
      setGranteeId('')
    } catch (loadError) {
      setError(String(loadError))
    } finally {
      setIsLoading(false)
    }
  }, [commandNames.manage, connection])

  useEffect(() => {
    if (connection) {
      void loadManageData()
    } else {
      setData(null)
      setError(null)
      setQuery('')
      setGranteeType('user')
      setGranteeId('')
      setAccess('read_only')
    }
  }, [connection, loadManageData])

  const candidates = data ? getCandidatesForType(data, granteeType) : []
  const filteredCandidates = candidates.filter((candidate) => {
    const haystack = [
      candidate.name,
      candidate.email,
      candidate.role,
      candidate.department,
      candidate.id,
    ].filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(query.trim().toLowerCase())
  })

  const grantAccess = async () => {
    if (!connection || !granteeId) {
      toast.error('Choose who should get access')
      return
    }
    setIsSaving(true)
    try {
      const response = await invoke<GoogleManageResponse>(commandNames.grant, {
        connectionId: connection.id,
        connection_id: connection.id,
        granteeType,
        grantee_type: granteeType,
        granteeId,
        grantee_id: granteeId,
        access,
      })
      if (!response.success || !response.data) {
        throw new Error(response.message ?? 'Could not grant access')
      }
      setData(response.data)
      setGranteeId(granteeType === 'company' ? response.data.candidates.company?.id ?? '' : '')
      setQuery('')
      toast.success('Access updated')
      onChanged()
    } catch (saveError) {
      toast.error('Could not update access', { description: String(saveError) })
    } finally {
      setIsSaving(false)
    }
  }

  const revokeGrant = async (grant: GoogleManageGrant) => {
    if (!connection) return
    setIsSaving(true)
    try {
      const response = await invoke<GoogleManageResponse>(commandNames.revoke, {
        connectionId: connection.id,
        connection_id: connection.id,
        grantId: grant.id,
        grant_id: grant.id,
      })
      if (!response.success || !response.data) {
        throw new Error(response.message ?? 'Could not revoke access')
      }
      setData(response.data)
      toast.success('Access removed')
      onChanged()
    } catch (revokeError) {
      toast.error('Could not remove access', { description: String(revokeError) })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-64px)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Manage {providerLabel} access</DialogTitle>
          <DialogDescription>
            Share this connection with users, departments, roles, or the whole company.
          </DialogDescription>
        </DialogHeader>

        {connection ? (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{connection.label}</p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {connection.accountEmail}
                  </p>
                </div>
                <Badge tone={connection.access === 'admin' ? 'green' : 'amber'}>
                  {formatAccessLabel(connection.access)}
                </Badge>
              </div>
            </div>

            {isLoading ? (
              <ConnectionListState
                title="Loading access settings"
                description="Reading current grants and company members from Divo backend."
              />
            ) : null}
            {error ? (
              <ConnectionListState
                title="Could not load access"
                description={error}
                action={<Button size="sm" onClick={() => void loadManageData()}>Retry</Button>}
              />
            ) : null}

            {data && !error ? (
              <>
                <section className="rounded-lg border border-border/70 bg-card/30 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-medium">Grant access</h3>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">
                        Read-only maps to read tools. Read/write maps to send, create, update, and delete tools. Admin can manage sharing.
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-[160px_minmax(0,1fr)_160px]">
                    <select
                      className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                      value={granteeType}
                      onChange={(event) => {
                        const nextType = event.target.value as GoogleManageGranteeType
                        setGranteeType(nextType)
                        setQuery('')
                        setGranteeId(nextType === 'company' ? data.candidates.company?.id ?? '' : '')
                      }}
                    >
                      <option value="user">User</option>
                      <option value="department">Department</option>
                      <option value="role">Role</option>
                      <option value="company">Company</option>
                    </select>

                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
                      <input
                        className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm outline-none"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={`Search ${granteeType}`}
                        disabled={granteeType === 'company'}
                      />
                    </div>

                    <select
                      className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                      value={access}
                      onChange={(event) => setAccess(event.target.value as DivoConnectionAccess)}
                    >
                      {data.accessLevels.map((level) => (
                        <option key={level.value} value={level.value}>
                          {level.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="mt-3 max-h-44 overflow-y-auto rounded-md border border-border/70">
                    {filteredCandidates.length ? (
                      filteredCandidates.map((candidate) => (
                        <button
                          key={`${granteeType}:${candidate.id}`}
                          type="button"
                          className={cn(
                            'flex w-full items-center justify-between gap-3 border-b border-border/70 px-3 py-2 text-left last:border-b-0 hover:bg-muted/40',
                            granteeId === candidate.id && 'bg-muted/50'
                          )}
                          onClick={() => setGranteeId(candidate.id)}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {candidateLabel(candidate)}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {candidateDetail(candidate, granteeType)}
                            </span>
                          </span>
                          {granteeId === candidate.id ? <Check className="size-4 shrink-0" /> : null}
                        </button>
                      ))
                    ) : (
                      <p className="p-3 text-sm text-muted-foreground">No matches found.</p>
                    )}
                  </div>

                  <div className="mt-3 flex justify-end">
                    <Button size="sm" onClick={() => void grantAccess()} disabled={isSaving || !granteeId}>
                      <ShieldCheck className="size-4" />
                      Grant access
                    </Button>
                  </div>
                </section>

                <section className="rounded-lg border border-border/70 bg-card/30 p-4">
                  <h3 className="text-sm font-medium">Current access</h3>
                  <div className="mt-3 space-y-2">
                    {data.grants.length ? (
                      data.grants.map((grant) => (
                        <div
                          key={grant.id}
                          className="flex flex-col gap-3 rounded-md border border-border/70 bg-background/40 p-3 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/40">
                              <GrantIcon type={grant.granteeType} />
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{grant.granteeLabel}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {grant.granteeType} · {grant.granteeDetail ?? 'Direct grant'}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge tone={grant.access === 'admin' ? 'green' : grant.access === 'read_only' ? 'amber' : 'blue'}>
                              {formatAccessLabel(grant.access)}
                            </Badge>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => void revokeGrant(grant)}
                              disabled={isSaving}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="rounded-md border border-border/70 bg-background/40 p-3 text-sm text-muted-foreground">
                        No shared grants yet.
                      </p>
                    )}
                  </div>
                </section>
              </>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function getCandidatesForType(data: GoogleManageData, type: GoogleManageGranteeType): GoogleManageCandidate[] {
  if (type === 'user') return data.candidates.users
  if (type === 'department') return data.candidates.departments
  if (type === 'role') return data.candidates.roles
  return data.candidates.company ? [data.candidates.company] : []
}

function candidateLabel(candidate: GoogleManageCandidate): string {
  return candidate.name ?? candidate.email ?? candidate.id
}

function candidateDetail(candidate: GoogleManageCandidate, type: GoogleManageGranteeType): string {
  if (type === 'user') return [candidate.email, candidate.role].filter(Boolean).join(' · ') || 'Company user'
  if (type === 'role') return candidate.department ? `${candidate.department} role` : 'Company role'
  if (type === 'department') return 'Department'
  return 'Whole company'
}

function formatAccessLabel(access: DivoConnectionAccess): string {
  if (access === 'read_only') return 'Read-only'
  if (access === 'read_write') return 'Read/write'
  return 'Admin'
}

function GrantIcon({ type }: { type: GoogleManageGranteeType }) {
  if (type === 'user') return <User className="size-4 text-muted-foreground" />
  if (type === 'department') return <Users className="size-4 text-muted-foreground" />
  if (type === 'role') return <ShieldCheck className="size-4 text-muted-foreground" />
  return <Building2 className="size-4 text-muted-foreground" />
}

function AddConnectionDialog({
  open,
  divoSession,
  onConnected,
  onReconnect,
  onOpenChange,
}: {
  open: boolean
  divoSession: DivoSessionState
  onConnected: () => void | Promise<void>
  onReconnect: () => void
  onOpenChange: (open: boolean) => void
}) {
  const [isStartingOAuth, setIsStartingOAuth] = useState(false)

  const handleContinueWithGoogle = async () => {
    if (divoSession.status !== 'connected') {
      toast.error('Connect Divo first', {
        description: 'Google connections are stored and authorized through the Divo backend.',
      })
      onReconnect()
      return
    }

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
      if (isDivoAuthError(error)) {
        toast.error('Reconnect Divo to continue', {
          description: 'Your desktop session expired before Google OAuth could start.',
        })
        onOpenChange(false)
        onReconnect()
        return
      }
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
          {divoSession.status !== 'connected' ? (
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
              <div className="flex gap-2">
                <Lock className="mt-0.5 size-4 shrink-0 text-amber-300" />
                <p className="text-xs leading-5 text-amber-100">
                  Connect Divo before starting Google OAuth. The backend needs
                  your Divo company session to save and authorize this connection.
                </p>
              </div>
            </div>
          ) : null}
          <ConnectionOption
            icon={User}
            title="Connect account"
            description="OAuth creates a backend-owned Google connection with admin access for you."
          />
          <ConnectionOption
            icon={Users}
            title="Share after connect"
            description="After OAuth, use Manage to grant users, departments, roles, or the company access."
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
            {divoSession.status !== 'connected'
              ? 'Connect Divo first'
              : isStartingOAuth
                ? 'Opening Google...'
                : 'Continue with Google'}
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
    <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-card/30 p-3 text-left">
      <span className="flex size-10 items-center justify-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-sm leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </div>
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
