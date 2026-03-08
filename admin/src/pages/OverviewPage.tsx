import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { roleLabel } from '../lib/labels';

export const OverviewPage = () => {
  const { session, navItems, loading } = useAdminAuth();
  const isSuperAdmin = session?.role === 'SUPER_ADMIN';

  return (
    <div className="flex flex-col gap-6 max-w-5xl">
      <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
        <CardHeader className="border-b border-[#1a1a1a] pb-4">
          <CardTitle className="text-zinc-100">{isSuperAdmin ? 'Global Overview' : 'Workspace Overview'}</CardTitle>
          <CardDescription className="text-zinc-500">
            {isSuperAdmin
              ? 'This session is for cross-workspace inspection and governance. Workspace setup is intentionally pushed down to workspace-admin sessions.'
              : 'This session can operate directly on one workspace, including members, integrations, controls, and tool access.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-6 space-y-4">
          {loading ? (
            <>
              <div className="flex items-center justify-between pb-4 border-b border-[#1a1a1a] h-[45px]">
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-32" />
              </div>
              <div className="flex items-center justify-between pb-4 border-b border-[#1a1a1a] h-[45px]">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-48" />
              </div>
              <div className="flex items-center justify-between pb-4 border-b border-[#1a1a1a] h-[45px]">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-8" />
              </div>
              <div className="h-[52px] rounded-md border border-[#1a1a1a] bg-[#0a0a0a] p-4">
                <Skeleton className="h-4 w-3/4" />
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between pb-4 border-b border-[#1a1a1a]">
                <span className="text-sm text-zinc-400">Role</span>
                <Badge variant="secondary" className="bg-[#1a1a1a] text-zinc-100 uppercase tracking-widest text-[10px] px-2 py-0.5">{roleLabel(session?.role)}</Badge>
              </div>
              <div className="flex items-center justify-between pb-4 border-b border-[#1a1a1a]">
                <span className="text-sm text-zinc-400">Scope</span>
                <Badge variant="outline" className="border-[#222] text-zinc-400 bg-transparent">{session?.companyId ?? 'All workspaces'}</Badge>
              </div>
              <div className="flex items-center justify-between pb-4 border-b border-[#1a1a1a]">
                <span className="text-sm text-zinc-400">Visible Panels</span>
                <Badge variant="outline" className="border-[#222] text-zinc-400 bg-transparent">{String(navItems.length)}</Badge>
              </div>
              <div className="rounded-md border border-[#1a1a1a] bg-[#0a0a0a] p-4 text-sm text-zinc-400">
                {isSuperAdmin
                  ? 'Use Workspaces and Integrations to inspect tenant health, sync status, identities, and audit surfaces without mutating workspace credentials from a global session.'
                  : 'Use Integrations for Zoho and Lark setup, Members for invites, and Tool Access/RBAC for runtime permissions.'}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
