import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  Building2,
  Clock3,
  Mail,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { Toast } from "@nous-research/ui/ui/components/toast";
import { useToast } from "@nous-research/ui/hooks/use-toast";
import { usePageHeader } from "@/contexts/usePageHeader";
import { api } from "@/lib/api";
import type { CompanyTeamMember } from "@/lib/api";
import { cn, themedBody } from "@/lib/utils";

function formatTimestamp(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function memberLabel(member: CompanyTeamMember): string {
  return member.display_name || member.email || member.id;
}

export default function TeamMembersPage() {
  const [companyId, setCompanyId] = useState("");
  const [members, setMembers] = useState<CompanyTeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { toast, showToast } = useToast();
  const { setEnd } = usePageHeader();

  const load = useCallback(async (soft = false) => {
    if (soft) setRefreshing(true);
    try {
      const response = await api.getCompanyTeamMembers();
      setCompanyId(response.company_id);
      setMembers(response.members);
    } catch (error) {
      showToast(`Failed to load team members: ${error}`, "error");
    } finally {
      if (soft) setRefreshing(false);
    }
  }, [showToast]);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  useLayoutEffect(() => {
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
    return () => setEnd(null);
  }, [load, refreshing, setEnd]);

  const stats = useMemo(() => {
    const active = members.filter((member) => member.status === "active").length;
    const withEmail = members.filter((member) => member.email).length;
    return {
      total: members.length,
      active,
      withEmail,
    };
  }, [members]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="text-2xl text-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Toast toast={toast} />

      <div className={cn(themedBody, "grid gap-4 md:grid-cols-3")}>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Users className="h-5 w-5 text-primary" />
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Team members
              </div>
              <div className="text-2xl font-semibold">{stats.total}</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Active
              </div>
              <div className="text-2xl font-semibold">{stats.active}</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Mail className="h-5 w-5 text-primary" />
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                With email
              </div>
              <div className="text-2xl font-semibold">{stats.withEmail}</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 p-4 sm:p-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                Employee directory
              </div>
              <div className="mt-1 text-lg font-semibold">Company team members</div>
            </div>
            <div className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-muted-foreground">
              <Building2 className="h-4 w-4" />
              <span>{companyId || "company_default"}</span>
            </div>
          </div>

          {members.length === 0 ? (
            <div className="rounded border border-dashed border-border/70 px-4 py-10 text-center text-sm text-muted-foreground">
              Team members will appear here after their first successful login.
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {members.map((member) => (
                <div
                  key={member.id}
                  className="grid gap-3 py-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_auto]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">
                      {memberLabel(member)}
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {member.email || "No email exposed by provider"}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge tone={member.status === "active" ? "success" : "outline"}>
                      {member.status}
                    </Badge>
                    <Badge tone="outline">{member.role || "MEMBER"}</Badge>
                    {member.department_id ? (
                      <Badge tone="outline">{member.department_id}</Badge>
                    ) : null}
                  </div>

                  <div className="flex flex-col items-start gap-1 text-xs text-muted-foreground md:items-end">
                    <div className="inline-flex items-center gap-1.5">
                      <Clock3 className="h-3.5 w-3.5" />
                      <span>First login {formatTimestamp(member.first_login_at)}</span>
                    </div>
                    <div>Last seen {formatTimestamp(member.last_login_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
