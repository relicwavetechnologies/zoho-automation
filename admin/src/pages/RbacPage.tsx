import { useEffect, useMemo, useState } from 'react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { api } from '../lib/api';

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
      const data = await api.get<PermissionRow[]>('/api/admin/rbac/permissions', token);
      setRows(data);
    };

    void load();
  }, [token]);

  const toggle = async (row: PermissionRow) => {
    if (!token) return;

    const previous = rows;
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
    <div>
      <h1>RBAC Permission Matrix</h1>
      <p>Mutations are backend-authorized; UI optimistic updates rollback on reject.</p>
      <p>Signed in role: {session?.role}</p>

      {error ? <div className="alert">{error}</div> : null}

      <div className="matrix">
        {Object.entries(grouped).map(([actionId, actionRows]) => (
          <div key={actionId} className="matrix__row">
            <div className="matrix__action">{actionId}</div>
            <div className="matrix__controls">
              {actionRows.map((row) => (
                <button
                  key={`${row.roleId}-${row.actionId}`}
                  type="button"
                  className={row.allowed ? 'pill pill--on' : 'pill'}
                  onClick={() => void toggle(row)}
                >
                  {row.roleId}: {row.allowed ? 'ALLOW' : 'DENY'}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
