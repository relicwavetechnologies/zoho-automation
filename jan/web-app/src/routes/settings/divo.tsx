import { createFileRoute } from '@tanstack/react-router'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { IconExternalLink, IconRefresh, IconTrash } from '@tabler/icons-react'

import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { Card, CardItem } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const DEFAULT_BACKEND_URL = 'http://localhost:3000'
const BACKEND_URL_STORAGE_KEY = 'divo.backendUrl'
const AUTH_POLL_INTERVAL_MS = 1500
const AUTH_POLL_TIMEOUT_MS = 5 * 60 * 1000

type DivoDepartment = {
  id: string
  name: string
}

type DivoSessionStatus = {
  configured: boolean
  backendUrl?: string
  departmentId?: string
  email?: string
  name?: string
  userId?: string
  companyId?: string
  expiresAt?: string
  departments: DivoDepartment[]
}

type DesktopAuthorizeUrlResponse = {
  success: boolean
  message?: string
  data?: {
    authorizeUrl: string
    nonce: string
  }
}

type DesktopPollResponse = {
  success: boolean
  pending?: boolean
  message?: string
  data?: {
    code: string
    state: string
  }
}

type DesktopExchangeResponse = {
  success: boolean
  message?: string
  data?: {
    token: string
    session: {
      userId: string
      companyId: string
      role: string
      expiresAt: string
      email?: string
      name?: string
      departments?: DivoDepartment[]
    }
  }
}

export const Route = createFileRoute(route.settings.divo as any)({
  component: DivoSettings,
})

function normalizeBackendUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_BACKEND_URL
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return new URL(withProtocol).toString().replace(/\/+$/, '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function normalizeStatus(status: DivoSessionStatus): DivoSessionStatus {
  return { ...status, departments: status.departments ?? [] }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const body = await response.json().catch(() => null) as T | null
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'message' in body
      ? String((body as { message?: unknown }).message)
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  if (!body) throw new Error('Backend returned an empty response')
  return body
}

