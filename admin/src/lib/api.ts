const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';

type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
};

const request = async <T>(path: string, init: RequestInit = {}, token?: string): Promise<T> => {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  const body = (await response.json()) as ApiResponse<T>;
  return body.data;
};

export const api = {
  post: <T>(path: string, payload: unknown, token?: string) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(payload) }, token),
  put: <T>(path: string, payload: unknown, token?: string) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(payload) }, token),
  delete: <T>(path: string, payload: unknown, token?: string) =>
    request<T>(path, { method: 'DELETE', body: JSON.stringify(payload) }, token),
  get: <T>(path: string, token?: string) => request<T>(path, { method: 'GET' }, token),
};
