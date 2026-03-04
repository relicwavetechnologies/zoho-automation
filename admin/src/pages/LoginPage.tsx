import { FormEvent, useState } from 'react';
import { Navigate } from 'react-router-dom';

import { useAdminAuth } from '../auth/AdminAuthProvider';

export const LoginPage = () => {
  const { session, loginCompanyAdmin, loginSuperAdmin } = useAdminAuth();
  const [mode, setMode] = useState<'super' | 'company'>('super');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (session) {
    return <Navigate to="/overview" replace />;
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      if (mode === 'super') {
        await loginSuperAdmin(email, password);
      } else {
        await loginCompanyAdmin(email, password, companyId);
      }
    } catch {
      setError('Authentication failed. Check credentials and role assignment.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login">
      <form onSubmit={onSubmit} className="login__card">
        <h1>Admin Sign In</h1>
        <p>Backend session is source-of-truth for role and company scope.</p>

        <div className="mode-toggle">
          <button
            className={mode === 'super' ? 'btn btn--active' : 'btn'}
            type="button"
            onClick={() => setMode('super')}
          >
            Super Admin
          </button>
          <button
            className={mode === 'company' ? 'btn btn--active' : 'btn'}
            type="button"
            onClick={() => setMode('company')}
          >
            Company Admin
          </button>
        </div>

        <label>
          Email
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required />
        </label>

        <label>
          Password
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            required
          />
        </label>

        {mode === 'company' && (
          <label>
            Company ID
            <input
              value={companyId}
              onChange={(event) => setCompanyId(event.target.value)}
              placeholder="uuid"
              required
            />
          </label>
        )}

        {error ? <div className="alert">{error}</div> : null}

        <button disabled={submitting} className="btn btn--primary" type="submit">
          {submitting ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
};