async function openAuthorizeUrl(url: string): Promise<void> {
  if (IS_TAURI) {
    await openUrl(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function pollForLarkCallback(
  backendUrl: string,
  nonce: string,
): Promise<{ code: string; state: string }> {
  const deadline = Date.now() + AUTH_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(AUTH_POLL_INTERVAL_MS)
    const body = await fetchJson<DesktopPollResponse>(
      `${backendUrl}/api/desktop/auth/lark/poll?nonce=${encodeURIComponent(nonce)}`,
    )
    if (body.success && body.data?.code && body.data.state) {
      return body.data
    }
    if (!body.pending && body.message) {
      throw new Error(body.message)
    }
  }
  throw new Error('Lark sign-in timed out')
}

function DivoSettings() {
  const [backendUrl, setBackendUrl] = useState(() =>
    localStorage.getItem(BACKEND_URL_STORAGE_KEY) ?? DEFAULT_BACKEND_URL
  )
  const [status, setStatus] = useState<DivoSessionStatus>({
    configured: false,
    departments: [],
  })
  const [isLoadingStatus, setIsLoadingStatus] = useState(true)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const [isChangingDepartment, setIsChangingDepartment] = useState(false)

  const refreshStatus = async () => {
    setIsLoadingStatus(true)
    try {
      const next = await invoke<DivoSessionStatus>('divo_get_session_status')
      setStatus(normalizeStatus(next))
      if (next.backendUrl) {
        setBackendUrl(next.backendUrl)
        localStorage.setItem(BACKEND_URL_STORAGE_KEY, next.backendUrl)
      }
    } catch (error) {
      toast.error('Failed to read Divo session', { description: String(error) })
    } finally {
      setIsLoadingStatus(false)
    }
  }

  useEffect(() => {
    void refreshStatus()
  }, [])

  const handleConnect = async () => {
    setIsConnecting(true)
    try {
      const normalizedBackendUrl = normalizeBackendUrl(backendUrl)
      setBackendUrl(normalizedBackendUrl)
      localStorage.setItem(BACKEND_URL_STORAGE_KEY, normalizedBackendUrl)

      const authorize = await fetchJson<DesktopAuthorizeUrlResponse>(
        `${normalizedBackendUrl}/api/desktop/auth/lark/authorize-url`,
      )
      if (!authorize.success || !authorize.data?.authorizeUrl || !authorize.data.nonce) {
        throw new Error(authorize.message ?? 'Failed to start Lark sign-in')
      }

      await openAuthorizeUrl(authorize.data.authorizeUrl)
      const callback = await pollForLarkCallback(normalizedBackendUrl, authorize.data.nonce)
      const exchanged = await fetchJson<DesktopExchangeResponse>(
        `${normalizedBackendUrl}/api/desktop/auth/lark/exchange`,
        {
          method: 'POST',
          body: JSON.stringify(callback),
        },
      )

      if (!exchanged.success || !exchanged.data?.token) {
        throw new Error(exchanged.message ?? 'Failed to exchange Lark session')
      }

      const session = exchanged.data.session
      const departments = session.departments ?? []
      const departmentId = departments[0]?.id

      const next = await invoke<DivoSessionStatus>('divo_set_session', {
        backendUrl: normalizedBackendUrl,
        memberToken: exchanged.data.token,
        departmentId,
        email: session.email,
        name: session.name,
        userId: session.userId,
        companyId: session.companyId,
        expiresAt: session.expiresAt,
        departments,
      })
      setStatus(normalizeStatus(next))
      toast.success('Divo connected')
    } catch (error) {
      toast.error('Divo connection failed', { description: String(error) })
    } finally {
      setIsConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    setIsDisconnecting(true)
    try {
      await invoke('divo_clear_session')
      setStatus({ configured: false, departments: [] })
      toast.success('Divo disconnected')
    } catch (error) {
      toast.error('Failed to disconnect Divo', { description: String(error) })
    } finally {
      setIsDisconnecting(false)
    }
  }

  const handleDepartmentChange = async (departmentId: string) => {
    setIsChangingDepartment(true)
    try {
      const next = await invoke<DivoSessionStatus>('divo_set_department', {
        departmentId: departmentId || null,
      })
      setStatus(normalizeStatus(next))
      toast.success('Divo department updated')
    } catch (error) {
      toast.error('Failed to update department', { description: String(error) })
    } finally {
      setIsChangingDepartment(false)
    }
  }

  const selectedDepartmentName =
    status.departments.find((dept) => dept.id === status.departmentId)?.name ??
    status.departmentId

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className={cn("flex items-center justify-between w-full mr-2 pr-3", !IS_MACOS && "pr-30")}>
          <span className="font-medium text-base font-studio">Divo</span>
          <Button
            variant="outline"
            size="sm"
            onClick={refreshStatus}
            disabled={isLoadingStatus || isConnecting}
            className="relative z-50"
          >
            <IconRefresh size={14} />
            Refresh
          </Button>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">
            <Card title="Connection">
              <CardItem
                title="Backend URL"
                description="The Divo backend used for company auth and gateway calls."
                align="start"
                actions={
                  <Input
                    value={backendUrl}
                    onChange={(event) => setBackendUrl(event.target.value)}
                    placeholder={DEFAULT_BACKEND_URL}
                    disabled={isConnecting}
                    className="w-80"
                  />
                }
              />
              <CardItem
                title="Status"
                description={
                  status.configured
                    ? `Connected${status.email ? ` as ${status.email}` : ''}`
                    : 'Not connected'
                }
                actions={
                  status.configured ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDisconnect}
                      disabled={isDisconnecting}
                    >
                      <IconTrash size={14} />
                      {isDisconnecting ? 'Disconnecting' : 'Disconnect'}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleConnect}
                      disabled={isConnecting}
                    >
                      <IconExternalLink size={14} />
                      {isConnecting ? 'Waiting for Lark' : 'Connect with Lark'}
                    </Button>
                  )
                }
              />
            </Card>

            {status.configured && (
              <Card title="Session">
                <CardItem
                  title="User"
                  description={status.name ?? status.email ?? status.userId ?? 'Signed in'}
                />
                <CardItem
                  title="Company"
                  description={status.companyId ?? 'Unknown'}
                />
                <CardItem
                  title="Department"
                  description={selectedDepartmentName ?? 'No default department'}
                  actions={
                    status.departments.length > 0 ? (
                      <select
                        value={status.departmentId ?? ''}
                        disabled={isChangingDepartment}
                        onChange={(event) => handleDepartmentChange(event.target.value)}
                        className="h-8 w-56 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                      >
                        <option value="">No default</option>
                        {status.departments.map((department) => (
                          <option key={department.id} value={department.id}>
                            {department.name}
                          </option>
                        ))}
                      </select>
                    ) : undefined
                  }
                />
                <CardItem
                  title="Expires"
                  description={
                    status.expiresAt
                      ? new Date(status.expiresAt).toLocaleString()
                      : 'Unknown'
                  }
                />
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
