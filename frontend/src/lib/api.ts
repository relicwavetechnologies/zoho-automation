import type {
  Capabilities,
  Conversation,
  Membership,
  Message,
  Model,
  Organization,
  ProfileDto,
  SecurityDto,
  SessionBootstrap,
  User,
} from "@/types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export class ApiError extends Error {
  status: number;
  reasonCode?: string;

  constructor(status: number, message: string, reasonCode?: string) {
    super(message);
    this.status = status;
    this.reasonCode = reasonCode;
    this.name = "ApiError";
  }
}

type ApiRequestOptions = RequestInit & { token?: string };

function parseError(status: number, body?: Record<string, unknown>) {
  if (typeof body?.error === "string") return body.error;
  if (typeof body?.message === "string") return body.message;
  if (status >= 500) return "Unable to connect";
  return "Request failed";
}

export async function apiFetch<T>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const { token, headers, ...rest } = options;

  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...rest,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(headers || {}),
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const reasonCode =
        typeof body?.reason_code === "string"
          ? body.reason_code
          : typeof body?.reasonCode === "string"
            ? body.reasonCode
            : undefined;
      throw new ApiError(response.status, parseError(response.status, body), reasonCode);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, "Unable to connect");
  }
}

export interface InviteRecord {
  invite_id: string;
  email: string;
  role_key: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  expires_at: string;
  created_at?: string;
}

