export type EmployeeStatus = "active" | "disabled" | "invited" | string;
export type EmployeeRole = "MEMBER" | "COMPANY_ADMIN" | "SUPER_ADMIN" | string;

export interface EmployeeRow {
  id: string;
  company_id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  lark_open_id: string | null;
  lark_union_id: string | null;
  lark_user_id: string | null;
  department_id: string | null;
  department_name: string | null;
  role: EmployeeRole;
  status: EmployeeStatus;
  first_login_at: string | null;
  last_login_at: string | null;
  provider: "lark" | string;
}

export interface EmployeesListResponse {
  company_id: string;
  members: EmployeeRow[];
}

export interface EmployeeFilters {
  query: string;
  department: string;
  role: string;
  status: string;
}

export type EmployeeDirectorySort =
  | "first_login_desc"
  | "last_seen_desc"
  | "name_asc";

export interface EmployeeFilterState extends EmployeeFilters {
  sort: EmployeeDirectorySort;
}

export type EmployeeBadgeTone =
  | "destructive"
  | "outline"
  | "secondary"
  | "success"
  | "warning";

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
  recentMembers: EmployeeRow[];
  roleBreakdown: EmployeeBreakdownItem[];
  total: number;
  withEmail: number;
}
