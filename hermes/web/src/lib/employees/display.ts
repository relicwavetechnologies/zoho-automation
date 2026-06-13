import type { EmployeeBadgeTone, EmployeeRow } from "./types";

export const RECENT_ACTIVITY_DAYS = 7;
export const UNASSIGNED_DEPARTMENT_KEY = "__employees_unassigned_department__";

export function employeeDepartmentKey(member: EmployeeRow): string {
  const trimmed = String(member.department_id || "").trim();
  return trimmed || UNASSIGNED_DEPARTMENT_KEY;
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

export function employeeDisplayName(member: EmployeeRow): string {
  return member.display_name || member.email || member.id;
}

export function employeeInitials(member: EmployeeRow): string {
  const source = employeeDisplayName(member).replace(/@.*$/, "");
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] || ""}${parts[parts.length - 1][0] || ""}`.toUpperCase();
  }
  const compact = parts[0] || source || "U";
  return compact.slice(0, 2).toUpperCase();
}

export function employeeRoleLabel(member: EmployeeRow): string {
  return humanize(member.role, "Member");
}

export function employeeRoleKey(member: EmployeeRow): string {
  return String(member.role || "MEMBER").trim().toUpperCase() || "MEMBER";
}

export function employeeDepartmentLabel(member: EmployeeRow): string {
  const key = employeeDepartmentKey(member);
  if (key === "__employees_unassigned_department__") {
    return "Unassigned";
  }
  return member.department_name?.trim() || member.department_id?.trim() || "Unassigned";
}

export function employeeStatusLabel(status: string): string {
  return humanize(status, "Unknown");
}

export function employeeStatusTone(status: string): EmployeeBadgeTone {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "active") {
    return "success";
  }
  if (normalized === "disabled" || normalized === "inactive") {
    return "destructive";
  }
  if (normalized === "invited" || normalized === "pending" || normalized === "provisioning") {
    return "warning";
  }
  if (!normalized) {
    return "secondary";
  }
  return "outline";
}

export function employeeLastSeenAt(member: EmployeeRow): string | null {
  return member.last_login_at || member.first_login_at;
}

export function formatEmployeeTimestamp(value: string | null): string {
  if (!value) {
    return "Never";
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
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
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
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

export function formatLarkId(value: string | null): string {
  return value?.trim() || "—";
}
