import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { roleLabel } from '../lib/labels';

export const OverviewPage = () => {
  const { session, navItems, loading } = useAdminAuth();

  return (
    <Card className="bg-[#111] border-[#1a1a1a] shadow-md shadow-black/20 text-zinc-300">
      <CardHeader className="border-b border-[#1a1a1a] pb-4">
        <CardTitle className="text-zinc-100">Overview</CardTitle>
        <CardDescription className="text-zinc-500">
          Backend capabilities and authorization define what this session can access.
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
            <div className="flex items-center justify-between h-[28px]">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-8" />
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between pb-4 border-b border-[#1a1a1a]">
              <span className="text-sm text-zinc-400">Role</span>
              <Badge variant="secondary" className="bg-[#1a1a1a] text-zinc-100 uppercase tracking-widest text-[10px] px-2 py-0.5">{roleLabel(session?.role)}</Badge>
            </div>
            <div className="flex items-center justify-between pb-4 border-b border-[#1a1a1a]">
              <span className="text-sm text-zinc-400">Workspace Scope</span>
              <Badge variant="outline" className="border-[#222] text-zinc-400 bg-transparent">{session?.companyId ?? 'Global'}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-zinc-400">Capability Links</span>
              <Badge variant="outline" className="border-[#222] text-zinc-400 bg-transparent">{String(navItems.length)}</Badge>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
};
