import { useCallback, useEffect, useState } from "react";
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

export type CompanyMemberRole = "MEMBER" | "COMPANY_ADMIN";

export const companyMembersApi = {
  updateRole: (
    userId: string,
    input: { role: CompanyMemberRole; companyId?: string },
    token?: string,
  ) => api.put<{ userId: string; companyId: string; role: CompanyMemberRole }>(
    `/api/admin/company/members/${userId}/role`,
    input,
    token,
  ),
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
  speed: "fast" | "medium" | "slow";
  cost: "low" | "medium" | "high";
  maxContextTokens: number;
  outputReserveTokens?: number;
  preview?: boolean;
  supportsThinking?: boolean;
};

export const agentsApi = {
  /**
   * The governed tool catalogue. Named for its historical client, but it is not
   * about agents — Skills Lab and the department editor are what read it.
   */
  toolRegistry: <T = any>(token?: string) =>
    api.get<T[]>("/api/admin/tool-registry", token),
};


export type ConnectOpenAiInput = {
  tier?: "free" | "pro";
  label?: string;
};

export type OpenAiConnectStart = {
  companyId: string;
  gatewayUrl: string;
  authUrl: string;
  sessionId: string;
  dedicatedAccountId: string;
};

export type CompleteOpenAiInput = {
  dedicatedAccountId: string;
  callbackUrl: string;
};

export type OpenAiConnectComplete = {
  companyId: string;
  connected: boolean;
  status: string;
  gatewayUrl: string;
  dedicatedAccountId: string;
  tier?: string | null;
  updatedAt: string;
};

export type OpenAiTestResult = {
  ok: boolean;
  status: number;
  latencyMs: number;
  response: unknown;
};

export type AiModelTarget = {
  id: string;
  targetKey: string;
  provider: "openai" | "google" | string;
  modelId: string;
  thinkingLevel?: string | null;
  fastProvider?: string | null;
  fastModelId?: string | null;
  fastThinkingLevel?: string | null;
  xtremeProvider?: string | null;
  xtremeModelId?: string | null;
  xtremeThinkingLevel?: string | null;
  updatedBy?: string;
  updatedAt?: string;
};

export type UpdateAiModelTargetInput = {
  provider: "openai" | "google";
  modelId: string;
  thinkingLevel?: string | null;
  fastProvider?: string | null;
  fastModelId?: string | null;
  fastThinkingLevel?: string | null;
  xtremeProvider?: string | null;
  xtremeModelId?: string | null;
  xtremeThinkingLevel?: string | null;
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
    desktopPersonaPrompt: string;
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
  desktopPersonaPrompt: string;
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
      desktopPersonaPrompt: string;
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
  getBookModulePermissions: (id: string, token?: string) =>
    api.get<BooksModulePermission[]>(
      `/api/admin/departments/${id}/books-modules`,
      token,
    ),
  setBookModulePermission: (
    id: string,
    roleId: string,
    module: string,
    allowed: boolean,
    token?: string,
  ) =>
    api.put<{ roleId: string; module: string; enabled: boolean }>(
      `/api/admin/departments/${id}/books-modules/${roleId}/${module}`,
      { allowed },
      token,
    ),
};

export type BooksModulePermission = {
  id: string;
  roleId: string;
  module: string;
  enabled: boolean;
};

// ─── Skill Registry (Skills Lab) ──────────────────────────────────────────────

export type SkillRegistrySkillNode = {
  id: string;
  name: string;
  slug: string;
  summary: string;
  toolIds: string[];
  tags: string[];
  status: string;
  scope: string;
  departmentId: string | null;
  folderId: string | null;
  isSystem: boolean;
  revision: number;
  updatedAt: string;
};

export type SkillRegistryFolderNode = {
  id: string;
  name: string;
  slug: string;
  departmentId: string | null;
  parentId: string | null;
  status: string;
  children: SkillRegistryFolderNode[];
  skills: SkillRegistrySkillNode[];
};

export type SkillRegistryRoot = {
  folders: SkillRegistryFolderNode[];
  skills: SkillRegistrySkillNode[];
};

export type SkillRegistryTree = {
  registryRevision: number;
  companyWide: SkillRegistryRoot;
  departments: (SkillRegistryRoot & { id: string; name: string })[];
};

