import { API_BASE } from './config';

export interface ApiSession {
  token: string;
  user: ApiUser;
}

export interface ApiDepartment {
  id: string;
  name: string;
}

export interface ApiUser {
  id: string;
  name: string;
  email: string;
  role?: string;
  department?: string;
  departments?: ApiDepartment[];
  companyId?: string;
  avatarUrl?: string | null;
}

export interface ApiError {
  code: string;
  message: string;
}

export interface ApiResult<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        success: false,
        error: {
          code: body?.error?.code ?? `HTTP_${res.status}`,
          message: body?.error?.message ?? res.statusText,
        },
      };
    }
    return body as ApiResult<T>;
  } catch (err) {
    return {
      success: false,
      error: { code: 'NETWORK', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

type DesktopUserPayload = Partial<ApiUser> & {
  userId?: string;
  name?: string | null;
  email?: string | null;
  larkName?: string | null;
  larkEmail?: string | null;
};

type DesktopSessionPayload = {
  token: string;
  user?: DesktopUserPayload;
  session?: DesktopUserPayload;
};

function normalizeUserPayload(payload: DesktopUserPayload): ApiUser {
  const departments = payload.departments ?? [];
  const email = payload.email ?? payload.larkEmail ?? '';
  const name = payload.name ?? payload.larkName ?? (email || 'User');

  return {
    id: payload.id ?? payload.userId ?? '',
    name,
    email,
    role: payload.role,
    department: payload.department ?? departments[0]?.name,
    departments,
    companyId: payload.companyId,
    avatarUrl: payload.avatarUrl ?? null,
  };
}

function normalizeSessionPayload(payload: DesktopSessionPayload): ApiSession {
  return {
    token: payload.token,
    user: normalizeUserPayload(payload.user ?? payload.session ?? {}),
  };
}

/**
 * Lark OAuth — step 1: ask backend for an authorize URL we can open in the
 * user's default browser. Backend route is GET.
 */
export function getLarkAuthorizeUrl(): Promise<
  ApiResult<{ authorizeUrl: string; nonce: string; redirectUri: string }>
> {
  return request('/api/desktop/auth/lark/authorize-url');
}

/**
 * Lark OAuth — step 2: poll for the deep-link callback. Backend stores the
 * code/state keyed by nonce until exchange.
 */
export function pollLarkCallback(
  nonce: string,
): Promise<ApiResult<{ code: string; state: string } | null>> {
  return request(`/api/desktop/auth/lark/poll?nonce=${encodeURIComponent(nonce)}`);
}

/**
 * Lark OAuth — step 3: exchange code → session JWT.
 */
export function exchangeLarkCode(payload: {
  code: string;
  state: string;
}): Promise<ApiResult<ApiSession>> {
  return request<DesktopSessionPayload>('/api/desktop/auth/lark/exchange', {
    method: 'POST',
    body: JSON.stringify(payload),
  }).then((result) => {
    if (!result.success || !result.data) return result as ApiResult<ApiSession>;
    return { ...result, data: normalizeSessionPayload(result.data) };
  });
}

/**
 * Fetch the current authenticated user.
 */
export function fetchMe(token: string): Promise<ApiResult<ApiUser>> {
  return request<DesktopUserPayload>('/api/desktop/auth/me', { method: 'GET' }, token).then((result) => {
    if (!result.success || !result.data) return result as ApiResult<ApiUser>;
    return { ...result, data: normalizeUserPayload(result.data) };
  });
}

/**
 * Logout (best-effort — also clear local state).
 */
export function logout(token: string): Promise<ApiResult<void>> {
  return request('/api/desktop/auth/logout', { method: 'POST' }, token);
}

/**
 * Thread CRUD.
 */
export interface DesktopWorkspace {
  id: string;
  path: string;
  name: string;
  lastOpenedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ThreadSummary {
  id: string;
  title: string | null;
  workspaceId: string | null;
  workspacePath?: string | null;
  workspaceName?: string | null;
  workspace?: DesktopWorkspace | null;
  lastMessageAt: string | null;
  messageCount?: number;
  _count?: { messages?: number };
}

export function listWorkspaces(token: string): Promise<ApiResult<DesktopWorkspace[]>> {
  return request('/api/desktop/threads/workspaces', { method: 'GET' }, token);
}

export function upsertWorkspace(
  token: string,
  payload: { path: string; name?: string },
): Promise<ApiResult<DesktopWorkspace>> {
  return request(
    '/api/desktop/threads/workspaces',
    { method: 'POST', body: JSON.stringify(payload) },
    token,
  );
}

export function listThreads(token: string): Promise<ApiResult<ThreadSummary[]>> {
  return request('/api/desktop/threads', { method: 'GET' }, token);
}

export function createThread(
  token: string,
  payload: {
    title?: string;
    workspaceId?: string | null;
    workspace?: { id?: string | null; path: string; name: string } | null;
  },
): Promise<ApiResult<ThreadSummary>> {
  return request(
    '/api/desktop/threads',
    { method: 'POST', body: JSON.stringify(payload) },
    token,
  );
}

export function deleteThread(token: string, id: string): Promise<ApiResult<void>> {
  return request(`/api/desktop/threads/${id}`, { method: 'DELETE' }, token);
}

export interface ApiMessage {
  id: string;
  threadId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface ThreadDetail extends ThreadSummary {
  messages: ApiMessage[];
  pagination: {
    page: number;
    pageSize: number;
    totalMessages: number;
    totalPages: number;
  };
}

export function getThread(
  token: string,
  id: string,
  page = 1,
  pageSize = 100,
): Promise<ApiResult<ThreadDetail>> {
  return request(
    `/api/desktop/threads/${encodeURIComponent(id)}?page=${page}&pageSize=${pageSize}`,
    { method: 'GET' },
    token,
  );
}
