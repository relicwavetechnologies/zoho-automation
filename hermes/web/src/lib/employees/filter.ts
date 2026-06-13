import { fuzzyRank } from "@/lib/fuzzy";
import {
  employeeDepartmentKey,
  employeeDepartmentLabel,
  employeeDisplayName,
  employeeLastSeenAt,
  employeeRoleKey,
  employeeRoleLabel,
  employeeStatusLabel,
  RECENT_ACTIVITY_DAYS,
  UNASSIGNED_DEPARTMENT_KEY,
} from "./display";
import type {
  EmployeeBreakdownItem,
  EmployeeFilterState,
  EmployeeRow,
  EmployeeSummary,
} from "./types";

export { UNASSIGNED_DEPARTMENT_KEY, employeeDepartmentKey } from "./display";

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
  members: EmployeeRow[],
  toKey: (member: EmployeeRow) => string,
  toLabel: (member: EmployeeRow) => string,
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

function buildEmployeeSearchText(member: EmployeeRow): string {
  return [
    employeeDisplayName(member),
    member.email,
    employeeRoleLabel(member),
    employeeDepartmentLabel(member),
    employeeStatusLabel(member.status),
    member.lark_open_id,
    member.lark_union_id,
    member.lark_user_id,
    member.id,
  ]
    .filter(Boolean)
    .join(" ");
}

function compareMembers(
  left: EmployeeRow,
  right: EmployeeRow,
  sort: EmployeeFilterState["sort"],
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

function matchesStatusFilter(member: EmployeeRow, status: string): boolean {
  if (status === "all") {
    return true;
  }
  const normalized = String(member.status || "").trim().toLowerCase();
  if (status === "active") {
    return normalized === "active";
  }
  if (status === "disabled") {
    return normalized === "disabled" || normalized === "inactive";
  }
  if (status === "invited") {
    return (
      normalized === "invited" ||
      normalized === "pending" ||
      normalized === "provisioning"
    );
  }
  return normalized === status.toLowerCase();
}

export function summarizeEmployees(members: EmployeeRow[]): EmployeeSummary {
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
  const roleBreakdown = breakdown(members, employeeRoleKey, employeeRoleLabel);

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
      .sort((a, b) =>
        compareNullableDesc(employeeLastSeenAt(a), employeeLastSeenAt(b)),
      )
      .slice(0, 5),
    roleBreakdown,
    total: members.length,
    withEmail,
  };
}

export function filterEmployees(
  members: EmployeeRow[],
  filters: EmployeeFilterState,
): EmployeeRow[] {
  const trimmedQuery = filters.query.trim();
  const visible = members.filter((member) => {
    if (!matchesStatusFilter(member, filters.status)) {
      return false;
    }
    if (filters.role !== "all" && employeeRoleKey(member) !== filters.role) {
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
    .sort(
      (a, b) =>
        b.score - a.score || compareMembers(a.item, b.item, filters.sort),
    )
    .map((entry) => entry.item);
}

export function collectRoleOptions(members: EmployeeRow[]): string[] {
  const roles = new Set<string>();
  for (const member of members) {
    roles.add(employeeRoleKey(member));
  }
  return [...roles].sort((a, b) => a.localeCompare(b));
}
