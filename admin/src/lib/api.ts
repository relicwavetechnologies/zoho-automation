import { useCallback, useEffect, useState } from "react";
import { notifyForStatus } from "@/lib/notify";

/*
 * `import.meta.env` is Vite's, and only Vite's.
 *
 * Read bare, this threw for anything that imported the module outside a Vite
 * build — which is every `node --test` run, and therefore every module in the
 * data layer that reaches `api` through an import chain. The whole permission
 * derivation behind the agent map was untestable because of this one property
 * access. Optional chaining costs nothing in the browser, where the object is
 * always there.
 */
const API_BASE_URL =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL
  ?? "http://localhost:8000";

type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
};

/**
 * The refusal's own name, when it gave one.
 *
 * A status code alone is not enough to act on: Mail Ops answers both "another
 * rule already has these conditions" and "that rule is archived" with a 409,
 * and they have opposite remedies. Callers that only need prose keep ignoring
 * this.
 */
const extractErrorCode = (raw: string): string | undefined => {
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; status?: unknown };
    if (typeof parsed.code === "string") return parsed.code;
    if (typeof parsed.status === "string") return parsed.status;
  } catch { /* not JSON — there is no code to find */ }
  return undefined;
};

// Takes the body already read rather than the response, because a body can
// only be read once and the code has to come out of the same text.
const extractErrorMessage = (raw: string, status: number): string => {
  const fallback = `HTTP ${status}`;
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as {
      message?: string;
      meta?: { message?: string };
      error?: string | { message?: string };
    };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
    return parsed.meta?.message || parsed.message || fallback;
  } catch {
    // Reverse proxies sometimes return an HTML error page or a stack trace.
    // Keep that implementation detail out of the person's auth screen.
    return fallback;
  }
};

/**
 * A fetch that never answered, said in words.
 *
 * An aborted request throws a DOMException whose message is "signal is aborted
 * without reason". Rendered straight into the sign-in form, that sentence
 * blames something inside the browser and names neither the timeout that fired
 * nor the server that went quiet — so the one person who could fix it goes
 * looking in the wrong place. Seen for real against a local backend whose SSH
 * database tunnel had dropped: the API kept accepting connections and never
 * replied.
 */
const asReadableNetworkError = (error: unknown, timeoutMs: number | undefined): Error => {
  const aborted = error instanceof DOMException
    ? error.name === "AbortError"
    : (error as { name?: string } | null)?.name === "AbortError";
  if (aborted) {
    const waited = timeoutMs === undefined ? "" : ` within ${Math.round(timeoutMs / 1000)} seconds`;
    return new Error(
      `Divo's server did not respond${waited}. It may still be starting up, or it cannot reach its database.`,
    );
  }
  if (error instanceof TypeError) {
    // What `fetch` throws when nothing is listening, DNS fails, or CORS blocks
    // the response — all of which read to a person as "the app is offline".
    return new Error("Divo's server could not be reached. Check that it is running, then try again.");
  }
  return error instanceof Error ? error : new Error("The request could not be completed.");
};

/**
 * Thrown instead of a bare Error so a caller can tell "wrong password" (401)
 * from "no workspace" (403) from "the server fell over" without parsing prose.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The server's own name for the refusal, where it sent one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type RequestOptions = {
  /**
   * Suppress the error toast. Sign-in renders its failure inline, next to the
   * field that caused it — a toast on top of that is the same news twice.
   */
  quiet?: boolean;
  /**
   * Return the parsed body instead of `body.data`.
   *
   * Most routes answer `{ success, data }`, but the approvals router returns
   * its payload bare. Unwrapping that would hand back `undefined`, which reads
   * downstream as "no approvals" rather than as a bug — so the exception is
   * declared at the call site rather than guessed at here.
   */
  raw?: boolean;
  /** Abort an auth request that has stopped responding instead of loading forever. */
  timeoutMs?: number;
  /** Override the default read retry count when the caller already retries. */
  retries?: number;
};

/**
 * Statuses worth asking again about.
 *
 * Not 503: this backend uses it to mean "no app is configured for that
 * provider on this deployment", which is a settled answer, and retrying it
 * would add two round trips to every unconfigured integration on a page that
 * checks six of them. 500/502/504 and a `fetch` that throws outright are the
 * shapes of a backend restarting or a database tunnel dropping.
 */
