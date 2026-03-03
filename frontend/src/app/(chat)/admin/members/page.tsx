"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/context/AuthContext";
import {
  api,
  ApiError,
  type MemberRecord,
  type MemberRoleAssignment,
  type RoleDto,
} from "@/lib/api";
import { denyMessage } from "@/lib/deny";
import { uiToast } from "@/lib/toast";

export default function AdminMembersPage() {
  const { token, refreshCapabilities } = useAuth();
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [assignments, setAssignments] = useState<Record<string, MemberRoleAssignment[]>>({});
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const getMemberId = (member: MemberRecord) =>
    member.member_id || member.id || member.user_id || member.user?.id || "";

  const getMemberName = (member: MemberRecord) => {
    const first = member.first_name || member.user?.first_name || "";
    const last = member.last_name || member.user?.last_name || "";
    return `${first} ${last}`.trim() || "Unknown member";
  };

  const getMemberEmail = (member: MemberRecord) =>
    member.email || member.user?.email || "No email";

  const load = async () => {
    if (!token) return;
    setLoading(true);
    setError(null);

    try {
      const [memberList, roleList] = await Promise.all([
        api.admin.members.list(token),
        api.rbac.roles.list(token),
      ]);

      setMembers(memberList);
      setRoles(roleList);

      const nextAssignments: Record<string, MemberRoleAssignment[]> = {};
      await Promise.all(
        memberList.map(async (member) => {
          const memberId = getMemberId(member);
          if (!memberId) return;
          try {
            nextAssignments[memberId] = await api.rbac.members.roles.get(token, memberId);
          } catch {
            nextAssignments[memberId] = [];
          }
        })
      );

      setAssignments(nextAssignments);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unable to connect";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter((member) =>
      `${member.first_name} ${member.last_name} ${member.email}`.toLowerCase().includes(q)
    );
  }, [members, search]);

  const assignRole = async (member: MemberRecord, roleId: string) => {
    if (!token) return;
    const memberId = getMemberId(member);
    if (!memberId || !roleId) return;

    const previous = assignments[memberId] || [];
    const next = [{ member_id: memberId, role_id: roleId, status: "active" }];
    setAssignments((prev) => ({ ...prev, [memberId]: next }));

    try {
      const updated = await api.rbac.members.roles.put(token, memberId, roleId, "active");
      const result = [{ member_id: updated.member_id, role_id: updated.role_id, status: updated.status }];
      setAssignments((prev) => ({ ...prev, [memberId]: result }));
      uiToast.success("Member role updated");
    } catch (error) {
      setAssignments((prev) => ({ ...prev, [memberId]: previous }));
      if (error instanceof ApiError && error.reasonCode) {
        uiToast.error(denyMessage(error.reasonCode));
      } else {
        uiToast.error(error instanceof Error ? error.message : "Unable to connect");
      }
      await refreshCapabilities();
    }
  };

  return (
    <div className="mx-auto w-full max-w-[980px] p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
          Member Role Assignment
        </h1>
        <Link href="/admin/audit" className="text-sm underline" style={{ color: "var(--text-secondary)" }}>
          View audit references
        </Link>
      </div>

      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        Assign roles per member and show backend-forbidden errors clearly.
      </p>

      <div className="mt-4 flex gap-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name or email"
          className="border"
          style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-surface)" }}
        />
        <Button variant="ghost" onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      <div
        className="mt-4 overflow-hidden rounded-xl border"
        style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}
      >
        <table className="w-full text-sm">
          <thead style={{ backgroundColor: "var(--bg-elevated)", color: "var(--text-secondary)" }}>
            <tr>
              <th className="px-4 py-3 text-left">Member</th>
              <th className="px-4 py-3 text-left">Assigned role</th>
              <th className="px-4 py-3 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-4" colSpan={3}>Loading members...</td>
              </tr>
            ) : error ? (
              <tr>
                <td className="px-4 py-4" colSpan={3} style={{ color: "var(--error)" }}>
                  {error}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td className="px-4 py-4" colSpan={3} style={{ color: "var(--text-secondary)" }}>
                  No members found
                </td>
              </tr>
            ) : (
              filtered.map((member, index) => {
                const memberId = getMemberId(member);
                const rowKey = `${memberId || getMemberEmail(member)}-${index}`;
                const assignment = assignments[memberId]?.[0];

                return (
                  <tr key={rowKey} className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                    <td className="px-4 py-3">
                      <p style={{ color: "var(--text-primary)" }}>
                        {getMemberName(member)}
                      </p>
                      <p style={{ color: "var(--text-tertiary)" }}>{getMemberEmail(member)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        className="rounded-md border px-2 py-1"
                        value={assignment?.role_id || ""}
                        onChange={(event) => void assignRole(member, event.target.value)}
                        style={{
                          borderColor: "var(--border-default)",
                          backgroundColor: "var(--bg-elevated)",
                          color: "var(--text-primary)",
                        }}
                      >
                        <option value="" disabled>
                          Select role
                        </option>
                        {roles.map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">{assignment?.status || member.status || "active"}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
