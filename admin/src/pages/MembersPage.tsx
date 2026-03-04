import { FormEvent, useEffect, useState } from 'react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { api } from '../lib/api';

type Assignment = {
  assignmentId: string;
  userId: string;
  companyId: string;
  roleId: string;
  assignedBy: string;
  email?: string;
  name?: string;
  createdAt: string;
};

export const MembersPage = () => {
  const { token } = useAdminAuth();
  const [rows, setRows] = useState<Assignment[]>([]);
  const [userId, setUserId] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!token) return;
    const data = await api.get<Assignment[]>('/api/admin/rbac/assignments', token);
    setRows(data);
  };

  useEffect(() => {
    void load();
  }, [token]);

  const assign = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;

    setError(null);
    try {
      await api.post('/api/admin/rbac/assignments', { userId, companyId, roleId: 'COMPANY_ADMIN' }, token);
      setUserId('');
      setCompanyId('');
      await load();
    } catch {
      setError('Assignment failed. Verify super-admin access and valid IDs.');
    }
  };

  const revoke = async (assignmentId: string) => {
    if (!token) return;

    try {
      await api.delete('/api/admin/rbac/assignments', { assignmentId }, token);
      await load();
    } catch {
      setError('Revoke failed.');
    }
  };

  return (
    <div>
      <h1>Role Assignments</h1>
      <p>Assign or revoke COMPANY_ADMIN memberships via backend RBAC APIs.</p>

      {error ? <div className="alert">{error}</div> : null}

      <form className="assignment-form" onSubmit={assign}>
        <input
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          placeholder="User ID"
          required
        />
        <input
          value={companyId}
          onChange={(event) => setCompanyId(event.target.value)}
          placeholder="Company ID"
          required
        />
        <button className="btn btn--primary" type="submit">
          Assign COMPANY_ADMIN
        </button>
      </form>

      <div className="list">
        {rows.map((row) => (
          <div key={row.assignmentId} className="list__item">
            <div>
              <strong>{row.email ?? row.userId}</strong>
              <p>
                {row.roleId} @ {row.companyId}
              </p>
            </div>
            <button className="btn" type="button" onClick={() => void revoke(row.assignmentId)}>
              Revoke
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
