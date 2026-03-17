import { LayoutDashboard, Shield, Building2, Users, Activity, Settings, ArrowRight } from 'lucide-react';
import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { roleLabel } from '../lib/labels';
import { Button } from '../components/ui/button';
import { NavLink } from 'react-router-dom';

export const OverviewPage = () => {
  const { session, navItems, loading } = useAdminAuth();
  const isSuperAdmin = session?.role === 'SUPER_ADMIN';

  return (
    <div className="flex flex-col gap-10 max-w-6xl animate-in fade-in duration-700 pb-20">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/5 border border-primary/20 flex items-center justify-center">
            <LayoutDashboard className="h-6 w-6 text-primary" />
          </div>
          {isSuperAdmin ? 'Platform Overview' : 'Dashboard Overview'}
        </h1>
        <p className="text-muted-foreground text-base max-w-2xl leading-relaxed">
          {isSuperAdmin
            ? 'Global control plane for managing companies, AI operations, and platform-wide configurations.'
            : 'Company control plane for directory management, departments, and AI execution monitoring.'}
        </p>
      </div>

      <div className="grid gap-5 md:grid-cols-3">
        <Card className="bg-card/50 border-border/40 shadow-xl backdrop-blur-sm transition-all hover:border-primary/30 group">
          <CardHeader className="pb-2">
            <CardDescription className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">Session Role</CardDescription>
            <CardTitle className="text-xl font-bold flex items-center gap-2.5">
              <Shield className="h-4 w-4 text-primary group-hover:scale-110 transition-transform" />
              {roleLabel(session?.role)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="outline" className="bg-emerald-500/5 border-emerald-500/20 text-emerald-500 text-[9px] font-bold uppercase tracking-widest h-4 px-1.5">
              Secure Auth
            </Badge>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-border/40 shadow-xl backdrop-blur-sm transition-all hover:border-primary/30 group">
          <CardHeader className="pb-2">
            <CardDescription className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">Active Scope</CardDescription>
            <CardTitle className="text-xl font-bold flex items-center gap-2.5">
              <Building2 className="h-4 w-4 text-primary group-hover:scale-110 transition-transform" />
              {isSuperAdmin ? 'Global' : 'Workspace'}
            </CardTitle>
          </CardHeader>
          <CardContent>
             <span className="text-[11px] font-mono text-muted-foreground/80 truncate block bg-muted/30 p-1 rounded-md border border-border/20">
              {session?.companyId || 'PLATFORM_WIDE'}
            </span>
          </CardContent>
        </Card>

        <Card className="bg-card/50 border-border/40 shadow-xl backdrop-blur-sm transition-all hover:border-primary/30 group">
          <CardHeader className="pb-2">
            <CardDescription className="text-[9px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">System Panels</CardDescription>
            <CardTitle className="text-xl font-bold flex items-center gap-2.5">
              <Activity className="h-4 w-4 text-primary group-hover:scale-110 transition-transform" />
              {navItems.length} Available
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex -space-x-2.5">
              {navItems.slice(0, 5).map((_, i) => (
                <div key={i} className="h-7 w-7 rounded-full border-2 border-card bg-muted/50 ring-1 ring-border/20 shadow-inner" />
              ))}
              {navItems.length > 5 && (
                <div className="h-7 w-7 rounded-full border-2 border-card bg-primary/10 flex items-center justify-center text-[9px] font-bold text-primary ring-1 ring-primary/20">
                  +{navItems.length - 5}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6">
        <Card className="bg-card/30 border-border/40 shadow-2xl overflow-hidden backdrop-blur-md">
          <CardHeader className="border-b border-border/40 bg-muted/20 pb-5 pt-6 px-6 flex flex-row items-end justify-between">
            <div className="space-y-1">
              <CardTitle className="text-xl font-bold tracking-tight">Quick Navigation</CardTitle>
              <CardDescription className="text-sm text-muted-foreground font-medium">
                Access core platform management surfaces directly.
              </CardDescription>
            </div>
            <Badge variant="secondary" className="mb-1 uppercase tracking-widest text-[8px] font-bold">Control Layer</Badge>
          </CardHeader>
          <CardContent className="p-0">
            <div className="grid grid-cols-1 md:grid-cols-2 divide-y divide-x divide-border/40 border-b border-border/40">
              {navItems.map((item) => (
                <NavLink 
                  key={item.id} 
                  to={item.path}
                  className="flex items-center justify-between p-6 hover:bg-primary/5 transition-all group relative overflow-hidden"
                >
                  <div className="absolute top-0 left-0 w-1 h-full bg-primary scale-y-0 group-hover:scale-y-100 transition-transform duration-300" />
                  <div className="flex items-center gap-5">
                    <div className="h-11 w-11 rounded-xl bg-muted/50 border border-border/40 flex items-center justify-center group-hover:bg-primary/10 group-hover:border-primary/30 transition-all duration-500 shadow-sm group-hover:shadow-lg">
                      <ArrowRight className="h-5 w-5 -rotate-45 group-hover:rotate-0 transition-transform duration-500 text-muted-foreground group-hover:text-primary" />
                    </div>
                    <div>
                      <div className="text-base font-bold text-foreground group-hover:text-primary transition-colors tracking-tight">{item.label}</div>
                      <div className="text-xs text-muted-foreground/70 font-medium">Launch {item.label.toLowerCase()} control unit</div>
                    </div>
                  </div>
                  <Badge variant="outline" className="opacity-0 group-hover:opacity-100 transition-all duration-500 translate-x-2 group-hover:translate-x-0 border-primary/30 text-primary text-[10px]">
                    Launch
                  </Badge>
                </NavLink>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
           <Card className="bg-primary/5 border-primary/20 shadow-2xl p-6 flex flex-col justify-between group hover:bg-primary/[0.07] transition-all duration-500 relative overflow-hidden">
            <div className="absolute -top-10 -right-10 h-32 w-32 bg-primary/5 rounded-full blur-3xl group-hover:bg-primary/10 transition-all" />
            <div className="space-y-2.5 relative z-10">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center mb-1">
                <Users className="h-5 w-5 text-primary" />
              </div>
              <h3 className="text-xl font-bold text-foreground tracking-tight">
                Identity Directory
              </h3>
              <p className="text-sm text-muted-foreground font-medium leading-relaxed">
                Inspect synced identities, verify Lark membership status, and manage workspace-level access controls.
              </p>
            </div>
            <Button asChild variant="outline" className="w-fit mt-6 border-primary/30 hover:bg-primary hover:text-primary-foreground font-bold uppercase tracking-widest text-[9px] h-9 px-5 transition-all duration-500 shadow-lg relative z-10">
              <NavLink to="/members" className="flex items-center gap-2">Manage Directory <ArrowRight className="h-2.5 w-2.5" /></NavLink>
            </Button>
          </Card>

          <Card className="bg-card/30 border-border/40 shadow-2xl p-6 flex flex-col justify-between group hover:bg-muted/30 transition-all duration-500 relative overflow-hidden backdrop-blur-sm">
            <div className="absolute -top-10 -right-10 h-32 w-32 bg-muted/50 rounded-full blur-3xl group-hover:bg-muted/80 transition-all" />
            <div className="space-y-2.5 relative z-10">
              <div className="h-10 w-10 rounded-lg bg-muted/50 flex items-center justify-center mb-1">
                <Settings className="h-5 w-5 text-foreground" />
              </div>
              <h3 className="text-xl font-bold text-foreground tracking-tight">
                Core Governance
              </h3>
              <p className="text-sm text-muted-foreground font-medium leading-relaxed">
                Configure platform integrations, manage audit logs, and define global security postures.
              </p>
            </div>
            <Button asChild variant="outline" className="w-fit mt-6 border-border/60 hover:bg-foreground hover:text-background font-bold uppercase tracking-widest text-[9px] h-9 px-5 transition-all duration-500 shadow-lg relative z-10">
              <NavLink to="/settings" className="flex items-center gap-2">System Settings <ArrowRight className="h-2.5 w-2.5" /></NavLink>
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
};
