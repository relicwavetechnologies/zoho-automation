import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  Building2,
  Clock3,
  Mail,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Input } from "@nous-research/ui/ui/components/input";
import { Label } from "@nous-research/ui/ui/components/label";
import {
  Select,
  SelectOption,
} from "@nous-research/ui/ui/components/select";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { usePageHeader } from "@/contexts/usePageHeader";
import { api } from "@/lib/api";
import type { CompanyTeamMember } from "@/lib/api";
import {
  employeeDepartmentLabel,
  employeeDisplayName,
  employeeInitials,
  employeeLastSeenAt,
  employeeRoleLabel,
  employeeStatusLabel,
  employeeStatusTone,
  filterCompanyMembers,
  formatEmployeeRelativeTime,
  formatEmployeeTimestamp,
  RECENT_ACTIVITY_DAYS,
  summarizeCompanyMembers,
  type EmployeeBreakdownItem,
  type EmployeeDirectorySort,
  type EmployeeStatusFilter,
} from "@/lib/employees/directory";
import { cn, themedBody } from "@/lib/utils";

const SORT_OPTIONS: Array<{ label: string; value: EmployeeDirectorySort }> = [
  { label: "Recent activity", value: "last_seen_desc" },
  { label: "First login", value: "first_login_desc" },
  { label: "Name A–Z", value: "name_asc" },
];

