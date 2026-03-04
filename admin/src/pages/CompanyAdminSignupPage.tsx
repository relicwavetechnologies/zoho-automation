import { FormEvent, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { api } from '../lib/api';

export const CompanyAdminSignupPage = () => {
  const { session } = useAdminAuth();
  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (session) {
    return <Navigate to="/overview" replace />;
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    try {
      await api.post('/api/admin/auth/signup/company-admin', {
        email,
        companyName,
        password,
        name: name || undefined,
      });
      setDone(true);
    } catch (error) {
      if (error instanceof Error) {
        setError(error.message);
        return;
      }
      setError('Signup failed. Check your details and try again.');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0c0c0c] p-4 text-zinc-300 antialiased font-sans">
      <Card className="w-full max-w-md bg-[#111] border-[#1a1a1a] shadow-xl shadow-black">
        <CardHeader className="space-y-2 border-b border-[#1a1a1a] pb-6">
          <CardTitle className="text-xl text-zinc-100 flex items-center justify-center gap-2">
            Workspace Admin Signup
          </CardTitle>
          <CardDescription className="text-center text-zinc-500">
            Create a workspace and bootstrap its primary admin account.
          </CardDescription>
        </CardHeader>

        <CardContent className="pt-6">
          <form onSubmit={onSubmit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-2 mb-2 text-sm text-center">
              <Link className="text-zinc-400 hover:text-zinc-200 underline decoration-zinc-700 underline-offset-4" to="/signup/member-invite">
                Joining an existing workspace? Accept invite
              </Link>
              <Link className="text-zinc-400 hover:text-zinc-200 underline decoration-zinc-700 underline-offset-4" to="/login">
                Already have account? Sign in
              </Link>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-300">Workspace Name</label>
              <Input
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
                className="bg-[#0a0a0a] border-[#222] focus-visible:ring-zinc-700"
                required
              />
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
              <label className="text-sm font-medium text-zinc-300">Name (optional)</label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="bg-[#0a0a0a] border-[#222] focus-visible:ring-zinc-700"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-300">Password</label>
              <Input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                minLength={8}
                className="bg-[#0a0a0a] border-[#222] focus-visible:ring-zinc-700"
                required
              />
            </div>

            {error ? (
              <div className="bg-red-950/30 border border-red-900/50 text-red-400 p-3 rounded-md text-sm">
                {error}
              </div>
            ) : null}

            {done ? (
              <div className="bg-emerald-950/30 border border-emerald-900/50 text-emerald-400 p-3 rounded-md text-sm">
                Signup successful. <Link to="/login" className="underline font-medium hover:text-emerald-300">Go to sign in</Link>
              </div>
            ) : null}

            <Button type="submit" className="w-full mt-2 bg-zinc-100 text-zinc-900 hover:bg-zinc-200 font-medium">
              Sign Up
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