export type SkillDetail = {
  id: string;
  name: string;
  slug: string;
  summary: string;
  markdown: string;
  toolIds: string[];
  tags: string[];
  aliases: string[];
  status: string;
  scope: string;
  departmentId: string | null;
  departmentName: string | null;
  folderId: string | null;
  folderPath: string[];
  isSystem: boolean;
  revision: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SkillGranteeType = "user" | "department" | "role" | "company";
export type SkillGranteeCandidate = {
  granteeId: string;
  label: string;
  detail: string | null;
};
export type SkillGrant = {
  granteeType: SkillGranteeType;
  granteeId: string;
  label: string;
  detail: string | null;
  grantedBy: string | null;
  createdAt: string;
};
export type SkillAccess = {
  skillId: string;
  scope: string;
  departmentId: string | null;
  grants: SkillGrant[];
  candidates: {
    users: SkillGranteeCandidate[];
    departments: SkillGranteeCandidate[];
    roles: SkillGranteeCandidate[];
    company: SkillGranteeCandidate | null;
  };
};

export type SkillAuditEntry = {
  id: string;
  action: string;
  actorId: string;
  outcome: string;
  metadata: unknown;
  createdAt: string;
};

export type SkillRegistryFolder = {
  id: string;
  name: string;
  slug: string;
  departmentId: string | null;
  parentId: string | null;
  status: string;
};

const withCompany = (path: string, companyId?: string): string =>
  companyId ? `${path}${path.includes("?") ? "&" : "?"}companyId=${encodeURIComponent(companyId)}` : path;

// companyId (super-admin only) travels in the query on GET and the body on writes.
const body = (payload: Record<string, unknown>, companyId?: string) =>
  companyId ? { ...payload, companyId } : payload;

const REGISTRY_BASE = "/api/admin/skill-registry";

export const skillRegistryApi = {
  tree: (opts: { includeArchived?: boolean; companyId?: string } = {}, token?: string) =>
    api.get<SkillRegistryTree>(
      withCompany(`${REGISTRY_BASE}/tree${opts.includeArchived ? "?includeArchived=true" : ""}`, opts.companyId),
      token,
    ),
  skill: (skillId: string, companyId?: string, token?: string) =>
    api.get<SkillDetail>(withCompany(`${REGISTRY_BASE}/skills/${skillId}`, companyId), token),
  access: (skillId: string, companyId?: string, token?: string) =>
    api.get<SkillAccess>(withCompany(`${REGISTRY_BASE}/skills/${skillId}/access`, companyId), token),
  grantAccess: (skillId: string, granteeType: SkillGranteeType, granteeId: string, companyId?: string, token?: string) =>
    api.post<SkillGrant>(`${REGISTRY_BASE}/skills/${skillId}/access`, body({ granteeType, granteeId }, companyId), token),
  revokeAccess: (skillId: string, granteeType: SkillGranteeType, granteeId: string, companyId?: string, token?: string) =>
    api.delete<{ skillId: string; granteeType: SkillGranteeType; granteeId: string }>(
      withCompany(`${REGISTRY_BASE}/skills/${skillId}/access/${granteeType}/${granteeId}`, companyId),
      {},
      token,
    ),
  audit: (skillId: string, companyId?: string, token?: string) =>
    api.get<SkillAuditEntry[]>(withCompany(`${REGISTRY_BASE}/skills/${skillId}/audit`, companyId), token),
  createFolder: (
    input: { name: string; parentId?: string | null; departmentId?: string | null },
    companyId?: string,
    token?: string,
  ) => api.post<SkillRegistryFolder>(`${REGISTRY_BASE}/folders`, body(input, companyId), token),
  renameFolder: (folderId: string, name: string, companyId?: string, token?: string) =>
    api.put<SkillRegistryFolder>(`${REGISTRY_BASE}/folders/${folderId}`, body({ name }, companyId), token),
  moveFolder: (folderId: string, parentId: string | null, companyId?: string, token?: string) =>
    api.post<SkillRegistryFolder>(`${REGISTRY_BASE}/folders/${folderId}/move`, body({ parentId }, companyId), token),
  archiveFolder: (folderId: string, companyId?: string, token?: string) =>
    api.post<{ archivedFolders: number; detachedSkills: number }>(
      `${REGISTRY_BASE}/folders/${folderId}/archive`,
      body({}, companyId),
      token,
    ),
  moveSkill: (skillId: string, folderId: string | null, companyId?: string, token?: string) =>
    api.post<{ skillId: string; folderId: string | null }>(
      `${REGISTRY_BASE}/skills/${skillId}/move`,
      body({ folderId }, companyId),
      token,
    ),
  backfill: (companyId?: string, token?: string) =>
    api.post<{ foldersCreated: number; skillsPlaced: number }>(`${REGISTRY_BASE}/backfill`, body({}, companyId), token),
};