function formatRefreshTime(value: string | null): string {
  if (!value) {
    return "Not refreshed yet";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function MetricCard({
  detail,
  icon: Icon,
  label,
  value,
}: {
  detail: string;
  icon: typeof Users;
  label: string;
  value: number;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <div className="mt-0.5 rounded-full border border-current/10 bg-background-base/40 p-2 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
            {label}
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
          <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function BreakdownRow({
  item,
  total,
}: {
  item: EmployeeBreakdownItem;
  total: number;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="truncate text-foreground">{item.label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {item.count}/{total}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-background-base/50">
        <div
          className="h-full rounded-full bg-primary/80"
          style={{ width: `${Math.max(item.share * 100, item.count > 0 ? 8 : 0)}%` }}
        />
      </div>
    </div>
  );
}

function RecentActivityRow({ member }: { member: CompanyTeamMember }) {
  const lastSeen = employeeLastSeenAt(member);

  return (
    <div className="flex items-center gap-3 rounded border border-border/60 bg-background-base/30 px-3 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-current/10 bg-background-base/60 text-xs font-semibold text-midground">
        {employeeInitials(member)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">
          {employeeDisplayName(member)}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {member.email || "No email exposed by provider"}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-xs font-medium text-foreground">
          {formatEmployeeRelativeTime(lastSeen)}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {formatEmployeeTimestamp(lastSeen)}
        </div>
      </div>
    </div>
  );
}

export default function TeamMembersPage() {
  const [companyId, setCompanyId] = useState("");
  const [members, setMembers] = useState<CompanyTeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<EmployeeStatusFilter>("all");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [sort, setSort] = useState<EmployeeDirectorySort>("last_seen_desc");
  const { toast, showToast } = useToast();
  const { setAfterTitle, setEnd, setTitle } = usePageHeader();

  const load = useCallback(
    async (soft = false) => {
      if (soft) {
        setRefreshing(true);
      }
      setLoadError(null);
      try {
        const response = await api.getCompanyTeamMembers();
        setCompanyId(response.company_id || "company_default");
        setMembers(response.members);
        setLastLoadedAt(new Date().toISOString());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLoadError(message);
        showToast(`Failed to load employees: ${message}`, "error");
      } finally {
        if (soft) {
          setRefreshing(false);
        }
      }
    },
    [showToast],
  );

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      await load();
      if (!cancelled) {
        setLoading(false);
      }
    }

    void boot();

    return () => {
      cancelled = true;
    };
  }, [load]);

  const summary = useMemo(() => summarizeCompanyMembers(members), [members]);

  const visibleMembers = useMemo(
    () =>
      filterCompanyMembers(members, {
        department: departmentFilter,
        query,
        sort,
        status: statusFilter,
      }),
    [departmentFilter, members, query, sort, statusFilter],
  );

  const topDepartments = useMemo(
    () => summary.departmentBreakdown.slice(0, 5),
    [summary.departmentBreakdown],
  );
  const topRoles = useMemo(
    () => summary.roleBreakdown.slice(0, 4),
    [summary.roleBreakdown],
  );

  const filtersActive =
    query.trim().length > 0 || statusFilter !== "all" || departmentFilter !== "all";

  useLayoutEffect(() => {
    setTitle("Employees");
    setAfterTitle(
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="secondary" className="text-xs">
          {companyId || "company_default"}
        </Badge>
        <Badge tone="outline" className="text-xs tabular-nums">
          {visibleMembers.length} shown
        </Badge>
      </div>,
    );
    setEnd(
      <Button
        className="uppercase"
        size="sm"
        onClick={() => void load(true)}
        disabled={refreshing}
        prefix={refreshing ? <Spinner /> : <RefreshCw className="h-4 w-4" />}
      >
        {refreshing ? "Refreshing..." : "Refresh"}
      </Button>,
    );
    return () => {
      setTitle(null);
      setAfterTitle(null);
      setEnd(null);
    };
  }, [
    companyId,
    load,
    refreshing,
    setAfterTitle,
    setEnd,
    setTitle,
    visibleMembers.length,
  ]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="text-2xl text-primary" />
      </div>
    );
  }

  const departmentOptions = summary.departmentBreakdown;

  return (
    <div className="flex flex-col gap-6">
      <Toast toast={toast} />

      {loadError && members.length === 0 ? (
        <Card className="border-destructive/40">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">
                Employees could not be loaded
              </div>
              <div className="mt-1 text-sm text-muted-foreground">{loadError}</div>
            </div>
            <Button
              className="uppercase shrink-0"
              size="sm"
              onClick={() => void load(true)}
              disabled={refreshing}
              prefix={refreshing ? <Spinner /> : <RefreshCw className="h-4 w-4" />}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className={cn(themedBody, "grid gap-4 md:grid-cols-2 xl:grid-cols-4")}>
        <MetricCard
          detail={`${summary.withEmail} with email on file`}
          icon={Users}
          label="Employees"
          value={summary.total}
        />
        <MetricCard
          detail={`${summary.inactive} inactive or pending`}
          icon={ShieldCheck}
          label="Active"
          value={summary.active}
        />
        <MetricCard
          detail={`Seen in the last ${RECENT_ACTIVITY_DAYS} days`}
          icon={Clock3}
          label="Recent activity"
          value={summary.recent}
        />
        <MetricCard
          detail={
            summary.departments > 0
              ? `${summary.departmentBreakdown[0]?.label || "Unassigned"} is the largest group`
              : "Department ids will appear after employees log in"
          }
          icon={Building2}
          label="Departments"
          value={summary.departments}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader className="gap-3">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                  Employee directory
                </div>
                <CardTitle className="mt-1 text-lg">Employees</CardTitle>
                <div className="mt-1 text-sm text-muted-foreground">
                  Search, filter, and review the people who have signed into this Hermes company workspace.
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge tone="outline" className="gap-1">
                  <Building2 className="h-3.5 w-3.5" />
                  {companyId || "company_default"}
                </Badge>
                <Badge tone="secondary" className="gap-1">
                  <Clock3 className="h-3.5 w-3.5" />
                  Updated {formatRefreshTime(lastLoadedAt)}
                </Badge>
              </div>
            </div>
          </CardHeader>

          <CardContent className="flex flex-col gap-4 p-4 sm:p-5">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_180px_200px_180px]">
              <div className="grid gap-1.5">
                <Label htmlFor="employee-search">Search</Label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="employee-search"
                    className="pl-9"
                    placeholder="Name, email, role, or department"
                    spellCheck={false}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="employee-status-filter">Status</Label>
                <Select
                  id="employee-status-filter"
                  value={statusFilter}
                  onValueChange={(value) => setStatusFilter(value as EmployeeStatusFilter)}
                >
                  <SelectOption value="all">All statuses</SelectOption>
                  <SelectOption value="active">Active</SelectOption>
                  <SelectOption value="inactive">Inactive or pending</SelectOption>
                </Select>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="employee-department-filter">Department</Label>
                <Select
                  id="employee-department-filter"
                  value={departmentFilter}
                  onValueChange={setDepartmentFilter}
                >
                  <SelectOption value="all">All departments</SelectOption>
                  {departmentOptions.map((item) => (
                    <SelectOption key={item.key} value={item.key}>
                      {item.label}
                    </SelectOption>
                  ))}
                </Select>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="employee-sort">Sort by</Label>
                <Select
                  id="employee-sort"
                  value={sort}
                  onValueChange={(value) => setSort(value as EmployeeDirectorySort)}
                >
                  {SORT_OPTIONS.map((option) => (
                    <SelectOption key={option.value} value={option.value}>
                      {option.label}
                    </SelectOption>
                  ))}
                </Select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge tone="outline" className="tabular-nums">
                {visibleMembers.length} of {summary.total} employees
              </Badge>
              <Badge tone="secondary" className="tabular-nums">
                {summary.missingEmail} without email
              </Badge>
              {filtersActive ? (
                <Button
                  ghost
                  size="sm"
                  className="h-auto px-2 py-1 text-xs uppercase"
                  onClick={() => {
                    setQuery("");
                    setStatusFilter("all");
                    setDepartmentFilter("all");
                    setSort("last_seen_desc");
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
            </div>

            {visibleMembers.length === 0 ? (
              <div className="rounded border border-dashed border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
                {summary.total === 0
                  ? "Employees will appear here after their first successful login."
                  : "No employees match the current filters."}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className={cn(themedBody, "w-full min-w-[880px] text-sm")}>
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-[0.14em] text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Employee</th>
                      <th className="px-4 py-2 font-medium">Access</th>
                      <th className="px-4 py-2 font-medium">Department</th>
                      <th className="px-4 py-2 font-medium">First login</th>
                      <th className="py-2 pl-4 font-medium">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleMembers.map((member) => {
                      const firstLogin = member.first_login_at;
                      const lastSeen = employeeLastSeenAt(member);

                      return (
                        <tr
                          key={member.id}
                          className="border-b border-border/50 transition-colors hover:bg-secondary/20"
                        >
                          <td className="py-3 pr-4 align-top">
                            <div className="flex items-center gap-3">
                              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-current/10 bg-background-base/40 text-xs font-semibold text-midground">
                                {employeeInitials(member)}
                              </div>
                              <div className="min-w-0">
                                <div className="truncate font-semibold">
                                  {employeeDisplayName(member)}
                                </div>
                                <div className="mt-1 truncate text-xs text-muted-foreground">
                                  {member.email || "No email exposed by provider"}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge tone={employeeStatusTone(member.status)}>
                                {employeeStatusLabel(member.status)}
                              </Badge>
                              <Badge tone="outline">
                                {employeeRoleLabel(member)}
                              </Badge>
                            </div>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <Badge
                              tone={member.department_id ? "outline" : "secondary"}
                              className="max-w-full truncate"
                            >
                              {employeeDepartmentLabel(member)}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <div className="text-sm font-medium">
                              {formatEmployeeRelativeTime(firstLogin)}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {formatEmployeeTimestamp(firstLogin)}
                            </div>
                          </td>
                          <td className="py-3 pl-4 align-top">
                            <div className="text-sm font-medium">
                              {formatEmployeeRelativeTime(lastSeen)}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {formatEmployeeTimestamp(lastSeen)}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="gap-2">
              <div className="flex items-center gap-2">
                <BadgeCheck className="h-4 w-4 text-primary" />
                <CardTitle className="text-base">Directory breakdown</CardTitle>
              </div>
              <div className="text-sm text-muted-foreground">
                Department and role distribution from the current employee roster.
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-5 p-4">
              <div className="space-y-3">
                <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  Departments
                </div>
                {topDepartments.length > 0 ? (
                  <div className="space-y-3">
                    {topDepartments.map((item) => (
                      <BreakdownRow key={item.key} item={item} total={summary.total} />
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    Department ids will appear here once employees log in with provider metadata.
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                  Roles
                </div>
                {topRoles.length > 0 ? (
                  <div className="space-y-3">
                    {topRoles.map((item) => (
                      <BreakdownRow key={item.key} item={item} total={summary.total} />
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    Role labels will appear here after the first employee login.
                  </div>
                )}
              </div>

              <div className="rounded border border-border/60 bg-background-base/30 px-3 py-3 text-xs text-muted-foreground">
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2">
                    <Mail className="h-3.5 w-3.5" />
                    Email coverage
                  </span>
                  <span className="tabular-nums">
                    {summary.withEmail}/{summary.total}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background-base/60">
                  <div
                    className="h-full rounded-full bg-primary/80"
                    style={{
                      width: `${summary.total > 0 ? (summary.withEmail / summary.total) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="gap-2">
              <div className="flex items-center gap-2">
                <Clock3 className="h-4 w-4 text-primary" />
                <CardTitle className="text-base">Recent sign-ins</CardTitle>
              </div>
              <div className="text-sm text-muted-foreground">
                The most recently active employees across this Hermes company workspace.
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 p-4">
              {summary.recentMembers.length > 0 ? (
                summary.recentMembers.map((member) => (
                  <RecentActivityRow key={member.id} member={member} />
                ))
              ) : (
                <div className="rounded border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
                  Recent sign-ins will appear after employees start using the company workspace.
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
