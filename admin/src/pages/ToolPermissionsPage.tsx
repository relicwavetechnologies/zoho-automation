import { useState, useEffect, useCallback } from 'react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { api } from '../lib/api';
import { toast } from '../components/ui/use-toast';

// ─── Types ────────────────────────────────────────────────────────────────────

type AiRole = { id: string; slug: string; displayName: string; isBuiltIn: boolean };
type ToolRow = {
  toolId: string;
  name: string;
  description: string;
  category: string;
  engines: ('mastra' | 'langgraph')[];
  permissions: Record<string, boolean>;
};
type ChannelIdentity = {
  id: string;
  externalUserId: string;
  displayName?: string;
  email?: string;
  channel: string;
  aiRole: string;
  aiRoleSource: 'sync' | 'manual';
  syncedAiRole?: string;
  syncedFromLarkRole?: string;
  sourceRoles?: string[];
};

type Tab = 'permissions' | 'roles' | 'users';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CATEGORY_ORDER = ['crm-read', 'crm-action', 'search', 'workspace', 'routing'];
const CATEGORY_LABELS: Record<string, string> = {
  'crm-read': 'CRM Read',
  'crm-action': 'CRM Actions',
  search: 'Search',
  workspace: 'Workspace',
  routing: 'Routing',
};

const groupByCategory = (tools: ToolRow[]) => {
  const groups: Record<string, ToolRow[]> = {};
  for (const tool of tools) {
    (groups[tool.category] ??= []).push(tool);
  }
  return groups;
};

// Role badge colors — dark-mode friendly
const ROLE_COLORS: Record<string, { pill: string; dot: string }> = {
  MEMBER:        { pill: 'bg-zinc-800 text-zinc-300 border border-zinc-700',         dot: 'bg-zinc-500' },
  COMPANY_ADMIN: { pill: 'bg-blue-950 text-blue-300 border border-blue-900',         dot: 'bg-blue-500' },
  SUPER_ADMIN:   { pill: 'bg-purple-950 text-purple-300 border border-purple-900',   dot: 'bg-purple-500' },
};
const CUSTOM_ROLE_COLOR = { pill: 'bg-amber-950 text-amber-300 border border-amber-900', dot: 'bg-amber-500' };
const roleColor = (slug: string) => ROLE_COLORS[slug] ?? CUSTOM_ROLE_COLOR;

// ─── Sub-components ───────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-1 focus:ring-zinc-600 focus:ring-offset-1 focus:ring-offset-[#111] ${
        checked ? 'bg-indigo-600' : 'bg-zinc-700'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

function EngineBadge({ engine }: { engine: 'mastra' | 'langgraph' }) {
  return engine === 'mastra' ? (
    <span className="rounded bg-violet-950 px-1.5 py-0.5 text-[10px] font-semibold text-violet-400 border border-violet-900">
      Mastra
    </span>
  ) : (
    <span className="rounded bg-sky-950 px-1.5 py-0.5 text-[10px] font-semibold text-sky-400 border border-sky-900">
      LangGraph
    </span>
  );
}

