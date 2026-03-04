import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { api } from '../lib/api';
import { roleLabel } from '../lib/labels';

export const MemberInviteAcceptPage = () => {
  const [inviteToken, setInviteToken] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    try {
      const result = await api.post<{ role: string; companyId: string }>(
        '/api/admin/auth/signup/member-invite',
        {
          inviteToken,
          password,
          name: name || undefined,
        },
      );

      setSuccess(
        `Invite accepted as ${roleLabel(result.role)} for workspace ${result.companyId}. You can now sign in.`,
      );
    } catch (error) {
      if (error instanceof Error) {
        setError(error.message);
        return;
      }
      setError('Could not accept invite. Check token validity and try again.');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0c0c0c] p-4 text-zinc-300 antialiased font-sans">
      <Card className="w-full max-w-md bg-[#111] border-[#1a1a1a] shadow-xl shadow-black">
        <CardHeader className="space-y-2 border-b border-[#1a1a1a] pb-6">
          <CardTitle className="text-xl text-zinc-100 flex items-center justify-center gap-2">
            Accept Invite
          </CardTitle>
          <CardDescription className="text-center text-zinc-500">
            Use the invite token provided by your workspace admin.
          </CardDescription>
        </CardHeader>

        <CardContent className="pt-6">
          <form onSubmit={onSubmit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-300">Invite Token</label>
              <Input
                value={inviteToken}
                onChange={(event) => setInviteToken(event.target.value)}
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

            {success ? (
              <div className="bg-emerald-950/30 border border-emerald-900/50 text-emerald-400 p-3 rounded-md text-sm">
                {success}
              </div>
            ) : null}

            <Button type="submit" className="w-full mt-2 bg-zinc-100 text-zinc-900 hover:bg-zinc-200 font-medium">
              Accept Invite
            </Button>

            <div className="text-sm text-center text-zinc-500 mt-2">
              Back to <Link to="/login" className="text-zinc-400 hover:text-zinc-200 underline decoration-zinc-700 underline-offset-4">sign in</Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
