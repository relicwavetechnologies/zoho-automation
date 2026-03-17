import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Users, UserPlus, Search, Shield, Globe, Mail, CheckCircle2, Clock, XCircle, MoreHorizontal, Filter } from 'lucide-react';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Avatar, AvatarFallback } from '../components/ui/avatar';
import { api } from '../lib/api';
import { roleLabel } from '../lib/labels';
import { Separator } from '../components/ui/separator';
import { ScrollArea } from '../components/ui/scroll-area';

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

type DirectoryEntry = {
  key: string;
  userId?: string;
  channelIdentityId?: string;
  name?: string;
  email?: string;
  source: 'app' | 'lark' | 'app+lark';
  appStatus: 'joined_app' | 'lark_only';
  companyRole?: string;
  larkLinked: boolean;
  googleConnected: boolean;
  departmentCount: number;
  managerDepartmentCount: number;
  departmentNames: string[];
  larkRoles: string[];
  createdAt?: string;
  updatedAt?: string;
};

const sourceLabel = (source: DirectoryEntry['source']) => {
  switch (source) {
    case 'app+lark':
      return 'App + Lark';
    case 'app':
      return 'App only';
    default:
      return 'Lark only';
  }
};

export const MembersPage = () => {
  const { token, session } = useAdminAuth();
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRoleId, setInviteRoleId] = useState<'MEMBER' | 'COMPANY_ADMIN'>('MEMBER');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const isSuperAdmin = session?.role === 'SUPER_ADMIN';
  const canInviteCompanyAdmins = isSuperAdmin;
  const scopedCompanyId = useMemo(() => (isSuperAdmin ? companyId.trim() : undefined), [companyId, isSuperAdmin]);

  const load = async (options?: { silent?: boolean }) => {
    if (!token) return;
    if (isSuperAdmin && !scopedCompanyId) {
      setDirectory([]);
      setInvites([]);
      return;
    }

    if (!options?.silent) setLoading(true);
    setError(null);
    try {
      const query = scopedCompanyId ? `?companyId=${encodeURIComponent(scopedCompanyId)}` : '';
      const [directoryData, invitesData] = await Promise.all([
        api.get<DirectoryEntry[]>(`/api/admin/company/directory${query}`, token),
        api.get<Invite[]>(`/api/admin/company/invites${query}`, token),
      ]);
      setDirectory(directoryData);
      setInvites(invitesData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load company directory.');
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
      await load({ silent: true });
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
      await load({ silent: true });
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Invite cancel failed.');
    }
  };

  const filteredDirectory = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return directory;
    return directory.filter((entry) => {
      const haystack = [
        entry.name,
        entry.email,
        entry.companyRole,
        entry.source,
        ...entry.departmentNames,
        ...entry.larkRoles,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [directory, search]);

  const stats = useMemo(() => {
    const joinedApp = directory.filter((entry) => entry.appStatus === 'joined_app').length;
    const managers = directory.filter((entry) => entry.managerDepartmentCount > 0).length;
    return {
      total: directory.length,
      joinedApp,
      managers,
    };
  }, [directory]);

  return (
    <div className="flex flex-col gap-8 w-full animate-in fade-in duration-700">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" />
            People
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage company directory, synced identities, and app membership.
          </p>
        </div>
        {isSuperAdmin ? (
          <div className="w-full md:w-[320px]">
            <Input
              value={companyId}
              onChange={(event) => setCompanyId(event.target.value)}
              placeholder="Paste company UUID"
              className="bg-secondary/30 border-border/50 h-9 text-xs"
            />
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="bg-card border-border/50 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Total Directory</CardDescription>
            <CardTitle className="text-3xl font-bold text-foreground">{stats.total}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="bg-card border-border/50 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Joined App</CardDescription>
            <CardTitle className="text-3xl font-bold text-foreground">{stats.joinedApp}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="bg-card border-border/50 shadow-sm">
          <CardHeader className="pb-2">
            <CardDescription className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Managers</CardDescription>
            <CardTitle className="text-3xl font-bold text-foreground">{stats.managers}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_340px] items-start">
        <div className="space-y-6">
          <Card className="bg-card border-border/50 shadow-md overflow-hidden">
            <CardHeader className="border-b border-border/50 bg-secondary/5 px-6 py-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <CardTitle className="text-lg font-bold">Company Directory</CardTitle>
                <div className="relative group w-full md:w-64">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground group-focus-within:text-foreground transition-colors" />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Filter members..."
                    className="bg-background border-border/50 h-8 text-xs pl-8"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[calc(100vh-480px)] min-h-[400px]">
                <div className="divide-y divide-border/50">
                  {loading ? (
                    <div className="p-6 space-y-4">
                      <Skeleton className="h-16 w-full rounded-xl" />
                      <Skeleton className="h-16 w-full rounded-xl" />
                      <Skeleton className="h-16 w-full rounded-xl" />
                    </div>
                  ) : filteredDirectory.length === 0 ? (
                    <div className="p-12 text-center">
                      <p className="text-sm text-muted-foreground">No members matched your search.</p>
                    </div>
                  ) : (
                    filteredDirectory.map((entry) => (
                      <div key={entry.key} className="p-4 hover:bg-secondary/20 transition-colors flex items-start justify-between group">
                        <div className="flex items-center gap-4 min-w-0">
                          <Avatar className="h-10 w-10 rounded-lg border border-border/50 shadow-sm">
                            <AvatarFallback className="rounded-lg bg-secondary text-secondary-foreground text-xs font-bold uppercase">
                              {(entry.name || entry.email || '?')[0]}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="text-sm font-bold text-foreground flex items-center gap-2">
                              {entry.name?.trim() || entry.email?.trim() || 'Unknown Member'}
                              {entry.companyRole && (
                                <Badge variant="outline" className="text-[9px] h-4 font-bold uppercase bg-primary/5 text-primary border-primary/20">
                                  {roleLabel(entry.companyRole)}
                                </Badge>
                              )}
                            </div>
                            <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-2 truncate">
                              <Mail className="h-3 w-3" />
                              {entry.email ?? 'No email synced'}
                              <span>·</span>
                              <span>{sourceLabel(entry.source)}</span>
                            </div>
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {entry.appStatus === 'joined_app' ? (
                                <Badge variant="secondary" className="text-[9px] h-4 font-bold uppercase text-emerald-500 bg-emerald-500/5 border-emerald-500/10">Joined App</Badge>
                              ) : (
                                <Badge variant="outline" className="text-[9px] h-4 font-bold uppercase text-muted-foreground">Lark Only</Badge>
                              )}
                              {entry.managerDepartmentCount > 0 && (
                                <Badge variant="secondary" className="text-[9px] h-4 font-bold uppercase text-violet-500 bg-violet-500/5 border-violet-500/10">Manager</Badge>
                              )}
                              {entry.departmentNames.slice(0, 2).map(dept => (
                                <Badge key={dept} variant="outline" className="text-[9px] h-4 font-medium max-w-[100px] truncate">{dept}</Badge>
                              ))}
                              {entry.departmentNames.length > 2 && <span className="text-[9px] text-muted-foreground">+{entry.departmentNames.length - 2}</span>}
                            </div>
                          </div>
                        </div>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="bg-card border-border/50 shadow-md">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg font-bold flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-primary" />
                Invite Members
              </CardTitle>
              <CardDescription className="text-xs">
                Send onboarding invites to workspace users.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={createInvite}>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground ml-1">Email Address</label>
                  <Input
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    type="email"
                    placeholder="user@company.com"
                    className="bg-secondary/30 border-border/50 h-9 text-sm"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground ml-1">Assign Role</label>
                  <Select value={inviteRoleId} onValueChange={(val) => setInviteRoleId(val as 'MEMBER' | 'COMPANY_ADMIN')}>
                    <SelectTrigger className="bg-secondary/30 border-border/50 h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MEMBER">{roleLabel('MEMBER')}</SelectItem>
                      {canInviteCompanyAdmins && (
                        <SelectItem value="COMPANY_ADMIN">{roleLabel('COMPANY_ADMIN')}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" className="w-full bg-primary text-primary-foreground font-bold uppercase tracking-widest text-[10px] h-9 shadow-sm">
                  Send Invite
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card className="bg-card border-border/50 shadow-sm overflow-hidden">
            <CardHeader className="bg-secondary/10 py-3 border-b border-border/50">
              <CardTitle className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Pending Invites</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border/50 max-h-[400px] overflow-auto">
                {invites.length === 0 ? (
                  <div className="p-6 text-center text-[11px] text-muted-foreground">
                    No active invitations.
                  </div>
                ) : (
                  invites.map((invite) => (
                    <div key={invite.inviteId} className="p-4 flex flex-col gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-foreground truncate max-w-[180px]">{invite.email}</span>
                        {invite.status === 'pending' ? (
                          <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20 text-[9px] h-4 font-bold uppercase">Pending</Badge>
                        ) : (
                          <Badge className="bg-secondary text-muted-foreground text-[9px] h-4 font-bold uppercase">{invite.status}</Badge>
                        )}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-muted-foreground uppercase font-medium">{roleLabel(invite.roleId)}</span>
                        {invite.status === 'pending' && (
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            onClick={() => void cancelInvite(invite.inviteId)}
                            className="h-6 px-2 text-[9px] font-bold uppercase tracking-wider text-destructive hover:bg-destructive/10"
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};
