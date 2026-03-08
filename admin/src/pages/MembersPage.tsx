import { FormEvent, useEffect, useMemo, useState } from 'react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { api } from '../lib/api';
import { roleLabel } from '../lib/labels';

type Member = {
  userId: string;
  companyId: string;
  roleId: string;
  email?: string;
  name?: string;
  createdAt: string;
};

type Invite = {
  inviteId: string;
  companyId: string;
  email: string;
  roleId: string;
  status: string;
  invitedBy: string;
  expiresAt: string;
  acceptedAt?: string;
  createdAt: string;
};

export const MembersPage = () => {
  const { token, session } = useAdminAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);

  const [companyId, setCompanyId] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRoleId, setInviteRoleId] = useState<'MEMBER' | 'COMPANY_ADMIN'>('MEMBER');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const isSuperAdmin = session?.role === 'SUPER_ADMIN';
  const scopedCompanyId = useMemo(() => (isSuperAdmin ? companyId.trim() : undefined), [companyId, isSuperAdmin]);

  const buildQuery = () => {
    if (!scopedCompanyId) return '';
    return `?companyId=${encodeURIComponent(scopedCompanyId)}`;
  };

  const load = async () => {
    if (!token) return;

    if (isSuperAdmin && !scopedCompanyId) {
      setMembers([]);
      setInvites([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const query = buildQuery();
      const [membersData, invitesData] = await Promise.all([
        api.get<Member[]>(`/api/admin/company/members${query}`, token),
        api.get<Invite[]>(`/api/admin/company/invites${query}`, token),
      ]);
      setMembers(membersData);
      setInvites(invitesData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load member operations.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token, scopedCompanyId, isSuperAdmin]);

  const createInvite = async (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    setMessage(null);
    setError(null);
    try {
      await api.post(
        '/api/admin/company/invites',
        {
          email: inviteEmail,
          roleId: inviteRoleId,
          companyId: scopedCompanyId || undefined,
        },
        token,
      );
      setInviteEmail('');
      setInviteRoleId('MEMBER');
      setMessage('Invite created.');
      await load();
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : 'Invite create failed.');
    }
  };

  const cancelInvite = async (inviteId: string) => {
    if (!token) return;
    setMessage(null);
    setError(null);
    try {
      await api.post(`/api/admin/company/invites/${inviteId}/cancel`, {}, token);
      setMessage('Invite cancelled.');
      await load();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Invite cancel failed.');
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
        <CardHeader className="border-b border-[#1a1a1a] pb-4">
          <CardTitle className="text-zinc-100">Members</CardTitle>
          <CardDescription className="text-zinc-500">
            Manage workspace members and invites. Integration setup lives in the dedicated Integrations area.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6 space-y-8">
          {isSuperAdmin ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-zinc-300">Workspace ID (required for super admin)</span>
              <Input
                value={companyId}
                onChange={(event) => setCompanyId(event.target.value)}
                placeholder="Paste workspace UUID"
                required
                className="bg-[#0a0a0a] border-[#222]"
              />
            </div>
          ) : null}

          {error ? <div className="bg-red-950/30 border border-red-900/50 text-red-400 p-3 rounded-md text-sm">{error}</div> : null}
          {message ? <div className="bg-emerald-950/30 border border-emerald-900/50 text-emerald-400 p-3 rounded-md text-sm">{message}</div> : null}

          <div className="space-y-4">
            <h3 className="text-lg font-medium text-zinc-100 border-b border-[#1a1a1a] pb-2">Members</h3>
            <div className="flex flex-col gap-2">
              {loading ? (
                <>
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="flex flex-col justify-center p-3 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] h-[62px]">
                      <Skeleton className="h-4 w-40 mb-2" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                  ))}
                </>
              ) : (
                <>
                  {members.map((member) => (
                    <div key={`${member.userId}:${member.roleId}`} className="flex items-center justify-between p-3 rounded-md bg-[#0a0a0a] border border-[#1a1a1a]">
                      <div className="flex flex-col">
                        <strong className="text-zinc-200 text-sm">{member.name || member.email || member.userId}</strong>
                        <span className="text-xs text-zinc-500 mt-1">{roleLabel(member.roleId)}</span>
                      </div>
                    </div>
                  ))}
                  {members.length === 0 ? <p className="text-sm text-zinc-500 italic p-2 rounded bg-[#0a0a0a] border border-dashed border-[#222]">No active members found for this workspace.</p> : null}
                </>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-lg font-medium text-zinc-100 border-b border-[#1a1a1a] pb-2">Invites</h3>
            <form className="flex items-center gap-3" onSubmit={createInvite}>
              <Input
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                type="email"
                placeholder="Invite email"
                className="bg-[#0a0a0a] border-[#222]"
                required
              />
              <Select value={inviteRoleId} onValueChange={(val) => setInviteRoleId(val as 'MEMBER' | 'COMPANY_ADMIN')}>
                <SelectTrigger className="w-[180px] bg-[#0a0a0a] border-[#222]">
                  <SelectValue placeholder="Role" />
                </SelectTrigger>
                <SelectContent className="bg-[#111] border-[#222] text-zinc-300">
                  <SelectItem value="MEMBER">{roleLabel('MEMBER')}</SelectItem>
                  <SelectItem value="COMPANY_ADMIN">{roleLabel('COMPANY_ADMIN')}</SelectItem>
                </SelectContent>
              </Select>
              <Button type="submit" variant="default" className="bg-zinc-100 text-zinc-900 hover:bg-zinc-200 shrink-0">Send Invite</Button>
            </form>

            <div className="flex flex-col gap-2">
              {loading ? (
                <>
                  {[1, 2].map((i) => (
                    <div key={i} className="flex items-center justify-between p-3 rounded-md bg-[#0a0a0a] border border-[#1a1a1a] h-[62px]">
                      <div className="flex flex-col w-full">
                        <Skeleton className="h-4 w-48 mb-2" />
                        <Skeleton className="h-3 w-28" />
                      </div>
                      <Skeleton className="h-6 w-16 shrink-0" />
                    </div>
                  ))}
                </>
              ) : (
                <>
                  {invites.map((invite) => (
                    <div key={invite.inviteId} className="flex items-center justify-between p-3 rounded-md bg-[#0a0a0a] border border-[#1a1a1a]">
                      <div className="flex flex-col">
                        <strong className="text-zinc-200 text-sm">{invite.email}</strong>
                        <span className="text-xs text-zinc-500 mt-1">
                          {roleLabel(invite.roleId)} &middot; {invite.status}
                        </span>
                      </div>
                      {invite.status === 'pending' ? (
                        <Button variant="outline" size="sm" type="button" onClick={() => void cancelInvite(invite.inviteId)} className="border-[#222] text-zinc-400 hover:text-red-400 hover:bg-red-950/30 hover:border-red-900/50 transition-colors">
                          Cancel
                        </Button>
                      ) : (
                        <Badge variant="secondary" className="bg-[#1a1a1a] text-zinc-500 uppercase text-[10px]">
                          {invite.status}
                        </Badge>
                      )}
                    </div>
                  ))}
                  {invites.length === 0 ? <p className="text-sm text-zinc-500 italic p-2 rounded bg-[#0a0a0a] border border-dashed border-[#222]">No invites yet.</p> : null}
                </>
              )}
            </div>
          </div>

        </CardContent>
      </Card>
    </div>
  );
};