const RETRYABLE = new Set([500, 502, 504]);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads are retried; writes are not.
 *
 * Every screen in this app was one failed GET away from asserting something
 * false — six providers each reporting "could not read this connection" for
 * one dropped tunnel, a permission grid rendering empty, a team looking like
 * it has nobody in it. The hooks each caught their own failure and rendered it
 * as a fact about the world, and fixing that hook by hook would have left the
 * next one to be written with the same hole.
 *
 * A GET is safe to repeat by definition. A POST, PUT or DELETE is not — a
 * request that timed out may well have been applied — so those still fail on
 * the first attempt and the caller decides.
 */
const request = async <T>(
  path: string,
  init: RequestInit = {},
  token?: string,
  opts: RequestOptions = {},
): Promise<T> => {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const retries = opts.retries ?? ((init.method ?? "GET") === "GET" ? 2 : 0);
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    const controller = opts.timeoutMs === undefined ? undefined : new AbortController();
    const timeoutId = opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => controller?.abort(), opts.timeoutMs);
    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        ...init,
        headers,
        ...(init.signal || !controller ? {} : { signal: controller.signal }),
      });
      if (response.ok || !RETRYABLE.has(response.status) || attempt >= retries) break;
    } catch (networkError) {
      // The backend is not answering at all. Worth one more ask before this
      // becomes a sentence on somebody's screen.
      if (attempt >= retries) throw asReadableNetworkError(networkError, opts.timeoutMs);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    await wait(300 * (attempt + 1));
  }

  if (!response.ok) {
    const raw = await response.text();
    const errorMsg = extractErrorMessage(raw, response.status);
    const code = extractErrorCode(raw);
    // One notifier decides the voice. "Error 500" told a person nothing they
    // could act on, and a refusal in the same red as a fault made a boundary
    // look like a bug worth retrying.
    if (!opts.quiet) notifyForStatus(response.status, errorMsg);
    throw new ApiError(response.status, errorMsg, code);
  }

  const body = (await response.json()) as ApiResponse<T>;
  return opts.raw ? (body as unknown as T) : body.data;
};

export const api = {
  post: <T>(path: string, payload: unknown, token?: string, opts?: RequestOptions) =>
    request<T>(path, { method: "POST", body: JSON.stringify(payload) }, token, opts),
  put: <T>(path: string, payload: unknown, token?: string, opts?: RequestOptions) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(payload) }, token, opts),
  patch: <T>(path: string, payload: unknown, token?: string, opts?: RequestOptions) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(payload) }, token, opts),
  delete: <T>(path: string, payload: unknown, token?: string, opts?: RequestOptions) =>
    request<T>(
      path,
      { method: "DELETE", body: JSON.stringify(payload) },
      token,
      opts,
    ),
  get: <T>(path: string, token?: string, opts?: RequestOptions) =>
    request<T>(path, { method: "GET" }, token, opts),
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

export const agentsApi = {
  /**
   * The governed tool catalogue. Named for its historical client, but it is not
   * about agents — Skills Lab and the department editor are what read it.
   */
  toolRegistry: <T = any>(token?: string) =>
    api.get<T[]>("/api/admin/tool-registry", token),
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
    api.get<Array<{ id: string; memory: string; scope: "department" | "company"; score?: number; createdAt?: string; updatedAt?: string; metadata?: Record<string, unknown> }>>(
      `/api/admin/memories${params ? `?${new URLSearchParams(params)}` : ''}`,
      token,
    ),
  stats: (token?: string) =>
    api.get<{ totalPersonal: number; totalDepartment: number; totalCompany: number }>(
      '/api/admin/memories/stats',
      token,
    ),
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
  /**
   * How many people or groups this skill is shared with.
   *
   * Zero means it cannot be run by anybody — the one fact about a skill that
   * used to cost a click each to find. Optional because a backend that has not
   * been deployed yet will not send it, and a library that silently reported
   * every skill as dead would be worse than one that reports nothing.
   */
  grantCount?: number;
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