function RoleBadge({ slug, label }: { slug: string; label: string }) {
  const c = roleColor(slug);
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${c.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {label}
    </span>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ToolPermissionsPage() {
  const { token } = useAdminAuth();
  const [tab, setTab] = useState<Tab>('permissions');

  const [roles, setRoles] = useState<AiRole[]>([]);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [users, setUsers] = useState<ChannelIdentity[]>([]);
  const [loading, setLoading] = useState(true);

  const [newRoleSlug, setNewRoleSlug] = useState('');
  const [newRoleLabel, setNewRoleLabel] = useState('');
  const [creatingRole, setCreatingRole] = useState(false);

  // ── Data ────────────────────────────────────────────────────────────────────

  const loadMatrix = useCallback(async () => {
    if (!token) return;
    const data = await api.get<{ roles: AiRole[]; tools: ToolRow[] }>(
      '/api/admin/company/tool-permissions',
      token,
    );
    setRoles(data.roles);
    setTools(data.tools);
  }, [token]);

  const loadUsers = useCallback(async () => {
    if (!token) return;
    const data = await api.get<ChannelIdentity[]>(
      '/api/admin/company/channel-identities?channel=lark',
      token,
    );
    setUsers(data ?? []);
  }, [token]);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadMatrix(), loadUsers()]).finally(() => setLoading(false));
  }, [loadMatrix, loadUsers]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleToggle = async (toolId: string, roleSlug: string, newVal: boolean) => {
    if (!token) return;
    setTools((prev) =>
      prev.map((t) =>
        t.toolId === toolId ? { ...t, permissions: { ...t.permissions, [roleSlug]: newVal } } : t,
      ),
    );
    try {
      await api.put(
        `/api/admin/company/tool-permissions/${toolId}/${roleSlug}`,
        { enabled: newVal },
        token,
      );
      toast({ title: 'Permission saved' });
    } catch {
      setTools((prev) =>
        prev.map((t) =>
          t.toolId === toolId
            ? { ...t, permissions: { ...t.permissions, [roleSlug]: !newVal } }
            : t,
        ),
      );
    }
  };

  const handleCreateRole = async () => {
    if (!token) return;
    if (!newRoleSlug.trim() || !newRoleLabel.trim()) return;
    setCreatingRole(true);
    try {
      await api.post(
        '/api/admin/company/ai-roles',
        { slug: newRoleSlug.trim(), displayName: newRoleLabel.trim() },
        token,
      );
      setNewRoleSlug('');
      setNewRoleLabel('');
      await loadMatrix();
      toast({ title: 'Role created' });
    } catch {
      // api util shows error toast
    } finally {
      setCreatingRole(false);
    }
  };

  const handleDeleteRole = async (role: AiRole) => {
    if (!token) return;
    if (role.isBuiltIn) return;
    try {
      await api.delete(`/api/admin/company/ai-roles/${role.id}`, {}, token);
      await loadMatrix();
      toast({ title: 'Role deleted' });
    } catch {
      // api util shows error toast
    }
  };

  const handleUserRoleChange = async (userId: string, newRole: string) => {
    if (!token) return;
    setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, aiRole: newRole } : u)));
    try {
      await api.put(
        `/api/admin/company/channel-identities/${userId}/ai-role`,
        { aiRole: newRole },
        token,
      );
      toast({ title: 'User role updated' });
    } catch {
      await loadUsers();
    }
  };

  const handleResetUserRole = async (userId: string) => {
    if (!token) return;
    try {
      await api.post(`/api/admin/company/channel-identities/${userId}/ai-role/reset`, {}, token);
      await loadUsers();
      toast({ title: 'User role reset to sync-managed value' });
    } catch {
      await loadUsers();
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <span className="text-sm text-zinc-500">Loading…</span>
      </div>
    );
  }

  const groups = groupByCategory(tools);
  const tabs: { id: Tab; label: string }[] = [
    { id: 'permissions', label: 'Tool Permissions' },
    { id: 'roles', label: 'Manage Roles' },
    { id: 'users', label: 'Lark Users' },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Tool Access Control</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Control which AI tools each role can use. Changes apply in real-time across both Mastra
          and LangGraph engines.
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-[#1a1a1a]">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? 'border-b-2 border-indigo-500 text-indigo-400'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Tool Permissions ── */}
      {tab === 'permissions' && (
        <div className="space-y-4">
          {/* Role legend */}
          <div className="flex flex-wrap gap-2">
            {roles.map((r) => (
              <RoleBadge key={r.slug} slug={r.slug} label={r.displayName} />
            ))}
          </div>

          {/* Matrix table */}
          <div className="overflow-x-auto rounded-lg border border-[#1a1a1a] shadow-md shadow-black/20">
            <table className="min-w-full divide-y divide-[#1a1a1a] text-sm">
              <thead className="bg-[#0a0a0a]">
                <tr>
                  <th className="py-3 pl-4 pr-2 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    Tool
                  </th>
                  <th className="px-2 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    Engines
                  </th>
                  {roles.map((r) => (
                    <th key={r.slug} className="px-3 py-3 text-center">
                      <RoleBadge slug={r.slug} label={r.displayName} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1a1a1a] bg-[#111]">
                {CATEGORY_ORDER.filter((cat) => groups[cat]?.length).flatMap((cat) => [
                  <tr key={`hdr-${cat}`} className="bg-[#0d0d0d]">
                    <td
                      colSpan={2 + roles.length}
                      className="py-1.5 pl-4 text-[10px] font-semibold uppercase tracking-widest text-zinc-600"
                    >
                      {CATEGORY_LABELS[cat] ?? cat}
                    </td>
                  </tr>,
                  ...groups[cat].map((tool) => (
                    <tr key={tool.toolId} className="hover:bg-[#0a0a0a]">
                      <td className="py-3 pl-4 pr-2">
                        <div className="font-medium text-zinc-200">{tool.name}</div>
                        <div className="mt-0.5 text-xs text-zinc-600">{tool.description}</div>
                      </td>
                      <td className="px-2 py-3">
                        <div className="flex flex-wrap gap-1">
                          {tool.engines.map((e) => (
                            <EngineBadge key={e} engine={e} />
                          ))}
                        </div>
                      </td>
                      {roles.map((r) => (
                        <td key={r.slug} className="px-3 py-3 text-center">
                          <Toggle
                            checked={!!tool.permissions[r.slug]}
                            onChange={(v) => handleToggle(tool.toolId, r.slug, v)}
                          />
                        </td>
                      ))}
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Manage Roles ── */}
      {tab === 'roles' && (
        <div className="space-y-6">
          {/* Create form */}
          <div className="rounded-lg border border-[#1a1a1a] bg-[#111] p-5 shadow-md shadow-black/20">
            <h2 className="mb-3 text-sm font-semibold text-zinc-200">Create Custom Role</h2>
            <div className="flex flex-wrap gap-3">
              <div>
                <label className="mb-1 block text-xs text-zinc-500">
                  Slug <span className="text-zinc-600">(e.g. SALES_MANAGER)</span>
                </label>
                <input
                  value={newRoleSlug}
                  onChange={(e) => setNewRoleSlug(e.target.value.toUpperCase().replace(/\s/g, '_'))}
                  placeholder="SALES_MANAGER"
                  className="rounded border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-indigo-700 focus:outline-none focus:ring-1 focus:ring-indigo-700"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-zinc-500">Display Name</label>
                <input
                  value={newRoleLabel}
                  onChange={(e) => setNewRoleLabel(e.target.value)}
                  placeholder="Sales Manager"
                  className="rounded border border-[#2a2a2a] bg-[#0a0a0a] px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-indigo-700 focus:outline-none focus:ring-1 focus:ring-indigo-700"
                />
              </div>
              <div className="flex items-end">
                <button
                  onClick={handleCreateRole}
                  disabled={creatingRole || !newRoleSlug.trim() || !newRoleLabel.trim()}
                  className="rounded bg-indigo-700 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-indigo-600 disabled:opacity-40"
                >
                  {creatingRole ? 'Creating…' : 'Create Role'}
                </button>
              </div>
            </div>
            <p className="mt-2 text-xs text-zinc-600">
              New roles inherit MEMBER-level tool access by default. Adjust in the Tool Permissions
              tab.
            </p>
          </div>

          {/* Roles table */}
          <div className="overflow-hidden rounded-lg border border-[#1a1a1a] shadow-md shadow-black/20">
            <table className="min-w-full divide-y divide-[#1a1a1a] text-sm">
              <thead className="bg-[#0a0a0a]">
                <tr>
                  <th className="py-3 pl-4 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">Role</th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">Slug</th>
                  <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">Type</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1a1a1a] bg-[#111]">
                {roles.map((r) => (
                  <tr key={r.id} className="hover:bg-[#0a0a0a]">
                    <td className="py-3 pl-4">
                      <RoleBadge slug={r.slug} label={r.displayName} />
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-zinc-500">{r.slug}</td>
                    <td className="px-3 py-3 text-xs">
                      {r.isBuiltIn ? (
                        <span className="text-zinc-600">Built-in</span>
                      ) : (
                        <span className="text-amber-500">Custom</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {!r.isBuiltIn && (
                        <button
                          onClick={() => handleDeleteRole(r)}
                          className="text-xs text-red-600 hover:text-red-400"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Lark Users ── */}
      {tab === 'users' && (
        <div>
          {users.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#1a1a1a] py-12 text-center">
              <p className="text-sm text-zinc-600">
                No Lark users found. Users appear here after they first message the bot.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-[#1a1a1a] shadow-md shadow-black/20">
              <table className="min-w-full divide-y divide-[#1a1a1a] text-sm">
                <thead className="bg-[#0a0a0a]">
                  <tr>
                    <th className="py-3 pl-4 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">User</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">External ID</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">Current Role</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">Source</th>
                    <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">Change Role</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1a1a1a] bg-[#111]">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-[#0a0a0a]">
                      <td className="py-3 pl-4">
                        <div className="font-medium text-zinc-200">{u.displayName ?? 'Unknown'}</div>
                        {u.email && <div className="text-xs text-zinc-600">{u.email}</div>}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-zinc-600">{u.externalUserId}</td>
                      <td className="px-3 py-3">
                        <RoleBadge
                          slug={u.aiRole}
                          label={roles.find((r) => r.slug === u.aiRole)?.displayName ?? u.aiRole}
                        />
                        {u.syncedAiRole && u.syncedAiRole !== u.aiRole && (
                          <div className="mt-1 text-[11px] text-zinc-600">sync: {u.syncedAiRole}</div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs text-zinc-500">
                        <div>{u.aiRoleSource}</div>
                        {u.syncedFromLarkRole && <div className="mt-1 text-[11px] text-zinc-600">{u.syncedFromLarkRole}</div>}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <select
                            value={u.aiRole}
                            onChange={(e) => handleUserRoleChange(u.id, e.target.value)}
                            className="rounded border border-[#2a2a2a] bg-[#0a0a0a] px-2 py-1 text-xs text-zinc-300 focus:border-indigo-700 focus:outline-none"
                          >
                            {roles.map((r) => (
                              <option key={r.slug} value={r.slug}>
                                {r.displayName}
                              </option>
                            ))}
                          </select>
                          {u.aiRoleSource === 'manual' && (
                            <button
                              type="button"
                              onClick={() => handleResetUserRole(u.id)}
                              className="rounded border border-[#2a2a2a] px-2 py-1 text-[11px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                            >
                              Reset
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { ToolPermissionsPage };
