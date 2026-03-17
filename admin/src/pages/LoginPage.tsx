import { FormEvent, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';

export const LoginPage = () => {
  const { session, loginCompanyAdmin, loginSuperAdmin } = useAdminAuth();
  const [mode, setMode] = useState<'super' | 'company'>('super');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (session) {
    return <Navigate to={session.role === 'DEPARTMENT_MANAGER' ? '/departments' : '/overview'} replace />;
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      if (mode === 'super') {
        await loginSuperAdmin(email, password);
      } else {
        await loginCompanyAdmin(email, password);
      }
    } catch (error) {
      if (error instanceof Error) {
        setError(error.message);
      } else {
        setError('Authentication failed. Check credentials and role assignment.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0c0c0c] p-4 text-zinc-300 antialiased font-sans">
      <Card className="w-full max-w-md bg-[#111] border-[#1a1a1a] shadow-xl shadow-black">
        <CardHeader className="space-y-2 border-b border-[#1a1a1a] pb-6">
          <CardTitle className="text-xl text-zinc-100 flex items-center justify-center gap-2">
            Control Hub Sign In
          </CardTitle>
          <CardDescription className="text-center text-zinc-500">
            Role and workspace scope are resolved from backend session only.
          </CardDescription>
        </CardHeader>

        <CardContent className="pt-6">
          <form onSubmit={onSubmit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-2 mb-2 text-sm text-center">
              <Link className="text-zinc-400 hover:text-zinc-200 underline decoration-zinc-700 underline-offset-4" to="/signup/company-admin">
                Create workspace admin account
              </Link>
              <Link className="text-zinc-400 hover:text-zinc-200 underline decoration-zinc-700 underline-offset-4" to="/signup/member-invite">
                Accept invite to join workspace
              </Link>
            </div>

            <div className="flex p-1 bg-[#1a1a1a] rounded-md">
              <button
                type="button"
                className={`flex-1 py-1.5 text-sm rounded transition-colors ${mode === 'super' ? 'bg-[#222] text-zinc-100 shadow-sm' : 'text-zinc-400 hover:text-zinc-200'}`}
                onClick={() => setMode('super')}
              >
                Super Admin
              </button>
              <button
                type="button"
                className={`flex-1 py-1.5 text-sm rounded transition-colors ${mode === 'company' ? 'bg-[#222] text-zinc-100 shadow-sm' : 'text-zinc-400 hover:text-zinc-200'}`}
                onClick={() => setMode('company')}
              >
                Workspace Admin / Manager
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-300">Email</label>
              <Input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                className="bg-[#0a0a0a] border-[#222] focus-visible:ring-zinc-700"
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-300">Password</label>
              <Input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                className="bg-[#0a0a0a] border-[#222] focus-visible:ring-zinc-700"
                required
              />
            </div>

            {error ? (
              <div className="bg-red-950/30 border border-red-900/50 text-red-400 p-3 rounded-md text-sm">
                {error}
              </div>
            ) : null}

            <Button disabled={submitting} type="submit" className="w-full mt-2 bg-zinc-100 text-zinc-900 hover:bg-zinc-200 font-medium">
              {submitting ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
