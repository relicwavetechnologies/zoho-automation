import { toast } from '../components/ui/use-toast';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';

type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
};

const extractErrorMessage = async (response: Response): Promise<string> => {
  const raw = await response.text();
  if (!raw) {
    return `HTTP ${response.status}`;
  }

  try {
    const parsed = JSON.parse(raw) as { message?: string; meta?: { message?: string } };
    return parsed.meta?.message || parsed.message || raw;
  } catch {
    return raw;
  }
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
    const errorMsg = await extractErrorMessage(response);
    toast({
      title: `Error ${response.status}`,
      description: errorMsg,
      variant: 'destructive',
    });
    throw new Error(errorMsg);
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
