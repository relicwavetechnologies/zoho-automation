import type { CompanyTeamMember } from "@/lib/api";
import { fuzzyRank } from "@/lib/fuzzy";

export const RECENT_ACTIVITY_DAYS = 7;
const UNASSIGNED_DEPARTMENT_KEY = "__employees_unassigned_department__";

export type EmployeeBadgeTone =
  | "destructive"
  | "outline"
  | "secondary"
  | "success"
  | "warning";

export type EmployeeDirectorySort =
  | "first_login_desc"
  | "last_seen_desc"
  | "name_asc";

export type EmployeeStatusFilter = "active" | "all" | "inactive";

export interface EmployeeDirectoryFilters {
  department: string;
  query: string;
  sort: EmployeeDirectorySort;
  status: EmployeeStatusFilter;
}

export interface EmployeeBreakdownItem {
  count: number;
  key: string;
  label: string;
  share: number;
}

export interface EmployeeSummary {
  active: number;
  departmentBreakdown: EmployeeBreakdownItem[];
  departments: number;
  inactive: number;
  missingEmail: number;
  recent: number;
  recentMembers: CompanyTeamMember[];
  roleBreakdown: EmployeeBreakdownItem[];
  total: number;
  withEmail: number;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function humanize(value: string | null | undefined, fallback: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return fallback;
  }
  return titleCase(trimmed.replace(/[_-]+/g, " "));
}

