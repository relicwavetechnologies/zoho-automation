"use client";

import { useEffect, useMemo, useState } from "react";

import ApprovalConfirmDialog from "@/components/shared/ApprovalConfirmDialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/AuthContext";
import { api, type RoleDto, type ToolPermissionDto } from "@/lib/api";
import { uiToast } from "@/lib/toast";

export default function AdminToolsPage() {
  const { token } = useAuth();
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [roleKey, setRoleKey] = useState("");
  const [permissions, setPermissions] = useState<ToolPermissionDto[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;

    const loadRoles = async () => {
      try {
        const list = await api.admin.roles.list(token);
        setRoles(list);
        if (list[0]) setRoleKey(list[0].key);
      } catch (error) {
        uiToast.error(error instanceof Error ? error.message : "Unable to connect");
      }
    };

    void loadRoles();
  }, [token]);

  const loadPermissions = async () => {
    if (!token || !roleKey) return;
    setLoading(true);
    try {
      setPermissions(await api.admin.tools.listByRole(token, roleKey));
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPermissions();
  }, [token, roleKey]);

  const updatePermission = async (next: ToolPermissionDto) => {
    if (!token) return;
    try {
      const updated = await api.admin.tools.updatePermission(token, {
        role_key: roleKey,
        tool_key: next.tool_key,
        can_execute: next.can_execute,
        requires_approval: next.requires_approval,
      });
      setPermissions((prev) => prev.map((item) => (item.tool_key === updated.tool_key ? updated : item)));
      uiToast.success("Permission updated");
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    }
  };

  const sorted = useMemo(
    () => permissions.slice().sort((a, b) => a.tool_key.localeCompare(b.tool_key)),
    [permissions]
  );

  return (
    <div className="mx-auto w-full max-w-[980px] p-6">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Tools Matrix
      </h1>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        Configure per-role tool permissions and approval requirements.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <span style={{ color: "var(--text-secondary)" }}>Role:</span>
        <select value={roleKey} onChange={(event) => setRoleKey(event.target.value)} className="h-9 rounded-md border px-2" style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-surface)", color: "var(--text-primary)" }}>
          {roles.map((role) => (
            <option key={role.id} value={role.key}>{role.name}</option>
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
                    onChange={() => void updatePermission({ ...perm, can_execute: !perm.can_execute })}
                  />
                </td>
                <td className="px-4 py-3">
                  <ApprovalConfirmDialog
                    title="Change approval policy"
                    description={`Set approval requirement for ${perm.tool_key}`}
                    onConfirm={async () => {
                      await updatePermission({ ...perm, requires_approval: !perm.requires_approval });
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
    </div>
  );
}
