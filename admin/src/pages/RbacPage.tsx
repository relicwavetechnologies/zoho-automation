import { useEffect, useMemo, useState } from 'react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { api } from '../lib/api';
import { roleLabel } from '../lib/labels';

type PermissionRow = {
  roleId: 'SUPER_ADMIN' | 'COMPANY_ADMIN';
  actionId: string;
  allowed: boolean;
  updatedAt: string;
  updatedBy: string;
};

export const RbacPage = () => {
  const { token, session } = useAdminAuth();
  const [rows, setRows] = useState<PermissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    return rows.reduce<Record<string, PermissionRow[]>>((acc, row) => {
      acc[row.actionId] = acc[row.actionId] ?? [];
      acc[row.actionId].push(row);
      return acc;
    }, {});
  }, [rows]);

  useEffect(() => {
    const load = async () => {
      if (!token) return;
      try {
        setLoading(true);
        const data = await api.get<PermissionRow[]>('/api/admin/rbac/permissions', token);
        setRows(data);
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [token]);

  const toggle = async (row: PermissionRow) => {
    if (!token) return;

    const previous = [...rows];
    const optimistic = rows.map((item) =>
      item.roleId === row.roleId && item.actionId === row.actionId
        ? { ...item, allowed: !item.allowed }
        : item,
    );

    setRows(optimistic);
    setError(null);

    try {
      const updated = await api.put<PermissionRow>(
        '/api/admin/rbac/permissions',
        {
          roleId: row.roleId,
          actionId: row.actionId,
          allowed: !row.allowed,
        },
        token,
      );

      setRows((current) =>
        current.map((item) =>
          item.roleId === updated.roleId && item.actionId === updated.actionId ? updated : item,
        ),
      );
    } catch {
      setRows(previous);
      setError('Permission update failed. UI rolled back to backend state.');
    }
  };

  return (
    <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
      <CardHeader className="border-b border-[#1a1a1a] pb-4">
        <CardTitle className="text-zinc-100">RBAC Permission Matrix</CardTitle>
        <CardDescription className="text-zinc-500">
          Mutations are backend-authorized; optimistic UI updates roll back on reject.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6 space-y-6">
        <div className="flex items-center gap-3 pb-4">
          <span className="text-sm text-zinc-400">Signed in role</span>
          <Badge variant="secondary" className="bg-[#1a1a1a] text-zinc-100 uppercase tracking-widest text-[10px] px-2 py-0.5">
            {roleLabel(session?.role)}
          </Badge>
        </div>

        {error ? (
          <div className="bg-red-950/30 border border-red-900/50 text-red-400 p-3 rounded-md text-sm">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="flex flex-col gap-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center justify-between p-3 rounded-md bg-[#0a0a0a] border border-[#1a1a1a]">
                <Skeleton className="h-5 w-48" />
                <div className="flex items-center gap-2">
                  <Skeleton className="h-8 w-32" />
                  <Skeleton className="h-8 w-32" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {Object.entries(grouped).map(([actionId, actionRows]) => (
              <div key={actionId} className="flex items-center justify-between p-3 rounded-md bg-[#0a0a0a] border border-[#1a1a1a]">
                <div className="text-sm font-medium text-zinc-300">{actionId}</div>
                <div className="flex items-center gap-2">
                  {actionRows.map((row) => (
                    <Button
                      key={`${row.roleId}-${row.actionId}`}
                      type="button"
                      size="sm"
                      variant={row.allowed ? 'default' : 'outline'}
                      className={
                        row.allowed
                          ? "bg-[#2a2a2a] border-[#3a3a3a] text-zinc-200 hover:bg-[#333]"
                          : "bg-transparent border-[#222] text-zinc-500 hover:text-zinc-300 hover:bg-[#111]"
                      }
                      onClick={() => void toggle(row)}
                    >
                      {roleLabel(row.roleId)}: {row.allowed ? 'ALLOW' : 'DENY'}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
