"use client";

import { FormEvent, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/context/AuthContext";
import { api, type RoleDto } from "@/lib/api";
import { uiToast } from "@/lib/toast";

export default function AdminRolesPage() {
  const { token } = useAuth();
  const [roles, setRoles] = useState<RoleDto[]>([]);
  const [keyInput, setKeyInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [cloneFrom, setCloneFrom] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      setRoles(await api.admin.roles.list(token));
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token]);

  const createRole = async (event: FormEvent) => {
    event.preventDefault();
    if (!token || !keyInput.trim() || !nameInput.trim()) return;
    try {
      await api.admin.roles.create(token, {
        key: keyInput.trim(),
        name: nameInput.trim(),
        clone_from: cloneFrom || undefined,
      });
      setKeyInput("");
      setNameInput("");
      setCloneFrom("");
      uiToast.success("Role created");
      await load();
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    }
  };

  const renameRole = async (role: RoleDto, name: string) => {
    if (!token || !name.trim()) return;
    try {
      await api.admin.roles.update(token, role.id, { name: name.trim() });
      await load();
      uiToast.success("Role updated");
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    }
  };

  const deleteRole = async (role: RoleDto) => {
    if (!token || role.is_system) return;
    try {
      await api.admin.roles.remove(token, role.id);
      await load();
      uiToast.success("Role deleted");
    } catch (error) {
      uiToast.error(error instanceof Error ? error.message : "Unable to connect");
    }
  };

  return (
    <div className="mx-auto w-full max-w-[980px] p-6">
      <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
        Roles
      </h1>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        Create custom roles, edit names, or clone from an existing role.
      </p>

      <form onSubmit={createRole} className="mt-4 grid grid-cols-1 gap-3 rounded-xl border p-4 md:grid-cols-4" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}>
        <div className="space-y-2">
          <Label>Role key</Label>
          <Input value={keyInput} onChange={(event) => setKeyInput(event.target.value)} placeholder="billing_manager" />
        </div>
        <div className="space-y-2">
          <Label>Role name</Label>
          <Input value={nameInput} onChange={(event) => setNameInput(event.target.value)} placeholder="Billing Manager" />
        </div>
        <div className="space-y-2">
          <Label>Clone from</Label>
          <select className="h-9 rounded-md border px-2" value={cloneFrom} onChange={(event) => setCloneFrom(event.target.value)} style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-elevated)", color: "var(--text-primary)" }}>
            <option value="">None</option>
            {roles.map((role) => (
              <option key={role.id} value={role.key}>{role.name}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <Button type="submit" style={{ backgroundColor: "var(--accent)", color: "#fff" }}>Create role</Button>
        </div>
      </form>

      <div className="mt-4 overflow-hidden rounded-xl border" style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}>
        <table className="w-full text-sm">
          <thead style={{ backgroundColor: "var(--bg-elevated)", color: "var(--text-secondary)" }}>
            <tr>
              <th className="px-4 py-3 text-left">Key</th>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Type</th>
              <th className="px-4 py-3 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-4">Loading roles...</td></tr>
            ) : roles.map((role) => (
              <RoleRow key={role.id} role={role} onRename={renameRole} onDelete={deleteRole} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RoleRow({
  role,
  onRename,
  onDelete,
}: {
  role: RoleDto;
  onRename: (role: RoleDto, name: string) => Promise<void>;
  onDelete: (role: RoleDto) => Promise<void>;
}) {
  const [name, setName] = useState(role.name);

  useEffect(() => {
    setName(role.name);
  }, [role.name]);

  return (
    <tr className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
      <td className="px-4 py-3">{role.key}</td>
      <td className="px-4 py-3">
        <Input value={name} onChange={(event) => setName(event.target.value)} disabled={role.is_system} />
      </td>
      <td className="px-4 py-3">{role.is_system ? "System" : "Custom"}</td>
      <td className="px-4 py-3">
        <div className="flex gap-2">
          <Button variant="ghost" disabled={role.is_system} onClick={() => void onRename(role, name)}>
            Save
          </Button>
          <Button variant="ghost" disabled={role.is_system} onClick={() => void onDelete(role)}>
            Delete
          </Button>
        </div>
      </td>
    </tr>
  );
}
