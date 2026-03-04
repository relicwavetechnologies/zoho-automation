import { useEffect, useState } from 'react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { api } from '../lib/api';

type ControlState = {
  controlKey: string;
  value: boolean;
  companyId?: string | null;
  updatedAt?: string | null;
  updatedBy: string;
};

export const ControlsPage = () => {
  const { token, session } = useAdminAuth();
  const [rows, setRows] = useState<ControlState[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!token) return;
    const result = await api.get<ControlState[]>('/api/admin/controls', token);
    setRows(result);
  };

  useEffect(() => {
    void load();
  }, [token]);

  const apply = async (row: ControlState) => {
    if (!token) return;

    const nextValue = !row.value;
    if (!window.confirm(`Apply ${row.controlKey} = ${String(nextValue)}?`)) {
      return;
    }

    try {
      await api.post(
        '/api/admin/controls/apply',
        {
          controlKey: row.controlKey,
          requestedValue: nextValue,
          companyId: row.companyId ?? undefined,
          confirmation: 'APPLY',
        },
        token,
      );
      await load();
    } catch {
      setError('Control apply failed. Check authorization and retry.');
    }
  };

  return (
    <div>
      <h1>System Controls</h1>
      <p>High-impact controls require explicit confirmation and backend audit logging.</p>
      <p>Session role: {session?.role}</p>

      {error ? <div className="alert">{error}</div> : null}

      <div className="list">
        {rows.map((row) => (
          <div key={row.controlKey} className="list__item">
            <div>
              <strong>{row.controlKey}</strong>
              <p>
                Current: {row.value ? 'ENABLED' : 'DISABLED'} | Updated by {row.updatedBy}
              </p>
            </div>

            <button className="btn" type="button" onClick={() => void apply(row)}>
              Toggle
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
