import { toast } from "../components/ui/use-toast";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

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
    const parsed = JSON.parse(raw) as {
      message?: string;
      meta?: { message?: string };
    };
    return parsed.meta?.message || parsed.message || raw;
  } catch {
    return raw;
  }
};

const request = async <T>(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> => {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
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
      variant: "destructive",
    });
    throw new Error(errorMsg);
  }

  const body = (await response.json()) as ApiResponse<T>;
  return body.data;
};

export const api = {
  post: <T>(path: string, payload: unknown, token?: string) =>
    request<T>(path, { method: "POST", body: JSON.stringify(payload) }, token),
  put: <T>(path: string, payload: unknown, token?: string) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(payload) }, token),
  delete: <T>(path: string, payload: unknown, token?: string) =>
    request<T>(
      path,
      { method: "DELETE", body: JSON.stringify(payload) },
      token,
    ),
  get: <T>(path: string, token?: string) =>
    request<T>(path, { method: "GET" }, token),
};

export type CreateAgentInput = {
  name: string;
  description?: string;
  systemPrompt: string;
  isRootAgent?: boolean;
  toolIds?: string[];
  parentId?: string;
  modelId?: string | null;
  provider?: string | null;
};

export type UpdateAgentInput = Partial<
  CreateAgentInput & { isActive: boolean; parentId: string | null }
>;

export type ModelCatalogEntry = {
  provider: "openai" | "google";
  modelId: string;
  label: string;
  description: string;
  speed: "fast" | "balanced" | "strong";
  cost: "cheap" | "balanced" | "premium";
  maxContextTokens: number;
  supportsThinking?: boolean;
};

export type SetMappingInput = {
  channelType: "lark" | "desktop";
  channelIdentifier: string;
  agentDefinitionId: string;
};

export type RemoveMappingInput = {
  channelType: string;
  channelIdentifier: string;
};

export const agentsApi = {
  list: <T = any>(token?: string) => api.get<T[]>("/api/agents", token),
  get: <T = any>(id: string, token?: string) =>
    api.get<T>(`/api/agents/${id}`, token),
  create: <T = any>(body: CreateAgentInput, token?: string) =>
    api.post<T>("/api/agents", body, token),
  update: <T = any>(id: string, body: UpdateAgentInput, token?: string) =>
    api.put<T>(`/api/agents/${id}`, body, token),
  delete: (id: string, token?: string) =>
    api.delete(`/api/agents/${id}`, {}, token),
  toggle: (id: string, token?: string) =>
    api.post(`/api/agents/${id}/toggle`, {}, token),
  toolRegistry: <T = any>(token?: string) =>
    api.get<T[]>("/api/agents/tools/registry", token),
  modelCatalog: (token?: string) =>
    api.get<ModelCatalogEntry[]>("/api/agents/models/catalog", token),
};

export const channelMappingsApi = {
  list: <T = any>(token?: string) =>
    api.get<T[]>("/api/channel-mappings", token),
  set: (body: SetMappingInput, token?: string) =>
    api.post("/api/channel-mappings", body, token),
  remove: (body: RemoveMappingInput, token?: string) =>
    api.delete("/api/channel-mappings", body, token),
};
