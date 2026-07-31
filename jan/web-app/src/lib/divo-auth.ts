import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

export const DEFAULT_DIVO_BACKEND_URL = 'http://localhost:8000'
export const DIVO_BACKEND_URL_STORAGE_KEY = 'divo.backendUrl'

const AUTH_POLL_INTERVAL_MS = 1500
const AUTH_POLL_TIMEOUT_MS = 5 * 60 * 1000

export class DivoAuthCancelledError extends Error {
  constructor(message = 'Sign-in cancelled') {
    super(message)
    this.name = 'DivoAuthCancelledError'
  }
}

export function isDivoAuthCancelled(error: unknown): boolean {
  return (
    error instanceof DivoAuthCancelledError ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

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
  avatarUrl?: string
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
      avatarUrl?: string | null
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

export async function validateDivoSession(): Promise<DivoSessionStatus> {
  const status = await invoke<DivoSessionStatus>('divo_validate_session')
  return normalizeDivoSessionStatus(status)
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    const body = (await response.json().catch(() => null)) as T | null
    if (!response.ok) {
      const message =
        body && typeof body === 'object' && 'message' in body
          ? String((body as { message?: unknown }).message)
          : `HTTP ${response.status}`
      throw new Error(message)
    }
    if (!body) throw new Error('Backend returned an empty response')
    return body
  } catch (error) {
    if (isDivoAuthCancelled(error) || init?.signal?.aborted) {
      throw new DivoAuthCancelledError()
    }
    throw error
  }
}

async function openAuthorizeUrl(url: string): Promise<void> {
  if (IS_TAURI) {
    await openUrl(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DivoAuthCancelledError())
      return
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(new DivoAuthCancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function pollForLarkCallback(
  backendUrl: string,
  nonce: string,
  signal?: AbortSignal,
): Promise<{ code: string; state: string }> {
  const deadline = Date.now() + AUTH_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DivoAuthCancelledError()
    await sleep(AUTH_POLL_INTERVAL_MS, signal)
    const body = await fetchJson<DesktopPollResponse>(
      `${backendUrl}/api/desktop/auth/lark/poll?nonce=${encodeURIComponent(nonce)}`,
      { signal },
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

export type SignInDivoOptions = {
  signal?: AbortSignal
}

export async function signInDivoWithLark(
  backendUrl: string,
  options?: SignInDivoOptions,
): Promise<DivoSessionStatus> {
  const signal = options?.signal
  if (signal?.aborted) throw new DivoAuthCancelledError()

  const normalizedBackendUrl = normalizeDivoBackendUrl(backendUrl)
  storeDivoBackendUrl(normalizedBackendUrl)

  const authorize = await fetchJson<DesktopAuthorizeUrlResponse>(
    `${normalizedBackendUrl}/api/desktop/auth/lark/authorize-url`,
    { signal },
  )
  if (!authorize.success || !authorize.data?.authorizeUrl || !authorize.data.nonce) {
    throw new Error(authorize.message ?? 'Failed to start Lark sign-in')
  }

  if (signal?.aborted) throw new DivoAuthCancelledError()
  await openAuthorizeUrl(authorize.data.authorizeUrl)
  const callback = await pollForLarkCallback(
    normalizedBackendUrl,
    authorize.data.nonce,
    signal,
  )
  const exchanged = await fetchJson<DesktopExchangeResponse>(
    `${normalizedBackendUrl}/api/desktop/auth/lark/exchange`,
    {
      method: 'POST',
      body: JSON.stringify(callback),
      signal,
    },
  )

  if (!exchanged.success || !exchanged.data?.token) {
    throw new Error(exchanged.message ?? 'Failed to exchange Lark session')
  }

  if (signal?.aborted) throw new DivoAuthCancelledError()

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
    avatarUrl: session.avatarUrl ?? undefined,
    departments,
  }).then(normalizeDivoSessionStatus)
}
