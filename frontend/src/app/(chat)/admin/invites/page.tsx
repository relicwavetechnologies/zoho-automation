"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/context/AuthContext";
import { api, type InviteRecord } from "@/lib/api";
import { uiToast } from "@/lib/toast";

const ROLE_OPTIONS = ["manager", "member", "viewer"];

export default function AdminInvitesPage() {
  const { token } = useAuth();
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState("member");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      setInvites(await api.invites.list(token));
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token]);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return invites;
    return invites.filter((item) => item.status === statusFilter);
  }, [invites, statusFilter]);

  const onCreateInvite = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || !email.trim()) return;

    setSubmitting(true);
    try {
      await api.invites.create(token, { email: email.trim(), role_key: roleKey });
      setEmail("");
      uiToast.success("Invite created");
      await load();
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    } finally {
      setSubmitting(false);
    }
  };

  const revokeInvite = async (inviteId: string) => {
    if (!token) return;
    try {
      await api.invites.revoke(token, inviteId);
      uiToast.success("Invite revoked");
      await load();
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    }
  };

  const resendInvite = async (inviteId: string) => {
    if (!token) return;
    try {
      await api.invites.resend(token, inviteId);
      uiToast.success("Invite resent");
      await load();
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    }
  };

  return (
    <div className="mx-auto w-full max-w-[980px] p-6">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Invites
      </h1>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        Invite members and manage invite lifecycle.
      </p>

      <form
        onSubmit={onCreateInvite}
        className="mt-4 grid grid-cols-1 gap-3 rounded-xl border p-4 md:grid-cols-[1fr_160px_120px]"
        style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}
      >
        <div className="space-y-2">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="member@company.com"
            className="border"
            style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-elevated)" }}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="invite-role">Role</Label>
          <select
            id="invite-role"
            value={roleKey}
            onChange={(event) => setRoleKey(event.target.value)}
            className="h-9 rounded-md border px-2"
            style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-elevated)", color: "var(--text-primary)" }}
          >
            {ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-end">
          <Button type="submit" disabled={submitting} style={{ backgroundColor: "var(--accent)", color: "#fff" }}>
            {submitting ? "Sending..." : "Send invite"}
          </Button>
        </div>
      </form>

      <div className="mt-4 flex items-center gap-2">
        <Label htmlFor="invite-status">Filter</Label>
        <select
          id="invite-status"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          className="h-9 rounded-md border px-2"
          style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-surface)", color: "var(--text-primary)" }}
        >
          <option value="all">All</option>
          <option value="pending">Pending</option>
          <option value="accepted">Accepted</option>
          <option value="expired">Expired</option>
          <option value="revoked">Revoked</option>
        </select>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}>
        <table className="w-full text-sm">
          <thead style={{ backgroundColor: "var(--bg-elevated)", color: "var(--text-secondary)" }}>
            <tr>
              <th className="px-4 py-3 text-left">Email</th>
              <th className="px-4 py-3 text-left">Role</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Expires</th>
              <th className="px-4 py-3 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td className="px-4 py-4" colSpan={5}>Loading invites...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td className="px-4 py-4" colSpan={5}>No invites</td></tr>
            ) : (
              filtered.map((invite) => (
                <tr key={invite.invite_id} className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                  <td className="px-4 py-3">{invite.email}</td>
                  <td className="px-4 py-3">{invite.role_key}</td>
                  <td className="px-4 py-3">{invite.status}</td>
                  <td className="px-4 py-3">{new Date(invite.expires_at).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      <Button variant="ghost" onClick={() => void resendInvite(invite.invite_id)} disabled={invite.status !== "pending"}>
                        Resend
                      </Button>
                      <Button variant="ghost" onClick={() => void revokeInvite(invite.invite_id)} disabled={invite.status !== "pending"}>
                        Revoke
                      </Button>
                    </div>
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
