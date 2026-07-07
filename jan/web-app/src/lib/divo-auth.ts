import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

export const DEFAULT_DIVO_BACKEND_URL = 'http://localhost:8000'
export const DIVO_BACKEND_URL_STORAGE_KEY = 'divo.backendUrl'

const AUTH_POLL_INTERVAL_MS = 1500
const AUTH_POLL_TIMEOUT_MS = 5 * 60 * 1000

export type DivoDepartment = {
  id: string
  name: string
}

export type DivoSessionStatus = {
  configured: boolean
  backendUrl?: string
  departmentId?: string
  email?: string
  name?: string
  userId?: string
  companyId?: string
  role?: string
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

export function normalizeDivoBackendUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_DIVO_BACKEND_URL
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return new URL(withProtocol).toString().replace(/\/+$/, '')
}

export function getStoredDivoBackendUrl(): string {
  return localStorage.getItem(DIVO_BACKEND_URL_STORAGE_KEY) ?? DEFAULT_DIVO_BACKEND_URL
}

export function storeDivoBackendUrl(backendUrl: string): void {
  localStorage.setItem(DIVO_BACKEND_URL_STORAGE_KEY, backendUrl)
}

export function normalizeDivoSessionStatus(status: DivoSessionStatus): DivoSessionStatus {
  return { ...status, departments: status.departments ?? [] }
}

export async function getDivoSessionStatus(): Promise<DivoSessionStatus> {
  const status = await invoke<DivoSessionStatus>('divo_get_session_status')
  return normalizeDivoSessionStatus(status)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
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

export async function signInDivoWithLark(backendUrl: string): Promise<DivoSessionStatus> {
  const normalizedBackendUrl = normalizeDivoBackendUrl(backendUrl)
  storeDivoBackendUrl(normalizedBackendUrl)

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

  return invoke<DivoSessionStatus>('divo_set_session', {
    backendUrl: normalizedBackendUrl,
    memberToken: exchanged.data.token,
    departmentId,
    email: session.email,
    name: session.name,
    userId: session.userId,
    companyId: session.companyId,
    role: session.role,
    expiresAt: session.expiresAt,
    departments,
  }).then(normalizeDivoSessionStatus)
}
