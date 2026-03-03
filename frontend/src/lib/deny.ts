import type { ReasonCode } from "@/types";

const MESSAGES: Record<ReasonCode, string> = {
  tool_not_permitted: "Your role does not allow this tool.",
  role_not_assigned: "No role is assigned to your account.",
  tool_disabled_org_level: "This tool is disabled for the organization.",
  requires_higher_role: "This action requires a higher role.",
  approval_required: "This action needs additional approval.",
  not_org_member: "You are not a member of this organization.",
  policy_conflict: "Action blocked due to policy conflict.",
  invalid_reset_token: "This reset link is invalid.",
  expired_reset_token: "This reset link has expired.",
  password_not_supported_for_provider:
    "Password reset is not supported for this authentication provider.",
  validation_error: "Please check your input and try again.",
};

export function denyMessage(reasonCode?: string | null) {
  if (!reasonCode) return MESSAGES.tool_not_permitted;
  return MESSAGES[(reasonCode as ReasonCode) || "tool_not_permitted"] || MESSAGES.tool_not_permitted;
}