function parseTimestamp(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function compareNullableDesc(left: string | null, right: string | null): number {
  const a = parseTimestamp(left);
  const b = parseTimestamp(right);
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return b - a;
}

function compareLabels(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function breakdown(
  members: CompanyTeamMember[],
  toKey: (member: CompanyTeamMember) => string,
  toLabel: (member: CompanyTeamMember) => string,
): EmployeeBreakdownItem[] {
  const counts = new Map<string, EmployeeBreakdownItem>();

  for (const member of members) {
    const key = toKey(member);
    const current = counts.get(key);
    if (current) {
      current.count += 1;
      continue;
    }
    counts.set(key, { count: 1, key, label: toLabel(member), share: 0 });
  }

  const total = members.length || 1;

  return [...counts.values()]
    .map((item) => ({ ...item, share: item.count / total }))
    .sort((a, b) => b.count - a.count || compareLabels(a.label, b.label));
}

function buildEmployeeSearchText(member: CompanyTeamMember): string {
  return [
    employeeDisplayName(member),
    member.email,
    employeeRoleLabel(member),
    employeeDepartmentLabel(member),
    employeeStatusLabel(member.status),
    member.id,
  ]
    .filter(Boolean)
    .join(" ");
}

function compareMembers(
  left: CompanyTeamMember,
  right: CompanyTeamMember,
  sort: EmployeeDirectorySort,
): number {
  switch (sort) {
    case "first_login_desc":
      return (
        compareNullableDesc(left.first_login_at, right.first_login_at) ||
        compareLabels(employeeDisplayName(left), employeeDisplayName(right))
      );
    case "name_asc":
      return (
        compareLabels(employeeDisplayName(left), employeeDisplayName(right)) ||
        compareNullableDesc(employeeLastSeenAt(left), employeeLastSeenAt(right))
      );
    case "last_seen_desc":
    default:
      return (
        compareNullableDesc(employeeLastSeenAt(left), employeeLastSeenAt(right)) ||
        compareLabels(employeeDisplayName(left), employeeDisplayName(right))
      );
  }
}

export function employeeDisplayName(member: CompanyTeamMember): string {
  return member.display_name || member.email || member.id;
}

export function employeeInitials(member: CompanyTeamMember): string {
  const source = employeeDisplayName(member).replace(/@.*$/, "");
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] || ""}${parts[parts.length - 1][0] || ""}`.toUpperCase();
  }
  const compact = parts[0] || source || "U";
  return compact.slice(0, 2).toUpperCase();
}

export function employeeRoleLabel(member: CompanyTeamMember): string {
  return humanize(member.role, "Member");
}

export function employeeDepartmentKey(member: CompanyTeamMember): string {
  const trimmed = String(member.department_id || "").trim();
  return trimmed || UNASSIGNED_DEPARTMENT_KEY;
}

export function employeeDepartmentLabel(member: CompanyTeamMember): string {
  return employeeDepartmentKey(member) === UNASSIGNED_DEPARTMENT_KEY
    ? "Unassigned"
    : member.department_id.trim();
}

export function employeeStatusLabel(status: string): string {
  return humanize(status, "Unknown");
}

export function employeeStatusTone(status: string): EmployeeBadgeTone {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "active") {
    return "success";
  }
  if (normalized === "invited" || normalized === "pending" || normalized === "provisioning") {
    return "warning";
  }
  if (!normalized) {
    return "secondary";
  }
  return "outline";
}

export function employeeLastSeenAt(member: CompanyTeamMember): string | null {
  return member.last_login_at || member.first_login_at;
}

export function formatEmployeeTimestamp(value: string | null): string {
  if (!value) {
    return "Never";
  }
  const timestamp = parseTimestamp(value);
  if (timestamp === null) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function formatEmployeeRelativeTime(value: string | null): string {
  if (!value) {
    return "Never";
  }
  const timestamp = parseTimestamp(value);
  if (timestamp === null) {
    return "Unknown";
  }
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 60) {
    return "Just now";
  }
  if (deltaSeconds < 60 * 60) {
    return `${Math.floor(deltaSeconds / 60)}m ago`;
  }
  if (deltaSeconds < 60 * 60 * 24) {
    return `${Math.floor(deltaSeconds / (60 * 60))}h ago`;
  }
  if (deltaSeconds < 60 * 60 * 24 * 7) {
    return `${Math.floor(deltaSeconds / (60 * 60 * 24))}d ago`;
  }
  if (deltaSeconds < 60 * 60 * 24 * 30) {
    return `${Math.floor(deltaSeconds / (60 * 60 * 24 * 7))}w ago`;
  }
  if (deltaSeconds < 60 * 60 * 24 * 365) {
    return `${Math.floor(deltaSeconds / (60 * 60 * 24 * 30))}mo ago`;
  }
  return `${Math.floor(deltaSeconds / (60 * 60 * 24 * 365))}y ago`;
}

export function summarizeCompanyMembers(
  members: CompanyTeamMember[],
): EmployeeSummary {
  const active = members.filter(
    (member) => String(member.status || "").trim().toLowerCase() === "active",
  ).length;
  const withEmail = members.filter((member) => Boolean(member.email)).length;
  const recentCutoff = Date.now() - RECENT_ACTIVITY_DAYS * 24 * 60 * 60 * 1000;
  const recent = members.filter((member) => {
    const timestamp = parseTimestamp(employeeLastSeenAt(member));
    return timestamp !== null && timestamp >= recentCutoff;
  }).length;
  const departmentBreakdown = breakdown(
    members,
    employeeDepartmentKey,
    employeeDepartmentLabel,
  );
  const roleBreakdown = breakdown(
    members,
    (member) => employeeRoleLabel(member).toLowerCase(),
    employeeRoleLabel,
  );

  return {
    active,
    departmentBreakdown,
    departments: departmentBreakdown.filter(
      (item) => item.key !== UNASSIGNED_DEPARTMENT_KEY,
    ).length,
    inactive: members.length - active,
    missingEmail: members.length - withEmail,
    recent,
    recentMembers: [...members]
      .filter((member) => employeeLastSeenAt(member))
      .sort((a, b) => compareNullableDesc(employeeLastSeenAt(a), employeeLastSeenAt(b)))
      .slice(0, 5),
    roleBreakdown,
    total: members.length,
    withEmail,
  };
}

export function filterCompanyMembers(
  members: CompanyTeamMember[],
  filters: EmployeeDirectoryFilters,
): CompanyTeamMember[] {
  const trimmedQuery = filters.query.trim();
  const visible = members.filter((member) => {
    const status = String(member.status || "").trim().toLowerCase();
    if (filters.status === "active" && status !== "active") {
      return false;
    }
    if (filters.status === "inactive" && status === "active") {
      return false;
    }
    if (
      filters.department !== "all" &&
      employeeDepartmentKey(member) !== filters.department
    ) {
      return false;
    }
    return true;
  });

  if (!trimmedQuery) {
    return [...visible].sort((a, b) => compareMembers(a, b, filters.sort));
  }

  return fuzzyRank(visible, trimmedQuery, buildEmployeeSearchText)
    .sort((a, b) => b.score - a.score || compareMembers(a.item, b.item, filters.sort))
    .map((entry) => entry.item);
}
