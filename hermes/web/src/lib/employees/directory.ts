/**
 * @deprecated Import from `@/lib/employees` instead.
 * Kept for backward compatibility during the Employees page migration.
 */
import type { CompanyTeamMember } from "@/lib/api";
import { mapApiMemberToEmployee } from "./map";
import { filterEmployees, summarizeEmployees } from "./filter";
import type { EmployeeDirectorySort, EmployeeFilterState } from "./types";

export {
  RECENT_ACTIVITY_DAYS,
  employeeDepartmentKey,
  employeeDepartmentLabel,
  employeeDisplayName,
  employeeInitials,
  employeeLastSeenAt,
  employeeRoleLabel,
  employeeStatusLabel,
  employeeStatusTone,
  formatEmployeeRelativeTime,
  formatEmployeeTimestamp,
} from "./display";
export type {
  EmployeeBadgeTone,
  EmployeeBreakdownItem,
  EmployeeDirectorySort,
  EmployeeSummary,
} from "./types";

export type EmployeeStatusFilter = "active" | "all" | "inactive";

export interface EmployeeDirectoryFilters {
  department: string;
  query: string;
  sort: EmployeeDirectorySort;
  status: EmployeeStatusFilter;
}

export function summarizeCompanyMembers(members: CompanyTeamMember[]) {
  return summarizeEmployees(members.map(mapApiMemberToEmployee));
}

export function filterCompanyMembers(
  members: CompanyTeamMember[],
  filters: EmployeeDirectoryFilters,
) {
  const status =
    filters.status === "inactive" ? "disabled" : filters.status;
  const filterState: EmployeeFilterState = {
    ...filters,
    role: "all",
    status,
  };
  return filterEmployees(
    members.map(mapApiMemberToEmployee),
    filterState,
  ).map((row) => ({
    id: row.id,
    company_id: row.company_id,
    email: row.email || "",
    display_name: row.display_name,
    role: row.role,
    department_id: row.department_id || "",
    status: row.status,
    first_login_at: row.first_login_at,
    last_login_at: row.last_login_at,
  }));
}
