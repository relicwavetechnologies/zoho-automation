"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import ApprovalConfirmDialog from "@/components/shared/ApprovalConfirmDialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthContext";
import { api, type RoleDto, type ToolPermissionDto } from "@/lib/api";
import { denyMessage } from "@/lib/deny";
import { uiToast } from "@/lib/toast";

export default function AdminToolsPage() {
  const { token, refreshCapabilities } = useAuth();
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [roleId, setRoleId] = useState("");
  const [permissions, setPermissions] = useState<ToolPermissionDto[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;

    const loadRoles = async () => {
      try {
        const list = await api.rbac.roles.list(token);
        setRoles(list);
        if (list[0]) setRoleId(list[0].id);
      } catch (error) {
        uiToast.error(error instanceof Error ? error.message : "Unable to connect");
      }
    };

    void loadRoles();
  }, [token]);

  const loadPermissions = async () => {
    if (!token || !roleId) return;
    setLoading(true);
    try {
      setPermissions(await api.rbac.rolePermissions.list(token, roleId));
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPermissions();
  }, [token, roleId]);

  const persistPermissions = async (nextPermissions: ToolPermissionDto[]) => {
    if (!token || !roleId) return;

    const previous = permissions;
    setPermissions(nextPermissions);

    try {
      const updated = await api.rbac.rolePermissions.replace(token, roleId, nextPermissions);
      setPermissions(updated);
      uiToast.success("Permissions updated");
    } catch (error) {
      setPermissions(previous);
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
      await refreshCapabilities();
    }
  };

  const sorted = useMemo(
    () => permissions.slice().sort((a, b) => a.tool_key.localeCompare(b.tool_key)),
    [permissions]
  );

  return (
    <div className="mx-auto w-full max-w-[980px] p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
          Permissions Matrix
        </h1>
        <Link href="/admin/audit" className="text-sm underline" style={{ color: "var(--text-secondary)" }}>
          View audit references
        </Link>
      </div>

      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        Toggle can_execute and requires_approval with optimistic updates + rollback.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <span style={{ color: "var(--text-secondary)" }}>Role:</span>
        <select
          value={roleId}
          onChange={(event) => setRoleId(event.target.value)}
          className="h-9 rounded-md border px-2"
          style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-surface)", color: "var(--text-primary)" }}
        >
          {roles.map((role) => (
            <option key={role.id} value={role.id}>{role.name}</option>
          ))}
        </select>
        <Button variant="ghost" onClick={() => void loadPermissions()}>Refresh</Button>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}>
        <table className="w-full text-sm">
          <thead style={{ backgroundColor: "var(--bg-elevated)", color: "var(--text-secondary)" }}>
            <tr>
              <th className="px-4 py-3 text-left">Tool</th>
              <th className="px-4 py-3 text-left">Can execute</th>
              <th className="px-4 py-3 text-left">Requires approval</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td className="px-4 py-4" colSpan={3}>Loading permissions...</td></tr>
            ) : sorted.map((perm) => (
              <tr key={perm.tool_key} className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                <td className="px-4 py-3">{perm.tool_key}</td>
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={perm.can_execute}
                    onChange={() => {
                      const next = sorted.map((item) =>
                        item.tool_key === perm.tool_key
                          ? { ...item, can_execute: !item.can_execute }
                          : item
                      );
                      void persistPermissions(next);
                    }}
                  />
                </td>
                <td className="px-4 py-3">
                  <ApprovalConfirmDialog
                    title="Change approval requirement"
                    description={`Update approval policy for ${perm.tool_key}`}
                    onConfirm={async () => {
                      const next = sorted.map((item) =>
                        item.tool_key === perm.tool_key
                          ? { ...item, requires_approval: !item.requires_approval }
                          : item
                      );
                      await persistPermissions(next);
                    }}
                  >
                    <Button variant="ghost">{perm.requires_approval ? "Required" : "Not required"}</Button>
                  </ApprovalConfirmDialog>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs" style={{ color: "var(--text-tertiary)" }}>
        Denied updates fallback to previous values ({denyMessage("policy_conflict")}).
      </p>
    </div>
  );
}
