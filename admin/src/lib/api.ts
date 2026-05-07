import { toast } from "sonner";

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
    toast.error(`Error ${response.status}`, { description: errorMsg });
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

export type DepartmentSummary = {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string | null;
  status: "active" | "archived" | string;
  managerCount: number;
  memberCount: number;
  roleCount: number;
  hasAgentConfig: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DepartmentRole = {
  id: string;
  name: string;
  slug: string;
  isSystem: boolean;
  isDefault: boolean;
  zohoReadScope: "personalized" | "show_all" | string;
  createdAt: string;
  updatedAt: string;
};

export type DepartmentMembership = {
  id: string;
  userId: string;
  name: string | null;
  email: string;
  roleId: string;
  roleSlug: string;
  roleName: string;
  status: "active" | "inactive" | string;
  createdAt: string;
  updatedAt: string;
};

export type DepartmentToolPermission = {
  id: string;
  roleId: string;
  toolId: string;
  actionGroup: string;
  allowed: boolean;
};

export type DepartmentUserOverride = {
  id: string;
  userId: string;
  toolId: string;
  actionGroup: string;
  allowed: boolean;
};

export type DepartmentSkill = {
  id: string;
  name: string;
  slug: string;
  summary: string;
  markdown: string;
  tags: string[];
  status: string;
  scope: string;
  departmentId: string | null;
};

export type DepartmentAvailableTool = {
  toolId: string;
  supportedActionGroups: string[];
};

export type DepartmentDetailSection =
  | "overview"
  | "roles"
  | "members"
  | "permissions"
  | "config";

export type DepartmentDetail = {
  loadedSections: DepartmentDetailSection[];
  department: {
    id: string;
    companyId: string;
    name: string;
    slug: string;
    description: string | null;
    status: "active" | "archived" | string;
    createdAt: string;
    updatedAt: string;
  };
  config: {
    systemPrompt: string;
    skillsMarkdown: string;
    zohoRateLimit: unknown;
    managerApproval: unknown;
    isActive: boolean;
  };
  roles: DepartmentRole[];
  memberships: DepartmentMembership[];
  toolPermissions: DepartmentToolPermission[];
  userOverrides: DepartmentUserOverride[];
  departmentSkills: DepartmentSkill[];
  globalSkills: DepartmentSkill[];
  availableTools: DepartmentAvailableTool[];
};

export type DepartmentCandidate = {
  channelIdentityId: string;
  userId?: string;
  name?: string;
  email?: string;
  workspaceRole?: string;
  isWorkspaceMember: boolean;
  isAlreadyAssigned: boolean;
  larkDisplayName?: string;
  larkUserId?: string;
  larkOpenId?: string;
  larkSourceRoles: string[];
};

export type CreateDepartmentInput = {
  companyId?: string;
  name: string;
  description?: string;
};

export type UpdateDepartmentInput = {
  name?: string;
  description?: string | null;
  status?: "active" | "archived";
};

export type UpdateDepartmentConfigInput = {
  systemPrompt: string;
  skillsMarkdown: string;
  zohoRateLimit?: unknown;
  managerApproval?: unknown;
  isActive?: boolean;
};

export type CreateDepartmentRoleInput = {
  name: string;
  slug: string;
  zohoReadScope?: "personalized" | "show_all";
};

export type UpdateDepartmentRoleInput = {
  name: string;
  isDefault?: boolean;
  zohoReadScope?: "personalized" | "show_all";
};

export type UpsertDepartmentMembershipInput = {
  userId?: string;
  channelIdentityId?: string;
  roleId?: string;
  status?: "active" | "inactive";
};

export const memoriesApi = {
  list: (token?: string, params?: Record<string, string>) =>
    api.get<Array<{ id: string; memory: string; score?: number; createdAt?: string; updatedAt?: string; metadata?: Record<string, unknown> }>>(
      `/api/admin/memories${params ? `?${new URLSearchParams(params)}` : ''}`,
      token,
    ),
  stats: (token?: string) =>
    api.get<{ totalUser: number; totalDepartment: number; totalCompany: number }>(
      '/api/admin/memories/stats',
      token,
    ),
  delete: (id: string, token?: string) =>
    api.delete<{ deleted: boolean }>(`/api/admin/memories/${id}`, {}, token),
  deleteAllForUser: (userId: string, token?: string) =>
    api.delete<{ deleted: boolean }>(`/api/admin/memories/user/${userId}`, {}, token),
};

export const departmentsApi = {
  list: (token?: string) =>
    api.get<DepartmentSummary[]>("/api/admin/departments", token),
  get: (id: string, token?: string, sections?: DepartmentDetailSection[]) =>
    api.get<DepartmentDetail>(
      `/api/admin/departments/${id}${
        sections && sections.length > 0
          ? `?sections=${encodeURIComponent(sections.join(","))}`
          : ""
      }`,
      token,
    ),
  create: (body: CreateDepartmentInput, token?: string) =>
    api.post<{
      id: string;
      companyId: string;
      name: string;
      slug: string;
      status: string;
      managerRoleId: string;
      memberRoleId: string;
    }>("/api/admin/departments", body, token),
  update: (id: string, body: UpdateDepartmentInput, token?: string) =>
    api.put<{
      id: string;
      name: string;
      slug: string;
      description: string | null;
      status: string;
      updatedAt: string;
    }>(`/api/admin/departments/${id}`, body, token),
  archive: (id: string, token?: string) =>
    api.post<{ id: string; status: string }>(
      `/api/admin/departments/${id}/archive`,
      {},
      token,
    ),
  updateConfig: (
    id: string,
    body: UpdateDepartmentConfigInput,
    token?: string,
  ) =>
    api.put<{
      departmentId: string;
      systemPrompt: string;
      skillsMarkdown: string;
      isActive: boolean;
      updatedAt: string;
    }>(`/api/admin/departments/${id}/config`, body, token),
  createRole: (id: string, body: CreateDepartmentRoleInput, token?: string) =>
    api.post<{
      id: string;
      name: string;
      slug: string;
      zohoReadScope: string;
    }>(`/api/admin/departments/${id}/roles`, body, token),
  updateRole: (
    id: string,
    roleId: string,
    body: UpdateDepartmentRoleInput,
    token?: string,
  ) =>
    api.put<{
      id: string;
      name: string;
      slug: string;
      isDefault: boolean;
      zohoReadScope: string;
    }>(`/api/admin/departments/${id}/roles/${roleId}`, body, token),
  deleteRole: (id: string, roleId: string, token?: string) =>
    api.delete<{ deleted: boolean }>(
      `/api/admin/departments/${id}/roles/${roleId}`,
      {},
      token,
    ),
  upsertMembership: (
    id: string,
    body: UpsertDepartmentMembershipInput,
    token?: string,
  ) =>
    api.put<DepartmentMembership>(
      `/api/admin/departments/${id}/memberships`,
      body,
      token,
    ),
  removeMembership: (id: string, userId: string, token?: string) =>
    api.delete<{ deleted: boolean }>(
      `/api/admin/departments/${id}/memberships/${userId}`,
      {},
      token,
    ),
  searchCandidates: (id: string, query: string, token?: string) =>
    api.get<DepartmentCandidate[]>(
      `/api/admin/departments/${id}/candidates?query=${encodeURIComponent(query)}`,
      token,
    ),
  setRolePermission: (
    id: string,
    roleId: string,
    toolId: string,
    actionGroup: string,
    allowed: boolean,
    token?: string,
  ) =>
    api.put<DepartmentToolPermission>(
      `/api/admin/departments/${id}/role-permissions/${roleId}/${toolId}/${actionGroup}`,
      { allowed },
      token,
    ),
  setUserOverride: (
    id: string,
    userId: string,
    toolId: string,
    actionGroup: string,
    allowed: boolean,
    token?: string,
  ) =>
    api.put<DepartmentUserOverride>(
      `/api/admin/departments/${id}/user-overrides/${userId}/${toolId}/${actionGroup}`,
      { allowed },
      token,
    ),
};
