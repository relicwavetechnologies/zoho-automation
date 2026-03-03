"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/context/AuthContext";
import { api, type MemberRecord } from "@/lib/api";
import { uiToast } from "@/lib/toast";

const ROLE_OPTIONS = ["owner", "admin", "manager", "member", "viewer"];
const STATUS_OPTIONS = ["active", "suspended", "invited", "disabled"];

export default function AdminMembersPage() {
  const { token } = useAuth();
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      setMembers(await api.admin.members.list(token));
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
      `${member.first_name} ${member.last_name} ${member.email} ${member.role_key}`.toLowerCase().includes(q)
    );
  }, [members, search]);

  const updateMember = async (userId: string, payload: { role_key?: string; status?: string }) => {
    if (!token) return;
    try {
      const updated = await api.admin.members.update(token, userId, payload);
      setMembers((prev) => prev.map((item) => (item.user_id === userId ? updated : item)));
      uiToast.success("Member updated");
    } catch (err) {
      uiToast.error(err instanceof Error ? err.message : "Unable to connect");
    }
  };

  return (
    <div className="mx-auto w-full max-w-[980px] p-6">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Members
      </h1>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        Search members and update role/status.
      </p>

      <div className="mt-4 flex gap-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name, email, role"
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
              <th className="px-4 py-3 text-left">Role</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-4" colSpan={4} style={{ color: "var(--text-secondary)" }}>
                  Loading members...
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td className="px-4 py-4" colSpan={4} style={{ color: "var(--error)" }}>
                  {error}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td className="px-4 py-4" colSpan={4} style={{ color: "var(--text-secondary)" }}>
                  No members found
                </td>
              </tr>
            ) : (
              filtered.map((member) => (
                <tr key={member.user_id} className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                  <td className="px-4 py-3">
                    <p style={{ color: "var(--text-primary)" }}>
                      {member.first_name} {member.last_name}
                    </p>
                    <p style={{ color: "var(--text-tertiary)" }}>{member.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      className="rounded-md border px-2 py-1"
                      value={member.role_key}
                      onChange={(event) => void updateMember(member.user_id, { role_key: event.target.value })}
                      style={{
                        borderColor: "var(--border-default)",
                        backgroundColor: "var(--bg-elevated)",
                        color: "var(--text-primary)",
                      }}
                    >
                      {ROLE_OPTIONS.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      className="rounded-md border px-2 py-1"
                      value={member.status}
                      onChange={(event) => void updateMember(member.user_id, { status: event.target.value })}
                      style={{
                        borderColor: "var(--border-default)",
                        backgroundColor: "var(--bg-elevated)",
                        color: "var(--text-primary)",
                      }}
                    >
                      {STATUS_OPTIONS.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <Button variant="ghost" onClick={() => void updateMember(member.user_id, {})}>
                      Sync
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
