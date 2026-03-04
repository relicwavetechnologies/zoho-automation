import { FormEvent, useEffect, useState } from 'react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { api } from '../lib/api';

type AuditLog = {
  id: string;
  actor: string;
  companyId?: string | null;
  action: string;
  outcome: 'success' | 'failure';
  timestamp: string;
  metadata?: Record<string, unknown>;
};

export const AuditLogsPage = () => {
  const { token } = useAdminAuth();
  const [rows, setRows] = useState<AuditLog[]>([]);
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState<'success' | 'failure' | ''>('');
  const [selected, setSelected] = useState<AuditLog | null>(null);

  const load = async () => {
    if (!token) return;

    const params = new URLSearchParams();
    if (action) params.set('action', action);
    if (outcome) params.set('outcome', outcome);
    params.set('limit', '100');

    const data = await api.get<AuditLog[]>(`/api/admin/audit/logs?${params.toString()}`, token);
    setRows(data);
  };

  useEffect(() => {
    void load();
  }, [token]);

  const onFilter = async (event: FormEvent) => {
    event.preventDefault();
    await load();
  };

  return (
    <div>
      <h1>Audit Logs</h1>
      <p>Append-only audit stream for auth, RBAC, and system controls.</p>

      <form onSubmit={onFilter} className="assignment-form">
        <input value={action} onChange={(event) => setAction(event.target.value)} placeholder="Filter action" />
        <select value={outcome} onChange={(event) => setOutcome(event.target.value as 'success' | 'failure' | '')}>
          <option value="">All outcomes</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
        </select>
        <button className="btn btn--primary" type="submit">
          Apply Filters
        </button>
      </form>

      <div className="list">
        {rows.map((row) => (
          <button key={row.id} className="list__item list__item--button" onClick={() => setSelected(row)}>
            <div>
              <strong>{row.action}</strong>
              <p>
                {row.outcome.toUpperCase()} | {new Date(row.timestamp).toLocaleString()}
              </p>
            </div>
            <span>{row.actor}</span>
          </button>
        ))}
      </div>

      {selected ? (
        <div className="drawer">
          <div className="drawer__header">
            <h2>Audit Detail</h2>
            <button className="btn" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <pre>{JSON.stringify(selected, null, 2)}</pre>
        </div>
      ) : null}
    </div>
  );
};
