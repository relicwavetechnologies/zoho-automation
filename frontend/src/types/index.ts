export type ReasonCode =
  | "tool_not_permitted"
  | "role_not_assigned"
  | "tool_disabled_org_level"
  | "requires_higher_role"
  | "approval_required"
  | "not_org_member"
  | "policy_conflict";

export interface User {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  created_at?: string;
  is_email_verified?: boolean;
}

export interface Organization {
  id: string;
  name: string;
}

export interface Membership {
  role_key: string;
  status: "active" | "pending" | "revoked" | string;
}

export interface CapabilityBlockedTool {
  tool_key: string;
  reason_code: ReasonCode;
}

export interface Capabilities {
  roles: string[];
  tools: {
    allowed: string[];
    blocked: CapabilityBlockedTool[];
    approval_required: string[];
  };
}

export interface SessionBootstrap {
  user: User;
  organization: Organization | null;
  membership: Membership | null;
  capabilities?: Capabilities;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  system_prompt: string | null;
  temperature: number;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface ToolExecution {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  result?: string;
  status: "executing" | "completed";
}

export interface Model {
  id: string;
  name: string;
}
