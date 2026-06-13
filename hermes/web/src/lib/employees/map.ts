import type { CompanyTeamMember } from "@/lib/api";
import type { EmployeeRow } from "./types";

function readOptionalString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

/** Map the current team-members API row into the canonical EmployeeRow DTO. */
export function mapApiMemberToEmployee(member: CompanyTeamMember): EmployeeRow {
  const raw = member as CompanyTeamMember & Record<string, unknown>;
  const departmentId = String(member.department_id || "").trim() || null;

  return {
    id: member.id,
    company_id: member.company_id,
    display_name: member.display_name || member.email || member.id,
    email: member.email?.trim() ? member.email.trim() : null,
    avatar_url: readOptionalString(raw, "avatar_url", "avatarUrl"),
    lark_open_id: readOptionalString(
      raw,
      "lark_open_id",
      "larkOpenId",
      "provider_user_id",
      "providerUserId",
    ),
    lark_union_id: readOptionalString(raw, "lark_union_id", "larkUnionId"),
    lark_user_id: readOptionalString(raw, "lark_user_id", "larkUserId"),
    department_id: departmentId,
    department_name:
      readOptionalString(raw, "department_name", "departmentName") ||
      departmentId,
    role: member.role || "MEMBER",
    status: member.status || "active",
    first_login_at: member.first_login_at,
    last_login_at: member.last_login_at,
    provider: readOptionalString(raw, "provider") || "lark",
  };
}

export function mapApiMembersToEmployees(
  members: CompanyTeamMember[],
): EmployeeRow[] {
  return members.map(mapApiMemberToEmployee);
}
