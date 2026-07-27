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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { ToolAccessBlock } from '@/components/tool-access/ToolAccessPanel'
import { AccessScopeSkeleton, ConnectionRowsSkeleton } from '@/components/tool-catalogue/ToolSkeletons'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import HeaderPage from '@/containers/HeaderPage'
import { route } from '@/constants/routes'
import {
  getPlugin,
  googleWorkspaceServices,
  type DivoConnection,
  type DivoConnectionAccess,
} from '@/lib/plugins'
import { getDivoToolsInventory, type DivoToolInventoryItem } from '@/lib/divo-tools'
import { groupToolsForDetail } from '@/lib/tool-presentation'
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

type CloudStatusConnection = {
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

type CloudStatusResponse = {
  success: boolean
  data?: {
    connected: boolean
    connections: CloudStatusConnection[]
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
    ownerUser: { id: string; email: string; name: string | null } | null
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
  governance: {
    managerPolicy: ConnectionGovernancePolicy
    managerConfiguredAt: string | null
    adminOverride: ConnectionGovernancePolicy | null
    adminOverriddenAt: string | null
    source: 'platform_default' | 'manager_policy' | 'company_admin_override'
    version: number
  }
}

type ConnectionPerson = {
  userId: string
  name: string
  email: string
  companyRole: string | null
  access: DivoConnectionAccess
  source: 'owner' | 'direct_grant'
  grant: GoogleManageGrant | null
}

type ConnectionAction = 'read' | 'create' | 'update' | 'delete' | 'send' | 'execute'
type ConnectionApprovalMode = 'none' | 'connection_owner' | 'company_admin'
type ConnectionActionPolicy = {
  mode: 'inherit' | 'enforced'
  requestsPerMinute?: number | null
  requestsPerDay?: number | null
  approval?: ConnectionApprovalMode
}
type ConnectionGovernancePolicy = {
  version: 1
  actions: Partial<Record<ConnectionAction, ConnectionActionPolicy>>
}

const connectionActions: Array<{ id: ConnectionAction; label: string }> = [
  { id: 'read', label: 'Read' },
  { id: 'create', label: 'Create' },
  { id: 'update', label: 'Update' },
  { id: 'delete', label: 'Delete' },
  { id: 'send', label: 'Send' },
  { id: 'execute', label: 'Execute' },
]

function defaultConnectionGovernancePolicy(): ConnectionGovernancePolicy {
  return {
    version: 1,
    actions: Object.fromEntries(connectionActions.map(({ id }) => [id, { mode: 'inherit' }])) as ConnectionGovernancePolicy['actions'],
  }
}

type GoogleManageResponse = {
  success: boolean
  data?: GoogleManageData
  message?: string
}

type ManageAccessProvider = 'google' | 'zoho' | 'canva' | 'lark' | 'airtable'

type CloudProviderConfig = {
  provider: Extract<ManageAccessProvider, 'google' | 'canva' | 'lark' | 'airtable'>
  pluginId: 'google-workspace' | 'canva' | 'lark' | 'airtable'
  label: 'Google Workspace' | 'Canva' | 'Lark' | 'Airtable'
  connectionLabel: 'Google' | 'Canva' | 'Lark' | 'Airtable'
  accountFallback: string
  /**
   * Whether the backend's authorize-url accepts a `label`. These providers
   * allow several connections per company, so the member names the one they
   * are creating; single-account providers have nothing to disambiguate.
   */
  supportsLabel?: boolean
  commands: {
    authorize: string
    patConnect?: string
    status: string
    disconnect: string
  }
}

/**
 * Exported so the registry invariant can be asserted: the detail page renders
 * the connect flow only when this record AND the `divoPlugins` catalogue both
 * know the id. Airtable was in neither, then in only one, and both times fell
 * through to the read-only access page with no way to connect.
 */
export const cloudProviders: Record<CloudProviderConfig['pluginId'], CloudProviderConfig> = {
  'google-workspace': {
    provider: 'google',
    pluginId: 'google-workspace',
    label: 'Google Workspace',
    connectionLabel: 'Google',
    accountFallback: 'Google account',
    commands: {
      authorize: 'divo_google_authorize_url',
      status: 'divo_google_status',
      disconnect: 'divo_google_disconnect_connection',
    },
  },
  canva: {
    provider: 'canva',
    pluginId: 'canva',
    label: 'Canva',
    connectionLabel: 'Canva',
    accountFallback: 'Canva connection',
    supportsLabel: true,
    commands: {
      authorize: 'divo_canva_authorize_url',
      status: 'divo_canva_status',
      disconnect: 'divo_canva_disconnect_connection',
    },
  },
  lark: {
    provider: 'lark',
    pluginId: 'lark',
    label: 'Lark',
    connectionLabel: 'Lark',
    accountFallback: 'Lark account',
    commands: {
      authorize: 'divo_lark_authorize_url',
      status: 'divo_lark_status',
      disconnect: 'divo_lark_disconnect_connection',
    },
  },
  airtable: {
    provider: 'airtable',
    pluginId: 'airtable',
    label: 'Airtable',
    connectionLabel: 'Airtable',
    accountFallback: 'Airtable account',
    supportsLabel: true,
    commands: {
      authorize: 'divo_airtable_authorize_url',
      patConnect: 'divo_airtable_pat_connect',
      status: 'divo_airtable_status',
      disconnect: 'divo_airtable_disconnect_connection',
    },
  },
}

const canvaServices = [
  { name: 'Designs', description: 'Search, generate, edit, and export approved designs.', icon: CalendarDays },
  { name: 'Assets & folders', description: 'Find assets and organize design work with Divo.', icon: KeyRound },
  { name: 'Collaboration', description: 'Read and add design comments through shared access.', icon: Users },
]

const airtableServices = [
  { name: 'Records', description: 'Search, read, create and update records in bases you have access to.', icon: Users },
  { name: 'Base schema', description: 'Inspect tables and fields, and reshape a base when approved.', icon: KeyRound },
  { name: 'Interfaces & automations', description: 'Review interfaces and automation runs through Divo controls.', icon: CalendarDays },
]

const larkServices = [
  { name: 'Messaging & contacts', description: 'Read permitted chats and send approved messages through the selected Lark connection.', icon: Users },
  { name: 'Calendar & tasks', description: 'Read schedules and manage tasks when the shared connection and Divo policy allow it.', icon: CalendarDays },
  { name: 'Docs, Base & approvals', description: 'Work with authorised documents, Bases, and approval flows through Divo controls.', icon: KeyRound },
]

// Derived from the registry rather than a parallel list of ids: the previous
// hardcoded check silently sent any unlisted provider to the generic tool-access
// page, which is how Airtable ended up with no way to connect.
function getCloudProvider(pluginId: string): CloudProviderConfig | null {
  return Object.prototype.hasOwnProperty.call(cloudProviders, pluginId)
    ? cloudProviders[pluginId as CloudProviderConfig['pluginId']]
    : null
}

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

const zohoDataCentres = [
  { label: 'India', value: 'https://accounts.zoho.in' },
  { label: 'United States', value: 'https://accounts.zoho.com' },
  { label: 'Europe', value: 'https://accounts.zoho.eu' },
  { label: 'Australia', value: 'https://accounts.zoho.com.au' },
  { label: 'Japan', value: 'https://accounts.zoho.jp' },
  { label: 'Canada', value: 'https://accounts.zohocloud.ca' },
  { label: 'Saudi Arabia', value: 'https://accounts.zoho.sa' },
  { label: 'United Kingdom', value: 'https://accounts.zoho.uk' },
]

type DivoSessionStatus = {
  configured: boolean
  backendUrl?: string
  email?: string
  name?: string
  expiresAt?: string
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

function toConnectionModel(connection: CloudStatusConnection, provider: CloudProviderConfig): DivoConnection {
  const account = connection.accountEmail ?? connection.accountName ?? provider.accountFallback
  const isShared = connection.ownerType === 'company'
  const scopeLabels = formatGoogleScopes(connection.scopes)

  return {
    id: connection.connectionId,
    pluginId: provider.pluginId,
    label: connection.label || account,
    accountEmail: account,
    kind: isShared ? 'company_shared' : 'personal',
    status: 'connected',
    access: connection.access,
    owner: connection.accountName ?? account,
    scopes: scopeLabels.length ? scopeLabels : [provider.label],
    piAlias: connection.label || account,
    recommendedFor: buildConnectionRecommendation(connection.access, scopeLabels, provider.label),
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

function buildConnectionRecommendation(access: DivoConnectionAccess, scopes: string[], fallback: string): string {
  const services = scopes.length ? scopes.join(', ') : fallback
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

/**
 * Every other route in the app wears HeaderPage, which is where the "open
 * sidebar" control lives. These tool pages did not, so collapsing the sidebar
 * here left the window with no navigation and no way to bring it back.
 *
 * It wraps the whole route rather than each of the four detail variants, so a
 * new variant cannot forget it.
 */
export function PluginDetailRoute() {
  return (
    <div className="flex h-svh w-full min-h-0 flex-col bg-background">
      <HeaderPage />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <PluginDetailContent />
      </div>
    </div>
  )
}

function PluginDetailContent() {
  const navigate = useNavigate()
  const { pluginId } = Route.useParams()
  const [addOpen, setAddOpen] = useState(false)
  const [manageConnection, setManageConnection] = useState<DivoConnection | null>(null)
  const [disconnectConnection, setDisconnectConnection] = useState<DivoConnection | null>(null)
  const [connectionActionId, setConnectionActionId] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    status: 'loading',
    connections: [],
  })
  const [divoSession, setDivoSession] = useState<DivoSessionState>({
    status: 'checking',
  })
  const [toolInventory, setToolInventory] = useState<DivoToolInventoryItem[] | null>(null)
  const [toolInventoryError, setToolInventoryError] = useState<string | null>(null)
  const inventoryRequestGeneration = useRef(0)
  const plugin = getPlugin(pluginId)
  const cloudProvider = getCloudProvider(pluginId)

  const invalidateInventoryRequests = useCallback(() => {
    inventoryRequestGeneration.current++
  }, [])

  const loadToolInventory = useCallback(async () => {
    const requestGeneration = ++inventoryRequestGeneration.current
    setToolInventoryError(null)
    try {
      const response = await getDivoToolsInventory()
      if (requestGeneration !== inventoryRequestGeneration.current) return
      setToolInventory(response.tools)
    } catch (error) {
      if (requestGeneration !== inventoryRequestGeneration.current) return
      setToolInventory(null)
      setToolInventoryError(String(error))
    }
  }, [])

  useEffect(() => {
    void loadToolInventory()
    return invalidateInventoryRequests
  }, [invalidateInventoryRequests, loadToolInventory])
  const liveGroup = useMemo(
    () => toolInventory ? groupToolsForDetail(toolInventory, pluginId) : null,
    [pluginId, toolInventory],
  )

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
    if (!liveGroup) return []
    if (!cloudProvider) {
      setConnectionState({ status: 'ready', connections: [] })
      return []
    }

    setConnectionState((current) => ({ status: 'loading', connections: current.connections }))
    const session = await refreshDivoSession()
    if (session.status !== 'connected') {
      setConnectionState({ status: 'ready', connections: [] })
      return []
    }

    console.debug('[DivoPlugins] cloud_status.start', { provider: cloudProvider.provider })
    try {
      const response = await invoke<CloudStatusResponse>(cloudProvider.commands.status)
      if (!response.success) {
        throw new Error(response.message ?? `${cloudProvider.label} status request failed`)
      }

      const connections = (response.data?.connections ?? []).map(connection => toConnectionModel(connection, cloudProvider))
      console.debug('[DivoPlugins] cloud_status.ok', {
        provider: cloudProvider.provider,
        connectionCount: connections.length,
      })
      setConnectionState({ status: 'ready', connections })
      return connections
    } catch (error) {
      console.error('[DivoPlugins] cloud_status.failed', { provider: cloudProvider.provider, error })
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
  }, [cloudProvider, liveGroup, refreshDivoSession])

  useEffect(() => {
    void loadConnections()
  }, [loadConnections])

  const connections = connectionState.connections

  if (toolInventoryError) return <DetailInventoryState title="Could not load tools" description={toolInventoryError} onRetry={() => void loadToolInventory()} />
  if (!toolInventory) return <DetailInventoryState title="Loading tool details" description="Checking your current Divo tool inventory." />
  if (!liveGroup) return <DetailInventoryState title="Tool unavailable" description="This detail URL is not available in your current Divo tool inventory." />

  if (pluginId === 'zoho' && plugin) {
    return (
      <ZohoPluginDetail plugin={plugin!} onBack={() => navigate({ to: route.plugins.index } as any)} onReconnectDivo={() => navigate({ to: route.settings.divo } as any)} accessContent={<ToolAccessBlock items={liveGroup.childTools} onUpdated={() => void loadToolInventory()} />} />
    )
  }

  if (pluginId === 'tool-webSearch') return <WebSearchPluginDetail group={liveGroup} onBack={() => navigate({ to: route.plugins.index } as any)} onUpdated={() => void loadToolInventory()} />
  if (!cloudProvider) return <FallbackToolDetail group={liveGroup} onBack={() => navigate({ to: route.plugins.index } as any)} onUpdated={() => void loadToolInventory()} />
  if (!plugin) return <FallbackToolDetail group={liveGroup} onBack={() => navigate({ to: route.plugins.index } as any)} onUpdated={() => void loadToolInventory()} />

  const Icon = plugin.icon

  const personalCount = connections.filter((connection) => connection.kind === 'personal').length
  const sharedCount = connections.filter((connection) => connection.kind === 'company_shared').length
  const activeCount = connections.filter((connection) => connection.status === 'connected').length
  const adminConnections = connections.filter((connection) => connection.access === 'admin')
  const canManageConnections = divoSession.status === 'connected'
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
      toast.error(`No admin-managed ${cloudProvider.label} connection`)
      return
    }
    openManageConnection(connection)
  }
  const reconnectConnection = async (connection: DivoConnection) => {
    setConnectionActionId(connection.id)
    try {
      const authorizeUrl = await invoke<string>(cloudProvider.commands.authorize)
      await openExternalUrl(authorizeUrl)
      toast.success(`${cloudProvider.label} sign-in opened`, {
        description: `Choose ${connection.accountEmail} to reconnect this account.`,
      })
      setTimeout(() => void loadConnections(), 1500)
    } catch (reconnectError) {
      toast.error(`Could not reconnect ${cloudProvider.label}`, { description: String(reconnectError) })
    } finally {
      setConnectionActionId(null)
    }
  }
  const confirmDisconnectConnection = async () => {
    if (!disconnectConnection) return
    const connection = disconnectConnection
    setConnectionActionId(connection.id)
    try {
      await invoke(cloudProvider.commands.disconnect, {
        connectionId: connection.id,
        connection_id: connection.id,
      })
      setDisconnectConnection(null)
      toast.success(`${cloudProvider.label} connection disconnected`)
      await loadConnections()
    } catch (disconnectError) {
      toast.error(`Could not disconnect ${cloudProvider.label}`, { description: String(disconnectError) })
    } finally {
      setConnectionActionId(null)
    }
  }

  return (
    <div className="min-h-full">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6 lg:px-8">
        <header className="flex flex-col gap-5 rounded-lg border border-border/70 bg-card/30 p-5">
          <div className="flex items-center justify-between gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate({ to: route.plugins.index } as any)}
            >
              <ArrowLeft className="size-4" />
              Tools
            </Button>
            <div className="flex items-center gap-2">
              {adminConnections.length ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openFirstManageableConnection}
                >
                  Share connection
                  <ChevronRight className="size-4" />
                </Button>
              ) : null}
              <Button
                size="sm"
                onClick={() => (canManageConnections ? setAddOpen(true) : openDivoSettings())}
              >
                <Plus className="size-4" />
                {canManageConnections ? 'Add connection' : 'Connect Divo'}
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
                <Icon className={cn('size-7', plugin.iconClassName)} />
              </div>
              <div>
                <h1 className="text-2xl font-medium tracking-normal">
                  {plugin.name}
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  Connect multiple {cloudProvider.label} accounts, expose the right account to Divo,
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
                  onClick={() => (canManageConnections ? setAddOpen(true) : openDivoSettings())}
                >
                  <Plus className="size-4" />
                  {canManageConnections ? 'Add' : 'Connect Divo'}
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
                  title={`Connect Divo to manage ${cloudProvider.label}`}
                  description={
                    divoSession.message ??
                    `${cloudProvider.label} connections are owned by the Divo backend, so desktop must be signed in first.`
                  }
                  action={
                    <Button size="sm" onClick={openDivoSettings}>
                      Open Divo Settings
                    </Button>
                  }
                />
              ) : null}
              {divoSession.status === 'connected' && connectionState.status === 'loading' && connections.length === 0 ? (
                <ConnectionRowsSkeleton
                  label={`Loading ${cloudProvider.connectionLabel} connections`}
                />
              ) : null}
              {divoSession.status === 'connected' && connectionState.status === 'error' ? (
                <ConnectionListState
                  title={`Could not load ${cloudProvider.connectionLabel} connections`}
                  description={connectionState.error}
                  action={<Button size="sm" onClick={() => void loadConnections()}>Retry</Button>}
                />
              ) : null}
              {divoSession.status === 'connected' && connectionState.status === 'ready' && connections.length === 0 ? (
                <ConnectionListState
                  title={`No ${cloudProvider.connectionLabel} connections yet`}
                  description={`Connect a ${cloudProvider.connectionLabel} account to make it available to Divo through the backend.`}
                  action={<Button size="sm" onClick={() => setAddOpen(true)}>Add connection</Button>}
                />
              ) : null}
              {connections.map((connection) => (
                <ConnectionCard
                  key={connection.id}
                  connection={connection}
                  onManage={() => openManageConnection(connection)}
                  onReconnect={() => void reconnectConnection(connection)}
                  onDisconnect={() => setDisconnectConnection(connection)}
                  busy={connectionActionId === connection.id}
                />
              ))}
            </div>
          </div>

          <aside className="space-y-4">
            <div className="rounded-lg border border-border/70 bg-card/30 p-4">
              <h2 className="text-sm font-medium">Available services</h2>
              <div className="mt-3 space-y-3">
                {(cloudProvider.provider === 'canva' ? canvaServices : cloudProvider.provider === 'lark' ? larkServices : cloudProvider.provider === 'airtable' ? airtableServices : googleWorkspaceServices).map((service) => {
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
        <ToolAccessBlock items={liveGroup.childTools} onUpdated={() => void loadToolInventory()} />
      </main>

      <AddConnectionDialog
        open={addOpen}
        provider={cloudProvider}
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
      <ConnectionManagementSheet
        provider={cloudProvider.provider}
        connection={manageConnection}
        onOpenChange={(open) => {
          if (!open) setManageConnection(null)
        }}
        onChanged={() => void loadConnections()}
      />
      <DisconnectConnectionDialog
        providerLabel={cloudProvider.label}
        connection={disconnectConnection}
        busy={Boolean(disconnectConnection && connectionActionId === disconnectConnection.id)}
        onConfirm={() => void confirmDisconnectConnection()}
        onOpenChange={(open) => { if (!open) setDisconnectConnection(null) }}
      />
    </div>
  )
}

function DetailInventoryState({ title, description, onRetry }: { title: string; description: string; onRetry?: () => void }) {
  return <div className="flex h-full items-center justify-center px-6 py-16"><div className="max-w-md text-center"><h1 className="text-lg font-medium">{title}</h1><p className="mt-2 text-sm text-muted-foreground">{description}</p><div className="mt-4 flex justify-center gap-2"><Button asChild variant="outline"><Link to={route.plugins.index}>Back to Tools</Link></Button>{onRetry ? <Button onClick={onRetry}>Retry</Button> : null}</div></div></div>
}

function FallbackToolDetail({ group, onBack, onUpdated }: { group: NonNullable<ReturnType<typeof groupToolsForDetail>>; onBack: () => void; onUpdated: () => void }) {
  const Icon = group.Icon
  return (
    <div className="min-h-full">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6 lg:px-8">
        <header className="rounded-lg border border-border/70 bg-card/30 p-5">
          <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="size-4" />Back to Tools</Button>
          <div className="mt-5 flex items-center gap-4">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
              <Icon className={cn('size-7', group.iconClassName)} />
            </span>
            <div>
              <h1 className="text-2xl font-medium tracking-normal">{group.title}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{group.description}</p>
            </div>
          </div>
        </header>
        <ToolAccessBlock items={group.childTools} onUpdated={onUpdated} />
      </main>
    </div>
  )
}

type SerperConnection = {
  id: string
  label: string
  status: 'connected' | 'disabled'
  priority: number
  lastTestedAt: string | null
  lastSucceededAt: string | null
  lastFailureAt: string | null
  lastFailureCode: string | null
  lastUsedAt: string | null
  successfulRequestCount: number
  creditsAtLastSync: number | null
  creditsSyncedAt: string | null
  observedRequestsSinceCreditSync: number
  estimatedCreditsRemaining?: number
  unavailableUntil: string | null
}
type SerperConnectionsResponse = { connections: SerperConnection[] }

function WebSearchPluginDetail({ group, onBack, onUpdated }: { group: NonNullable<ReturnType<typeof groupToolsForDetail>>; onBack: () => void; onUpdated: () => void }) {
  const Icon = group.Icon
  const [connections, setConnections] = useState<SerperConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [label, setLabel] = useState('Company Web Search')
  const [remainingCredits, setRemainingCredits] = useState('')
  const [creditDrafts, setCreditDrafts] = useState<Record<string, string>>({})
  const [verificationToken, setVerificationToken] = useState<string | null>(null)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await invoke<SerperConnectionsResponse>('divo_serper_connections')
      setConnections(result.connections ?? [])
    } catch (error) {
      toast.error('Could not load Web Search connections', { description: String(error) })
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  const test = async () => {
    if (!apiKey.trim()) return toast.error('Paste a Serper API key first')
    setBusy(true)
    try {
      const result = await invoke<{ verificationToken: string }>('divo_serper_test_connection', { apiKey, api_key: apiKey })
      setVerificationToken(result.verificationToken)
      toast.success('Connection verified', { description: 'This key can now be saved for the company.' })
    } catch (error) { setVerificationToken(null); toast.error('Serper test failed', { description: String(error) }) } finally { setBusy(false) }
  }
  const save = async () => {
    if (!verificationToken) return toast.error('Test this key successfully before saving it')
    const parsedCredits = remainingCredits.trim() === '' ? undefined : Number(remainingCredits)
    if (parsedCredits !== undefined && (!Number.isSafeInteger(parsedCredits) || parsedCredits < 0)) return toast.error('Remaining credits must be a non-negative whole number')
    setBusy(true)
    try {
      await invoke('divo_serper_save_connection', { label, apiKey, api_key: apiKey, verificationToken, verification_token: verificationToken, remainingCredits: parsedCredits, remaining_credits: parsedCredits })
      setApiKey(''); setRemainingCredits(''); setVerificationToken(null); await load(); toast.success('Company Web Search connection saved')
    } catch (error) { toast.error('Could not save connection', { description: String(error) }) } finally { setBusy(false) }
  }
  const toggle = async (connection: SerperConnection) => {
    setBusy(true)
    try { await invoke('divo_serper_set_connection_enabled', { connectionId: connection.id, connection_id: connection.id, enabled: connection.status !== 'connected' }); await load() }
    catch (error) { toast.error('Could not update connection', { description: String(error) }) } finally { setBusy(false) }
  }
  const remove = async (id: string) => {
    setBusy(true)
    try { await invoke('divo_serper_disconnect_connection', { connectionId: id, connection_id: id }); await load(); toast.success('Web Search connection disconnected') }
    catch (error) { toast.error('Could not disconnect connection', { description: String(error) }) } finally { setBusy(false) }
  }
  const saveRemainingCredits = async (connection: SerperConnection) => {
    const raw = creditDrafts[connection.id] ?? ''
    const value = Number(raw)
    if (!raw.trim() || !Number.isSafeInteger(value) || value < 0) return toast.error('Enter a non-negative whole number of remaining credits')
    setBusy(true)
    try {
      await invoke('divo_serper_set_remaining_credits', { connectionId: connection.id, connection_id: connection.id, remainingCredits: value, remaining_credits: value })
      await load()
      setCreditDrafts(drafts => ({ ...drafts, [connection.id]: '' }))
      toast.success('Estimated credit balance updated')
    } catch (error) { toast.error('Could not update credit balance', { description: String(error) }) } finally { setBusy(false) }
  }
  return <div className="min-h-full"><main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6 lg:px-8">
    <header className="rounded-lg border border-border/70 bg-card/30 p-5"><Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="size-4" />Back to Tools</Button><div className="mt-5 flex items-center gap-4"><span className="flex size-14 items-center justify-center rounded-lg border border-border/70 bg-muted/40"><Icon className="size-7" /></span><div><h1 className="text-2xl font-medium">Web Search</h1><p className="mt-2 text-sm text-muted-foreground">Company-authorised Serper connections. Divo uses the first healthy key, records its successful searches, and falls back when a key is rate-limited or rejected.</p></div></div></header>
    <section className="rounded-lg border border-border/70 p-5"><h2 className="text-lg font-medium">Add company connection</h2><p className="mt-1 text-sm text-muted-foreground">Only company admins can add keys. A live Serper test is required before the encrypted key can be saved; the test itself may use one Serper credit.</p><div className="mt-5 grid gap-3"><input value={label} onChange={e => setLabel(e.target.value)} placeholder="Connection label" className="h-10 rounded-md border border-border bg-background px-3 text-sm" /><input value={apiKey} onChange={e => { setApiKey(e.target.value); setVerificationToken(null) }} type="password" placeholder="Serper API key" className="h-10 rounded-md border border-border bg-background px-3 text-sm" /><input value={remainingCredits} onChange={e => setRemainingCredits(e.target.value)} inputMode="numeric" placeholder="Current Serper balance after test (optional)" className="h-10 rounded-md border border-border bg-background px-3 text-sm" /><p className="text-xs text-muted-foreground">Serper does not provide Divo a supported live-balance API. Copy the balance after testing from Serper’s dashboard; Divo then shows an estimate after subtracting searches it observes.</p><div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => void test()}>{verificationToken ? <Check className="size-4" /> : <KeyRound className="size-4" />}{verificationToken ? 'Verified' : 'Test key'}</Button><Button disabled={busy || !verificationToken} onClick={() => void save()}><Plus className="size-4" />Save connection</Button></div></div></section>
    <section className="rounded-lg border border-border/70 p-5"><div className="flex items-center justify-between"><div><h2 className="text-lg font-medium">Company connections</h2><p className="mt-1 text-sm text-muted-foreground">Keys remain encrypted on the backend. Usage is Divo-observed; estimated remaining credits begin from the balance you last copied from Serper.</p></div><Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}><RefreshCw className="size-4" />Refresh</Button></div><div className="mt-4 space-y-3">{connections.map((connection, index) => <div key={connection.id} className="flex flex-col gap-4 rounded-md border border-border/70 p-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 font-medium"><span className={cn('size-2 rounded-full', connection.status === 'connected' && !connection.unavailableUntil ? 'bg-emerald-400' : 'bg-muted-foreground')} />{connection.label}{index === 0 && connection.status === 'connected' ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">Default</span> : null}</div><p className="mt-1 text-xs text-muted-foreground">{connection.unavailableUntil ? `Temporarily skipped until ${new Date(connection.unavailableUntil).toLocaleString()}` : connection.lastFailureCode ? `Last issue: ${connection.lastFailureCode}` : connection.lastSucceededAt ? 'Validated and ready' : 'Not yet used'}</p><p className="mt-1 text-xs text-muted-foreground">Divo-observed successful searches: {connection.successfulRequestCount}</p>{connection.creditsAtLastSync !== null ? <p className="mt-1 text-xs text-muted-foreground">Estimated remaining: {connection.estimatedCreditsRemaining ?? 0} credits ({connection.observedRequestsSinceCreditSync} observed since the balance update)</p> : <p className="mt-1 text-xs text-muted-foreground">No Serper balance recorded yet.</p>}</div><div className="flex flex-wrap items-center gap-2"><input value={creditDrafts[connection.id] ?? ''} onChange={e => setCreditDrafts(drafts => ({ ...drafts, [connection.id]: e.target.value }))} inputMode="numeric" placeholder="Current credits" aria-label={`Current Serper credits for ${connection.label}`} className="h-8 w-36 rounded-md border border-border bg-background px-2 text-xs" /><Button size="sm" variant="outline" disabled={busy} onClick={() => void saveRemainingCredits(connection)}>Update balance</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void toggle(connection)}>{connection.status === 'connected' ? 'Disable' : 'Enable'}</Button><Button size="sm" variant="ghost" disabled={busy} className="text-destructive hover:text-destructive" onClick={() => void remove(connection.id)}><Trash2 className="size-4" />Disconnect</Button></div></div>)}{!loading && connections.length === 0 ? <p className="py-6 text-center text-sm text-muted-foreground">No company Web Search connection yet.</p> : null}</div></section>
    <ToolAccessBlock items={group.childTools} onUpdated={onUpdated} />
  </main></div>
}

function ZohoPluginDetail({
  plugin,
  onBack,
  onReconnectDivo,
  accessContent,
}: {
  plugin: NonNullable<ReturnType<typeof getPlugin>>
  onBack: () => void
  onReconnectDivo: () => void
  accessContent?: ReactNode
}) {
  const Icon = plugin.icon
  const [divoSession, setDivoSession] = useState<DivoSessionState>({ status: 'checking' })
  const [status, setStatus] = useState<ZohoStatusResponse['data'] | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manageConnection, setManageConnection] = useState<DivoConnection | null>(null)
  const [disconnectConnection, setDisconnectConnection] = useState<DivoConnection | null>(null)
  const [connectionActionId, setConnectionActionId] = useState<string | null>(null)
  const [connectDialogOpen, setConnectDialogOpen] = useState(false)
  const [connectMode, setConnectMode] = useState<'choose' | 'self_client'>('choose')
  const [selfClientLabel, setSelfClientLabel] = useState('')
  const [selfClientId, setSelfClientId] = useState('')
  const [selfClientSecret, setSelfClientSecret] = useState('')
  const [selfClientGrant, setSelfClientGrant] = useState('')
  const [selfClientAccountsUrl, setSelfClientAccountsUrl] = useState('https://accounts.zoho.in')

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

  const openZohoConnect = (connection?: DivoConnection) => {
    if (divoSession.status !== 'connected') {
      onReconnectDivo()
      return
    }
    setConnectMode('choose')
    setSelfClientLabel(connection?.label ?? '')
    setConnectDialogOpen(true)
  }

  const connectZohoOAuth = async () => {
    setIsBusy(true)
    try {
      const authorizeUrl = await invoke<string>('divo_zoho_authorize_url')
      await openExternalUrl(authorizeUrl)
      setConnectDialogOpen(false)
      toast.success('Zoho sign-in opened')
      setTimeout(() => void loadStatus(), 1500)
    } catch (connectError) {
      toast.error('Zoho connection failed', { description: String(connectError) })
    } finally {
      setIsBusy(false)
    }
  }

  const connectZohoSelfClient = async () => {
    setIsBusy(true)
    try {
      await invoke('divo_zoho_self_client_connect', {
        label: selfClientLabel.trim(),
        clientId: selfClientId.trim(),
        client_id: selfClientId.trim(),
        clientSecret: selfClientSecret.trim(),
        client_secret: selfClientSecret.trim(),
        grantToken: selfClientGrant.trim(),
        grant_token: selfClientGrant.trim(),
        accountsBaseUrl: selfClientAccountsUrl,
        accounts_base_url: selfClientAccountsUrl,
      })
      setConnectDialogOpen(false)
      setSelfClientSecret('')
      setSelfClientGrant('')
      toast.success('Read-only Zoho connection added')
      await loadStatus()
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

  const confirmDisconnectZoho = async () => {
    if (!disconnectConnection) return
    const connection = disconnectConnection
    setConnectionActionId(connection.id)
    try {
      await invoke('divo_zoho_disconnect_connection', {
        connectionId: connection.id,
        connection_id: connection.id,
      })
      setDisconnectConnection(null)
      toast.success('Zoho connection disconnected')
      await loadStatus()
    } catch (disconnectError) {
      toast.error('Could not disconnect Zoho', { description: String(disconnectError) })
    } finally {
      setConnectionActionId(null)
    }
  }

  const connections = (status?.connections ?? []).map(toZohoConnectionModel)
  const legacyConnection = status?.legacyConnection ?? null
  const connected = Boolean(status?.connected)
  const canManage = Boolean(status?.canManage)

  return (
    <div className="min-h-full">
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6 lg:px-8">
        <header className="flex flex-col gap-5 rounded-lg border border-border/70 bg-card/30 p-5">
          <div className="flex items-center justify-between gap-4">
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeft className="size-4" />
              Tools
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
                  {connections.length ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setManageConnection(connections[0] ?? null)}
                    >
                      Manage access
                    </Button>
                  ) : null}
                  {connected ? (
                    <Button variant="outline" size="sm" onClick={() => void disconnectZoho()} disabled={isBusy}>
                      Disconnect all
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => openZohoConnect()} disabled={isBusy}>
                    <KeyRound className="size-4" />
                    Add Zoho
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
                <Icon className={cn('size-7', plugin.iconClassName)} />
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
              <ConnectionRowsSkeleton rows={1} label="Checking Zoho" />
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
                  onReconnect={() => openZohoConnect(connection)}
                  onDisconnect={() => setDisconnectConnection(connection)}
                  canManage={canManage}
                  busy={connectionActionId === connection.id}
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
                    <Button size="sm" onClick={() => openZohoConnect()} disabled={isBusy}>
                      <KeyRound className="size-4" />
                      Reconnect Zoho
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
                    <Button size="sm" onClick={() => openZohoConnect()} disabled={isBusy}>
                      <KeyRound className="size-4" />
                      Connect Zoho
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
	        {accessContent}
	      </main>

      <Dialog
        open={connectDialogOpen}
        onOpenChange={(open) => {
          setConnectDialogOpen(open)
          if (!open) {
            setConnectMode('choose')
            setSelfClientSecret('')
            setSelfClientGrant('')
          }
        }}
      >
        <DialogContent className="max-h-[calc(100svh-64px)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add Zoho connection</DialogTitle>
            <DialogDescription>
              Use normal Zoho sign-in, or connect a read-only Self Client grant supplied by your Zoho admin.
            </DialogDescription>
          </DialogHeader>

          {connectMode === 'choose' ? (
            <div className="grid gap-3 py-2">
              <div className="rounded-lg border border-border/70 bg-card/30 p-4">
                <h3 className="text-sm font-medium">Zoho OAuth</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Open Zoho in your browser and approve the regular Divo connection.
                </p>
                <Button className="mt-3" size="sm" onClick={() => void connectZohoOAuth()} disabled={isBusy}>
                  <ExternalLink className="size-4" />
                  Continue with Zoho
                </Button>
              </div>
              <div className="rounded-lg border border-border/70 bg-card/30 p-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium">Self Client credentials</h3>
                  <Badge tone="amber">Divo read-only</Badge>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Paste a Client ID, Client Secret, and fresh short-lived grant token. Divo blocks write tools and keeps the connection alive with the encrypted refresh token.
                </p>
                <Button className="mt-3" variant="outline" size="sm" onClick={() => setConnectMode('self_client')}>
                  Enter credentials
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 py-2">
              <label className="grid gap-1.5 text-sm font-medium">
                Connection name <span className="text-xs font-normal text-muted-foreground">(optional)</span>
                <input className="h-9 rounded-md border border-border bg-background px-3 text-sm font-normal outline-none" value={selfClientLabel} maxLength={120} onChange={(event) => setSelfClientLabel(event.target.value)} placeholder="e.g. Finance read-only" />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Data centre
                <select className="h-9 rounded-md border border-border bg-background px-3 text-sm font-normal outline-none" value={selfClientAccountsUrl} onChange={(event) => setSelfClientAccountsUrl(event.target.value)}>
                  {zohoDataCentres.map(dataCentre => <option key={dataCentre.value} value={dataCentre.value}>{dataCentre.label}</option>)}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Client ID
                <input className="h-9 rounded-md border border-border bg-background px-3 text-sm font-normal outline-none" value={selfClientId} onChange={(event) => setSelfClientId(event.target.value)} autoComplete="off" />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Client Secret
                <input className="h-9 rounded-md border border-border bg-background px-3 text-sm font-normal outline-none" type="password" value={selfClientSecret} onChange={(event) => setSelfClientSecret(event.target.value)} autoComplete="new-password" />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Short-lived grant token
                <input className="h-9 rounded-md border border-border bg-background px-3 text-sm font-normal outline-none" type="password" value={selfClientGrant} onChange={(event) => setSelfClientGrant(event.target.value)} autoComplete="off" />
              </label>
              <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
                Any Zoho scopes are accepted, including full access. Divo still enforces read-only use for this connection. Submit the grant before its short expiry.
              </div>
            </div>
          )}

          <DialogFooter>
            {connectMode === 'self_client' ? (
              <Button variant="outline" onClick={() => setConnectMode('choose')} disabled={isBusy}>Back</Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() => {
                setConnectDialogOpen(false)
                setSelfClientSecret('')
                setSelfClientGrant('')
              }}
              disabled={isBusy}
            >
              Cancel
            </Button>
            {connectMode === 'self_client' ? (
              <Button
                onClick={() => void connectZohoSelfClient()}
                disabled={isBusy || !selfClientId.trim() || !selfClientSecret.trim() || !selfClientGrant.trim()}
              >
                <KeyRound className="size-4" />
                {isBusy ? 'Connecting...' : 'Connect read-only'}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConnectionManagementSheet
	        provider="zoho"
	        connection={manageConnection}
	        onOpenChange={(open) => {
	          if (!open) setManageConnection(null)
	        }}
	        onChanged={() => void loadStatus()}
	      />
	      <DisconnectConnectionDialog
	        providerLabel="Zoho"
	        connection={disconnectConnection}
	        busy={Boolean(disconnectConnection && connectionActionId === disconnectConnection.id)}
	        onConfirm={() => void confirmDisconnectZoho()}
	        onOpenChange={(open) => { if (!open) setDisconnectConnection(null) }}
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
  onReconnect,
  onDisconnect,
  canManage = false,
  busy = false,
}: {
  connection: DivoConnection
  onManage: () => void
  onReconnect: () => void
  onDisconnect: () => void
  canManage?: boolean
  busy?: boolean
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
          {connection.access === 'admin' || canManage ? (
            <>
            <Button variant="outline" size="sm" onClick={onReconnect} disabled={busy} aria-label={`Reconnect ${connection.label}`}>
              <RefreshCw className="size-4" />
              Reconnect
            </Button>
            <Button variant="outline" size="sm" onClick={onManage} disabled={busy} aria-label={`Manage ${connection.label}`}>
              Manage
            </Button>
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onDisconnect} disabled={busy} aria-label={`Disconnect ${connection.label}`}>
              <Trash2 className="size-4" />
              Disconnect
            </Button>
            </>
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

function DisconnectConnectionDialog({
  providerLabel,
  connection,
  busy,
  onConfirm,
  onOpenChange,
}: {
  providerLabel: string
  connection: DivoConnection | null
  busy: boolean
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={Boolean(connection)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect {providerLabel}?</DialogTitle>
          <DialogDescription>
            {connection
              ? `${connection.accountEmail} will stop being available to Divo. Other connected accounts are not affected.`
              : 'This connection will stop being available to Divo.'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? 'Disconnecting…' : 'Disconnect connection'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

function ConnectionManagementSheet({
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
  const [managerPolicy, setManagerPolicy] = useState<ConnectionGovernancePolicy>(defaultConnectionGovernancePolicy)
  const [selectedPerson, setSelectedPerson] = useState<ConnectionPerson | null>(null)
  const open = Boolean(connection)
  // Keyed by provider rather than chained ternaries: the previous chain ended
  // in a Google fallback, so a provider added without a branch here silently
  // managed access through Google's commands instead of its own.
  const PROVIDER_ACCESS: Record<ManageAccessProvider, { label: string; manage: string; grant: string; revoke: string }> = {
    zoho: { label: 'Zoho', manage: 'divo_zoho_manage_access', grant: 'divo_zoho_grant_access', revoke: 'divo_zoho_revoke_access' },
    canva: { label: 'Canva', manage: 'divo_canva_manage_access', grant: 'divo_canva_grant_access', revoke: 'divo_canva_revoke_access' },
    lark: { label: 'Lark', manage: 'divo_lark_manage_access', grant: 'divo_lark_grant_access', revoke: 'divo_lark_revoke_access' },
    airtable: { label: 'Airtable', manage: 'divo_airtable_manage_access', grant: 'divo_airtable_grant_access', revoke: 'divo_airtable_revoke_access' },
    google: { label: 'Google', manage: 'divo_google_manage_access', grant: 'divo_google_grant_access', revoke: 'divo_google_revoke_access' },
  }
  const providerAccess = PROVIDER_ACCESS[provider]
  const providerLabel = providerAccess.label
  const commandNames = { manage: providerAccess.manage, grant: providerAccess.grant, revoke: providerAccess.revoke }

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
      setManagerPolicy(response.data.governance.managerPolicy)
      setGranteeId('')
    } catch (loadError) {
      setError(String(loadError))
    } finally {
      setIsLoading(false)
    }
  }, [commandNames.manage, connection])

  useEffect(() => {
    if (connection) {
      setSelectedPerson(null)
      void loadManageData()
    } else {
      setData(null)
      setError(null)
      setQuery('')
      setGranteeType('user')
      setGranteeId('')
      setAccess('read_only')
      setManagerPolicy(defaultConnectionGovernancePolicy())
      setSelectedPerson(null)
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

  const updateActionPolicy = (action: ConnectionAction, update: Partial<ConnectionActionPolicy>) => {
    setManagerPolicy((current) => ({
      ...current,
      actions: {
        ...current.actions,
        [action]: {
          ...(current.actions[action] ?? { mode: 'inherit' }),
          ...update,
        },
      },
    }))
  }

  const saveOperatingControls = async () => {
    if (!connection) return
    setIsSaving(true)
    try {
      const response = await invoke<GoogleManageResponse>('divo_connection_update_governance', {
        connectionId: connection.id,
        connection_id: connection.id,
        managerPolicy,
        manager_policy: managerPolicy,
      })
      if (!response.success) throw new Error(response.message ?? 'Could not save operating controls')
      await loadManageData()
      toast.success('Operating controls saved')
    } catch (saveError) {
      toast.error('Could not save operating controls', { description: String(saveError) })
    } finally {
      setIsSaving(false)
    }
  }

  const closeSheet = () => {
    setSelectedPerson(null)
    onOpenChange(false)
  }

  const people = data ? getPeopleWithDirectConnectionAccess(data) : []

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => nextOpen ? onOpenChange(true) : closeSheet()}>
      <SheetContent
        resizable
        className="w-[min(42rem,50vw)] max-w-[50vw] gap-0 p-0"
      >
        <SheetHeader className="shrink-0 border-b border-border/70 pr-12">
          {selectedPerson ? (
            <>
              <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={() => setSelectedPerson(null)}>
                <ArrowLeft className="size-4" />
                People using this connection
              </Button>
              <SheetTitle>{selectedPerson.name}</SheetTitle>
              <SheetDescription>Access and safety rules for this connection only.</SheetDescription>
            </>
          ) : (
            <>
              <SheetTitle>Manage {providerLabel} access</SheetTitle>
              <SheetDescription>Manage this connection, its shared access, and its operating controls.</SheetDescription>
            </>
          )}
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {connection ? (
            <div className="min-w-0 space-y-4 p-4">
              {selectedPerson && data ? (
                <ConnectionPersonProfile person={selectedPerson} data={data} />
              ) : (
                <>
                  <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{connection.label}</p>
                        <p className="mt-1 truncate text-xs text-muted-foreground">{connection.accountEmail}</p>
                      </div>
                      <Badge tone={connection.access === 'admin' ? 'green' : 'amber'}>{formatAccessLabel(connection.access)}</Badge>
                    </div>
                  </div>

                  {isLoading ? <AccessScopeSkeleton /> : null}
                  {error ? <ConnectionListState title="Could not load access" description={error} action={<Button size="sm" onClick={() => void loadManageData()}>Retry</Button>} /> : null}

                  {data && !error ? (
                    <>
                      <ConnectionOperatingControls
                        governance={data.governance}
                        policy={managerPolicy}
                        isSaving={isSaving}
                        onPolicyChange={updateActionPolicy}
                        onSave={() => void saveOperatingControls()}
                      />

                      <ConnectionPeopleList people={people} onSelect={setSelectedPerson} />

                      <section className="rounded-lg border border-border/70 bg-card/30 p-4">
                        <h3 className="text-sm font-medium">Grant access</h3>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">Read-only maps to read tools. Read/write maps to send, create, update, and delete tools. Admin can manage sharing.</p>

                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                          <select className="h-9 rounded-md border border-border bg-background px-3 text-sm" value={granteeType} onChange={(event) => {
                            const nextType = event.target.value as GoogleManageGranteeType
                            setGranteeType(nextType)
                            setQuery('')
                            setGranteeId(nextType === 'company' ? data.candidates.company?.id ?? '' : '')
                          }}>
                            <option value="user">User</option>
                            <option value="department">Department</option>
                            <option value="role">Role</option>
                            <option value="company">Company</option>
                          </select>
                          <select className="h-9 rounded-md border border-border bg-background px-3 text-sm" value={access} onChange={(event) => setAccess(event.target.value as DivoConnectionAccess)}>
                            {data.accessLevels.map((level) => <option key={level.value} value={level.value}>{level.label}</option>)}
                          </select>
                        </div>

                        <div className="relative mt-3">
                          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
                          <input className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm outline-none" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${granteeType}`} disabled={granteeType === 'company'} />
                        </div>

                        <div className="mt-3 max-h-44 overflow-y-auto rounded-md border border-border/70">
                          {filteredCandidates.length ? filteredCandidates.map((candidate) => (
                            <button key={`${granteeType}:${candidate.id}`} type="button" className={cn('flex w-full items-center justify-between gap-3 border-b border-border/70 px-3 py-2 text-left last:border-b-0 hover:bg-muted/40', granteeId === candidate.id && 'bg-muted/50')} onClick={() => setGranteeId(candidate.id)}>
                              <span className="min-w-0"><span className="block truncate text-sm font-medium">{candidateLabel(candidate)}</span><span className="block truncate text-xs text-muted-foreground">{candidateDetail(candidate, granteeType)}</span></span>
                              {granteeId === candidate.id ? <Check className="size-4 shrink-0" /> : null}
                            </button>
                          )) : <p className="p-3 text-sm text-muted-foreground">No matches found.</p>}
                        </div>

                        <div className="mt-3 flex justify-end"><Button size="sm" onClick={() => void grantAccess()} disabled={isSaving || !granteeId}><ShieldCheck className="size-4" />Grant access</Button></div>
                      </section>

                      <section className="rounded-lg border border-border/70 bg-card/30 p-4">
                        <h3 className="text-sm font-medium">All access grants</h3>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">User, department, role, and company grants. Select a person above to inspect their direct connection access.</p>
                        <div className="mt-3 space-y-2">
                          {data.grants.length ? data.grants.map((grant) => (
                            <div key={grant.id} className="flex flex-col gap-3 rounded-md border border-border/70 bg-background/40 p-3 sm:flex-row sm:items-center sm:justify-between">
                              <div className="flex min-w-0 items-center gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/40"><GrantIcon type={grant.granteeType} /></span><div className="min-w-0"><p className="truncate text-sm font-medium">{grant.granteeLabel}</p><p className="truncate text-xs text-muted-foreground">{grant.granteeType} · {grant.granteeDetail ?? 'Direct grant'}</p></div></div>
                              <div className="flex items-center gap-2"><Badge tone={grant.access === 'admin' ? 'green' : grant.access === 'read_only' ? 'amber' : 'blue'}>{formatAccessLabel(grant.access)}</Badge><Button variant="ghost" size="icon" onClick={() => void revokeGrant(grant)} disabled={isSaving} aria-label={`Revoke access for ${grant.granteeLabel}`}><Trash2 className="size-4" /></Button></div>
                            </div>
                          )) : <p className="rounded-md border border-border/70 bg-background/40 p-3 text-sm text-muted-foreground">No shared grants yet.</p>}
                        </div>
                      </section>
                    </>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ConnectionOperatingControls({
  governance,
  policy,
  isSaving,
  onPolicyChange,
  onSave,
}: {
  governance: GoogleManageData['governance']
  policy: ConnectionGovernancePolicy
  isSaving: boolean
  onPolicyChange: (action: ConnectionAction, update: Partial<ConnectionActionPolicy>) => void
  onSave: () => void
}) {
  return (
    <section className="rounded-lg border border-border/70 bg-card/30 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-sm font-medium">Connection-wide controls</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Approval rules for everyone using this connection. They do not grant access, and company-admin overrides take precedence.
          </p>
        </div>
        {governance.adminOverride ? <Badge tone="amber">Company override active</Badge> : null}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {connectionActions.map(({ id, label }) => (
          <ConnectionActionControl
            key={id}
            action={id}
            label={label}
            policy={policy.actions[id] ?? { mode: 'inherit' }}
            isSaving={isSaving}
            onPolicyChange={onPolicyChange}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {governance.adminOverride
            ? 'Your baseline is saved, but the company-admin policy is currently effective.'
            : 'Leave an action at platform default to keep its existing behaviour.'}
        </p>
        <Button size="sm" onClick={onSave} disabled={isSaving}>{isSaving ? 'Saving…' : 'Save controls'}</Button>
      </div>
    </section>
  )
}

function ConnectionActionControl({
  action,
  label,
  policy,
  isSaving,
  onPolicyChange,
}: {
  action: ConnectionAction
  label: string
  policy: ConnectionActionPolicy
  isSaving: boolean
  onPolicyChange: (action: ConnectionAction, update: Partial<ConnectionActionPolicy>) => void
}) {
  const enforced = policy.mode === 'enforced'
  return (
    <div className="rounded-md border border-border/70 bg-background/40 p-3">
      <p className="text-sm font-medium">{label}</p>
      <label className="mt-3 grid gap-1 text-xs text-muted-foreground">
        Policy
        <select
          className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
          value={policy.mode}
          onChange={(event) => onPolicyChange(action, {
            mode: event.target.value as ConnectionActionPolicy['mode'],
            ...(event.target.value === 'enforced' && !policy.approval ? { approval: 'none' } : {}),
          })}
          disabled={isSaving}
        >
          <option value="inherit">Platform default</option>
          <option value="enforced">Control this action</option>
        </select>
      </label>
      {/*
        Per-minute and per-day caps are set centrally rather than here. Asking a
        manager to reason about request budgets per action, per connection, was
        six numbers of noise around the one control they actually use — whether
        the action needs approval. The stored values are untouched and the
        backend still enforces them.
      */}
      <label className="mt-3 grid gap-1 text-xs text-muted-foreground">
        Approval
        <select
          className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground disabled:opacity-50"
          value={policy.approval ?? 'none'}
          onChange={(event) => onPolicyChange(action, { approval: event.target.value as ConnectionApprovalMode })}
          disabled={!enforced || isSaving}
        >
          <option value="none">No extra approval</option>
          <option value="connection_owner">Connection owner on Lark</option>
          <option value="company_admin">Company admin on Lark</option>
        </select>
      </label>
    </div>
  )
}

function ConnectionPeopleList({ people, onSelect }: { people: ConnectionPerson[]; onSelect: (person: ConnectionPerson) => void }) {
  return (
    <section className="rounded-lg border border-border/70 bg-card/30 p-4">
      <div>
        <h3 className="text-sm font-medium">People using this connection</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          The owner and people with direct user grants. Department, role, and company grants remain in all access grants below.
        </p>
      </div>
      <div className="mt-3 divide-y divide-border/70 overflow-hidden rounded-md border border-border/70">
        {people.length ? people.map((person) => (
          <button key={person.userId} type="button" className="flex w-full items-center gap-3 bg-background/40 px-3 py-3 text-left hover:bg-muted/40" onClick={() => onSelect(person)}>
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">{initialsForPerson(person)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{person.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{person.email} · {person.source === 'owner' ? 'Connection owner' : 'Direct access'}</span>
            </span>
            <Badge tone={person.access === 'admin' ? 'green' : person.access === 'read_only' ? 'amber' : 'blue'}>{formatAccessLabel(person.access)}</Badge>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </button>
        )) : <p className="p-3 text-sm text-muted-foreground">No direct user access has been granted yet.</p>}
      </div>
    </section>
  )
}

function ConnectionPersonProfile({ person, data }: { person: ConnectionPerson; data: GoogleManageData }) {
  const actions = actionsForConnectionAccess(person.access)
  const policySource = data.governance.source === 'company_admin_override' ? 'Company admin override' : data.governance.source === 'manager_policy' ? 'Connection-wide manager policy' : 'Platform default'
  // Rate limits are deliberately absent. They are a platform concern the company
  // tunes centrally, and a per-action cap grid buried the one rule a manager can
  // actually act on. Approval survives, because "this needs sign-off first"
  // changes what a person should expect to happen; a shared throughput cap does
  // not. Only actions that genuinely require sign-off are listed, so the common
  // case collapses to a single reassuring line instead of a wall of "None".
  const approvalRules = connectionActions
    .filter(({ label }) => actions.includes(label))
    .map(({ id, label }) => ({
      label,
      approval: formatConnectionApproval(effectiveConnectionActionPolicy(data.governance, id).policy),
    }))
    .filter(({ approval }) => approval !== NO_EXTRA_APPROVAL)
  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border/70 bg-card/30 p-4">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted font-medium">{initialsForPerson(person)}</span>
          <div className="min-w-0">
            <h3 className="truncate text-base font-medium">{person.name}</h3>
            <p className="mt-1 truncate text-sm text-muted-foreground">{person.email}</p>
            {person.companyRole ? <p className="mt-1 text-xs text-muted-foreground">Company role: {person.companyRole}</p> : null}
          </div>
        </div>
      </section>
      <section className="rounded-lg border border-border/70 bg-card/30 p-4">
        <h3 className="text-sm font-medium">Current connection access</h3>
        <p className="mt-1 text-sm text-muted-foreground">{person.source === 'owner' ? 'Connection owner' : 'Direct user grant'} · {formatAccessLabel(person.access)}</p>
        <div className="mt-3 flex flex-wrap gap-2">{actions.map((action) => <Badge key={action} tone="blue">{action}</Badge>)}</div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">This describes the connection grant. Divo still enforces company and department RBAC before any tool runs.</p>
      </section>
      <section className="rounded-lg border border-border/70 bg-card/30 p-4">
        <h3 className="text-sm font-medium">Safety rules this person inherits</h3>
        <dl className="mt-3 grid gap-3 text-sm">
          <div><dt className="text-xs text-muted-foreground">Policy source</dt><dd className="mt-1">{policySource}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Individual override</dt><dd className="mt-1">None — connection-wide rules apply.</dd></div>
          {/*
            Department approval is owned by "Ask a manager first" on this page
            and is not repeated here. This row is a different gate — a policy on
            the connection itself — and it appears only when someone has actually
            enforced one. Left always-on it would read as a duplicate of the
            control above; removed entirely it would become an invisible pause,
            with a manager switching department approval off and still being
            stopped by a rule nothing on screen mentions.
          */}
          {approvalRules.length > 0 ? (
            <div>
              <dt className="text-xs text-muted-foreground">This connection also requires approval</dt>
              <dd className="mt-1">
                <ul className="space-y-1">
                  {approvalRules.map(({ label, approval }) => (
                    <li key={label}>{label} — {approval.toLowerCase()}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  Set on the connection, separately from the department rules in “Ask a manager first”.
                </p>
              </dd>
            </div>
          ) : null}
        </dl>
      </section>
    </div>
  )
}

function effectiveConnectionActionPolicy(
  governance: GoogleManageData['governance'],
  action: ConnectionAction,
): { source: 'Company admin override' | 'Manager policy' | 'Platform default'; policy: ConnectionActionPolicy | null } {
  const adminPolicy = governance.adminOverride?.actions[action]
  if (adminPolicy?.mode === 'enforced') return { source: 'Company admin override', policy: adminPolicy }
  const managerPolicy = governance.managerPolicy.actions[action]
  if (managerPolicy?.mode === 'enforced') return { source: 'Manager policy', policy: managerPolicy }
  return { source: 'Platform default', policy: null }
}

/** The one approval verdict that means "nothing to say", so it is filtered out. */
const NO_EXTRA_APPROVAL = 'No extra approval'

function formatConnectionApproval(policy: ConnectionActionPolicy | null): string {
  if (!policy || policy.approval === 'none' || !policy.approval) return NO_EXTRA_APPROVAL
  return policy.approval === 'connection_owner' ? 'Connection owner on Lark' : 'Company admin on Lark'
}

function getPeopleWithDirectConnectionAccess(data: GoogleManageData): ConnectionPerson[] {
  const people = new Map<string, ConnectionPerson>()
  const usersById = new Map(data.candidates.users.map((user) => [user.id, user]))
  const owner = data.connection.ownerUser
  if (owner) {
    const candidate = usersById.get(owner.id)
    people.set(owner.id, {
      userId: owner.id,
      name: owner.name ?? owner.email,
      email: owner.email,
      companyRole: candidate?.role ?? null,
      access: 'admin',
      source: 'owner',
      grant: null,
    })
  }

  for (const grant of data.grants) {
    if (grant.granteeType !== 'user' || people.has(grant.granteeId)) continue
    const candidate = usersById.get(grant.granteeId)
    people.set(grant.granteeId, {
      userId: grant.granteeId,
      name: candidate?.name ?? grant.granteeLabel,
      email: candidate?.email ?? grant.granteeDetail ?? 'No email available',
      companyRole: candidate?.role ?? null,
      access: grant.access,
      source: 'direct_grant',
      grant,
    })
  }

  return [...people.values()]
}

function actionsForConnectionAccess(access: DivoConnectionAccess): string[] {
  if (access === 'read_only') return ['Read']
  if (access === 'read_write') return ['Read', 'Create', 'Update', 'Delete', 'Send']
  return ['Read', 'Create', 'Update', 'Delete', 'Send', 'Execute', 'Manage sharing']
}

function initialsForPerson(person: Pick<ConnectionPerson, 'name' | 'email'>): string {
  const initials = person.name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('')
  return initials || person.email.slice(0, 1).toUpperCase()
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
  provider,
  divoSession,
  onConnected,
  onReconnect,
  onOpenChange,
}: {
  open: boolean
  provider: CloudProviderConfig
  divoSession: DivoSessionState
  onConnected: () => void | Promise<void>
  onReconnect: () => void
  onOpenChange: (open: boolean) => void
}) {
  const [isStartingOAuth, setIsStartingOAuth] = useState(false)
  const [isSavingPat, setIsSavingPat] = useState(false)
  const [connectMode, setConnectMode] = useState<'choose' | 'pat'>('choose')
  const [connectionLabel, setConnectionLabel] = useState('')
  const [personalAccessToken, setPersonalAccessToken] = useState('')
  const [patAccessMode, setPatAccessMode] = useState<'read_only' | 'read_write'>('read_write')

  const closeDialog = () => {
    setConnectMode('choose')
    setPersonalAccessToken('')
    onOpenChange(false)
  }

  const handleContinue = async () => {
    if (divoSession.status !== 'connected') {
      toast.error('Connect Divo first', {
        description: `${provider.label} connections are stored and authorized through the Divo backend.`,
      })
      onReconnect()
      return
    }

    setIsStartingOAuth(true)
    console.debug('[DivoPlugins] cloud_oauth.start', { provider: provider.provider })
    try {
      const authorizeUrl = provider.supportsLabel
        ? await invoke<string>(provider.commands.authorize, { label: connectionLabel.trim() || provider.accountFallback })
        : await invoke<string>(provider.commands.authorize)
      console.debug('[DivoPlugins] cloud_oauth.authorize_url_received', {
        provider: provider.provider,
        hasUrl: Boolean(authorizeUrl),
      })
      await openExternalUrl(authorizeUrl)
      console.debug('[DivoPlugins] cloud_oauth.browser_opened', { provider: provider.provider })
      toast.success(`${provider.label} sign-in opened`)
      closeDialog()
      setTimeout(() => void onConnected(), 1500)
    } catch (error) {
      console.error('[DivoPlugins] cloud_oauth.failed', { provider: provider.provider, error })
      if (isDivoAuthError(error)) {
        toast.error('Reconnect Divo to continue', {
          description: `Your desktop session expired before ${provider.label} OAuth could start.`,
        })
        onOpenChange(false)
        onReconnect()
        return
      }
      toast.error(`${provider.label} connection failed`, {
        description: String(error),
      })
    } finally {
      setIsStartingOAuth(false)
    }
  }

  const handlePatConnect = async () => {
    if (divoSession.status !== 'connected') {
      onReconnect()
      return
    }
    if (!provider.commands.patConnect || !personalAccessToken.trim()) return

    setIsSavingPat(true)
    try {
      const response = await invoke<{ data?: { warning?: string } }>(provider.commands.patConnect, {
        label: connectionLabel.trim() || provider.accountFallback,
        personalAccessToken: personalAccessToken.trim(),
        personal_access_token: personalAccessToken.trim(),
        accessMode: patAccessMode,
        access_mode: patAccessMode,
      })
      toast.success('Airtable connection added', {
        description: response.data?.warning,
      })
      closeDialog()
      await onConnected()
    } catch (error) {
      if (isDivoAuthError(error)) {
        toast.error('Reconnect Divo to continue')
        closeDialog()
        onReconnect()
        return
      }
      toast.error('Airtable connection failed', { description: String(error) })
    } finally {
      setIsSavingPat(false)
    }
  }

  const isAirtable = provider.provider === 'airtable'

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setConnectMode('choose')
          setPersonalAccessToken('')
        }
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="max-h-[calc(100svh-64px)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add {provider.label} connection</DialogTitle>
          <DialogDescription>
            {isAirtable
              ? 'Use Airtable OAuth, or add an admin-owned personal access token from Builder Hub.'
              : 'OAuth will be handled by Divo backend. This UI is ready for personal accounts and admin-shared company accounts.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          {divoSession.status !== 'connected' ? (
            <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3">
              <div className="flex gap-2">
                <Lock className="mt-0.5 size-4 shrink-0 text-amber-300" />
                <p className="text-xs leading-5 text-amber-100">
                  Connect Divo before adding {provider.label}. The backend needs
                  your Divo company session to save and authorize this connection.
                </p>
              </div>
            </div>
          ) : null}
          {provider.supportsLabel ? (
            <label className="grid gap-1.5 text-sm font-medium">
              Connection name
              <input
                className="h-9 rounded-md border border-border bg-background px-3 text-sm font-normal outline-none"
                value={connectionLabel}
                maxLength={120}
                onChange={(event) => setConnectionLabel(event.target.value)}
                placeholder="e.g. Brand team or Marketing workspace"
              />
              <span className="text-xs font-normal leading-5 text-muted-foreground">Use a name your team will recognize when selecting or sharing this connection.</span>
            </label>
          ) : null}

          {isAirtable && connectMode === 'choose' ? (
            <>
              <div className="rounded-lg border border-border/70 bg-card/30 p-4">
                <h3 className="text-sm font-medium">Airtable OAuth</h3>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Open Airtable in your browser and approve the regular Divo connection.
                </p>
                <Button className="mt-3" size="sm" onClick={() => void handleContinue()} disabled={isStartingOAuth}>
                  <ExternalLink className="size-4" />
                  {isStartingOAuth ? 'Opening Airtable...' : 'Continue with Airtable'}
                </Button>
              </div>
              <div className="rounded-lg border border-border/70 bg-card/30 p-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-medium">Personal access token</h3>
                  <Badge tone="amber">Company admin</Badge>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Paste a PAT created in Airtable Builder Hub. Divo verifies its identity before encrypted backend storage.
                </p>
                <Button className="mt-3" variant="outline" size="sm" onClick={() => setConnectMode('pat')}>
                  Enter token
                </Button>
              </div>
            </>
          ) : isAirtable ? (
            <>
              <label className="grid gap-1.5 text-sm font-medium">
                Access included in this token
                <select
                  className="h-9 rounded-md border border-border bg-background px-3 text-sm font-normal outline-none"
                  value={patAccessMode}
                  onChange={(event) => setPatAccessMode(event.target.value as 'read_only' | 'read_write')}
                >
                  <option value="read_only">Read-only</option>
                  <option value="read_write">Read and write</option>
                </select>
                <span className="text-xs font-normal leading-5 text-muted-foreground">
                  Match what you selected in Airtable. Airtable exposes PAT identity, but only OAuth tokens reveal their scopes.
                </span>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Personal access token
                <input
                  className="h-9 rounded-md border border-border bg-background px-3 text-sm font-normal outline-none"
                  type="password"
                  value={personalAccessToken}
                  onChange={(event) => setPersonalAccessToken(event.target.value)}
                  autoComplete="off"
                  autoFocus
                  placeholder="pat..."
                />
              </label>
              <p className="text-xs leading-5 text-muted-foreground">
                Give the token access only to the bases and scopes Divo should use. The token is sent once to the Divo backend and is never shown again.
              </p>
            </>
          ) : (
            <ConnectionOption
              icon={User}
              title="Connect account"
              description={`OAuth creates a backend-owned ${provider.label} connection with admin access for you.`}
            />
          )}
          <ConnectionOption
            icon={Users}
            title="Share after connect"
            description={`After ${isAirtable ? 'connecting' : 'OAuth'}, use Manage to grant users, departments, roles, or the company access.`}
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
          <Button variant="outline" onClick={closeDialog}>
            Cancel
          </Button>
          {isAirtable && connectMode === 'pat' ? (
            <>
              <Button variant="outline" onClick={() => setConnectMode('choose')} disabled={isSavingPat}>
                Back
              </Button>
              <Button
                onClick={() => void handlePatConnect()}
                disabled={isSavingPat || !personalAccessToken.trim()}
              >
                <KeyRound className="size-4" />
                {isSavingPat ? 'Verifying token...' : 'Add with token'}
              </Button>
            </>
          ) : !isAirtable ? (
            <Button onClick={() => void handleContinue()} disabled={isStartingOAuth}>
              <KeyRound className="size-4" />
              {divoSession.status !== 'connected'
                ? 'Connect Divo first'
                : isStartingOAuth
                  ? `Opening ${provider.label}...`
                  : `Continue with ${provider.label}`}
              <ExternalLink className="size-4" />
            </Button>
          ) : null}
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