export interface RoleDto {
  id: string;
  org_id?: string;
  key: string;
  name: string;
  is_system: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ToolPermissionDto {
  role_id?: string;
  tool_key: string;
  can_execute: boolean;
  requires_approval: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface MemberRoleAssignment {
  member_id: string;
  role_id: string;
  status: string;
}

export interface PolicyCheckResponse {
  allowed: boolean;
  reason_code: string;
  reason_message: string;
  requires_approval: boolean;
}

export interface IntegrationStatusDto {
  provider: "zoho";
  status: "connected" | "disconnected" | "expired" | string;
  connected_at?: string;
  last_health_check_at?: string;
}

export interface MemberRecord {
  id?: string;
  user_id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  role_key: string;
  status: string;
  member_id?: string;
  user?: {
    id: string;
    email: string;
    first_name: string;
    last_name: string;
  };
}

export interface AuditRecord {
  id: string;
  actor_email: string;
  action: string;
  entity_type: string;
  entity_id: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

export const api = {
  auth: {
    login: (email: string, password: string) =>
      apiFetch<{ token: string; user: User }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    register: (first_name: string, last_name: string, email: string, password: string) =>
      apiFetch<{ token: string; user: User }>("/auth/register", {
        method: "POST",
        body: JSON.stringify({ first_name, last_name, email, password }),
      }),
    me: (token: string) => apiFetch<User>("/auth/me", { token }),
    sessionBootstrap: (token: string) =>
      apiFetch<SessionBootstrap>("/session/bootstrap", { token }),
    sessionExchange: (exchange_token: string) =>
      apiFetch<{ token: string }>("/auth/session/exchange", {
        method: "POST",
        body: JSON.stringify({ exchange_token }),
      }),
    getGoogleStartUrl: (redirectTo?: string) => {
      const url = new URL(`${API_URL}/auth/google/start`);
      if (redirectTo) {
        url.searchParams.set("redirect_to", redirectTo);
      }
      return url.toString();
    },
  },
  me: {
    profile: {
      get: (token: string) => apiFetch<ProfileDto>("/me/profile", { token }),
      update: (
        token: string,
        data: { first_name: string; last_name: string; avatar_url?: string | null }
      ) =>
        apiFetch<ProfileDto>("/me/profile", {
          method: "PATCH",
          token,
          body: JSON.stringify(data),
        }),
    },
    security: {
      get: (token: string) => apiFetch<SecurityDto>("/me/security", { token }),
    },
  },
  account: {
    password: {
      resetRequest: (email: string) =>
        apiFetch<{ message: string }>("/account/password/reset/request", {
          method: "POST",
          body: JSON.stringify({ email }),
        }),
      resetConfirm: (token: string, newPassword: string) =>
        apiFetch<{ status: "success" }>("/account/password/reset/confirm", {
          method: "POST",
          body: JSON.stringify({ token, new_password: newPassword }),
        }),
    },
  },
  session: {
    capabilities: (token: string) => apiFetch<Capabilities>("/session/capabilities", { token }),
  },
  onboarding: {
    createOrganization: (
      token: string,
      data: { organization_name: string; first_name?: string; last_name?: string }
    ) =>
      apiFetch<{ organization: Organization; membership: Membership; capabilities: Capabilities }>(
        "/onboarding/organization",
        {
          method: "POST",
          token,
          body: JSON.stringify(data),
        }
      ),
  },
  invites: {
    create: (token: string, data: { email: string; role_key: string }) =>
      apiFetch<{ invite_id: string; status: "pending"; expires_at: string }>("/invites", {
        method: "POST",
        token,
        body: JSON.stringify(data),
      }),
    list: (token: string) => apiFetch<InviteRecord[]>("/invites", { token }),
    revoke: (token: string, inviteId: string) =>
      apiFetch<void>(`/invites/${inviteId}/revoke`, { method: "POST", token }),
    resend: (token: string, inviteId: string) =>
      apiFetch<void>(`/invites/${inviteId}/resend`, { method: "POST", token }),
    validate: (token: string) =>
      apiFetch<{ status: string; email?: string }>(
        `/invites/validate?token=${encodeURIComponent(token)}`
      ),
    accept: (token: string, inviteToken: string) =>
      apiFetch<{ status: "accepted"; organization_id: string; role_key: string }>(
        "/invites/accept",
        {
          method: "POST",
          token,
          body: JSON.stringify({ token: inviteToken }),
        }
      ),
  },
  rbac: {
    roles: {
      list: (token: string) => apiFetch<RoleDto[]>("/rbac/roles", { token }),
      create: (token: string, data: { key: string; name: string; clone_from_role_id?: string }) =>
        apiFetch<RoleDto>("/rbac/roles", {
          method: "POST",
          token,
          body: JSON.stringify(data),
        }),
      update: (token: string, roleId: string, data: { name?: string }) =>
        apiFetch<RoleDto>(`/rbac/roles/${roleId}`, {
          method: "PATCH",
          token,
          body: JSON.stringify(data),
        }),
      remove: (token: string, roleId: string) =>
        apiFetch<void>(`/rbac/roles/${roleId}`, { method: "DELETE", token }),
    },
    rolePermissions: {
      list: (token: string, roleId: string) =>
        apiFetch<ToolPermissionDto[]>(`/rbac/role-permissions?role_id=${encodeURIComponent(roleId)}`, {
          token,
        }),
      replace: (token: string, roleId: string, permissions: ToolPermissionDto[]) =>
        apiFetch<ToolPermissionDto[]>(`/rbac/role-permissions/${roleId}`, {
          method: "PUT",
          token,
          body: JSON.stringify({ permissions }),
        }),
    },
    members: {
      roles: {
        get: (token: string, memberId: string) =>
          apiFetch<MemberRoleAssignment[]>(`/rbac/members/${memberId}/roles`, { token }),
        put: (token: string, memberId: string, roleId: string, status: string = "active") =>
          apiFetch<{ member_id: string; role_id: string; status: string }>(
            `/rbac/members/${memberId}/roles`,
            {
              method: "PUT",
              token,
              body: JSON.stringify({ role_id: roleId, status }),
            }
          ),
      },
    },
    policy: {
      check: (
        token: string,
        payload: { org_id: string; user_id: string; tool_key: string; action: "execute" }
      ) =>
        apiFetch<PolicyCheckResponse>("/rbac/policy/check", {
          method: "POST",
          token,
          body: JSON.stringify(payload),
        }),
    },
  },
  admin: {
    members: {
      list: (token: string) => apiFetch<MemberRecord[]>("/admin/members", { token }),
    },
    integrations: {
      status: (token: string) => apiFetch<IntegrationStatusDto>("/integrations/zoho", { token }),
      connect: (token: string) =>
        apiFetch<void>("/integrations/zoho/connect", { method: "POST", token }),
      reconnect: (token: string) =>
        apiFetch<void>("/integrations/zoho/reconnect", { method: "POST", token }),
      disconnect: (token: string) =>
        apiFetch<void>("/integrations/zoho/disconnect", { method: "POST", token }),
    },
    audit: {
      list: (
        token: string,
        params: { action?: string; actor_email?: string; from?: string; to?: string } = {}
      ) => {
        const query = new URLSearchParams();
        if (params.action) query.set("action", params.action);
        if (params.actor_email) query.set("actor_email", params.actor_email);
        if (params.from) query.set("from", params.from);
        if (params.to) query.set("to", params.to);
        const suffix = query.toString() ? `?${query.toString()}` : "";
        return apiFetch<AuditRecord[]>(`/admin/audit${suffix}`, { token });
      },
    },
  },
  conversations: {
    list: (token: string) => apiFetch<Conversation[]>("/conversations", { token }),
    create: (
      token: string,
      data: { title?: string; model: string; system_prompt?: string }
    ) =>
      apiFetch<Conversation>("/conversations", {
        method: "POST",
        body: JSON.stringify(data),
        token,
      }),
    get: (token: string, id: string) =>
      apiFetch<Conversation>(`/conversations/${id}`, { token }),
    updateSettings: (
      token: string,
      id: string,
      data: { model?: string; system_prompt?: string; temperature?: number; title?: string }
    ) =>
      apiFetch<Conversation>(`/conversations/${id}/settings`, {
        method: "PATCH",
        body: JSON.stringify(data),
        token,
      }),
    delete: (token: string, id: string) =>
      apiFetch<void>(`/conversations/${id}`, {
        method: "DELETE",
        token,
      }),
  },
  messages: {
    list: (token: string, conversationId: string) =>
      apiFetch<Message[]>(`/conversations/${conversationId}/messages`, { token }),
    send: (token: string, conversationId: string, content: string) =>
      apiFetch<Message>(`/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
        token,
      }),
  },
  models: {
    list: (token: string) => apiFetch<Model[]>("/models", { token }),
  },
};

export const authLogin = api.auth.login;
export const authRegister = api.auth.register;
export const authMe = api.auth.me;
export const authSessionBootstrap = api.auth.sessionBootstrap;
export const authGoogleStartUrl = api.auth.getGoogleStartUrl;
export const getMyProfile = api.me.profile.get;
export const updateMyProfile = api.me.profile.update;
export const getMySecurity = api.me.security.get;
export const requestPasswordReset = api.account.password.resetRequest;
export const confirmPasswordReset = api.account.password.resetConfirm;
export const listConversations = api.conversations.list;
export const createConversation = api.conversations.create;
export const getConversation = api.conversations.get;
export const patchConversationSettings = api.conversations.updateSettings;
export const deleteConversation = api.conversations.delete;
export const listMessages = api.messages.list;
export const createMessage = api.messages.send;
export const listModels = api.models.list;
