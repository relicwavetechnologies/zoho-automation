import { Shield, Building2, Activity, Settings, ArrowRight, Users } from 'lucide-react';
import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { roleLabel } from '../lib/labels';
import { Button } from '../components/ui/button';
import { NavLink } from 'react-router-dom';
import { Logo } from '../components/Logo';

export const OverviewPage = () => {
  const { session, navItems } = useAdminAuth();
  const isSuperAdmin = session?.role === 'SUPER_ADMIN';

  return (
    <div className="flex flex-col gap-12 max-w-6xl animate-in fade-in duration-700 pb-20">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-2xl bg-secondary/40 border border-border/50 flex items-center justify-center shadow-sm">
            <Logo size={28} />
          </div>
          <div className="flex flex-col">
            <h1 className="text-[28px] font-bold tracking-tight text-foreground/90 leading-tight">
              {isSuperAdmin ? 'Platform Overview' : 'Dashboard Overview'}
            </h1>
            <p className="text-muted-foreground/50 text-[14px] font-medium leading-relaxed mt-1">
              {isSuperAdmin
                ? 'Global control plane for enterprise automation and configurations.'
                : 'Company control plane for directory and execution monitoring.'}
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="bg-secondary/20 border-border/50 transition-all hover:border-primary/30 group shadow-sm">
          <CardHeader className="pb-2 bg-transparent border-none">
            <CardDescription className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">Session Role</CardDescription>
            <CardTitle className="text-lg font-bold flex items-center gap-2.5 text-foreground/90 mt-1">
              <Shield className="h-4 w-4 text-primary opacity-70 group-hover:scale-110 transition-transform" />
              {roleLabel(session?.role)}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <Badge variant="outline" className="bg-emerald-500/5 border-emerald-500/20 text-emerald-500/70 text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-lg shadow-sm">
              Secure Auth
            </Badge>
          </CardContent>
        </Card>

        <Card className="bg-secondary/20 border-border/50 transition-all hover:border-primary/30 group shadow-sm">
          <CardHeader className="pb-2 bg-transparent border-none">
            <CardDescription className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">Active Scope</CardDescription>
            <CardTitle className="text-lg font-bold flex items-center gap-2.5 text-foreground/90 mt-1">
              <Building2 className="h-4 w-4 text-primary opacity-70 group-hover:scale-110 transition-transform" />
              {isSuperAdmin ? 'Global' : 'Workspace'}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
             <span className="text-[11px] font-mono text-muted-foreground/60 truncate block bg-black/20 px-2 py-1 rounded-lg border border-border/30">
              {session?.companyId || 'PLATFORM_WIDE'}
            </span>
          </CardContent>
        </Card>

        <Card className="bg-secondary/20 border-border/50 transition-all hover:border-primary/30 group shadow-sm">
          <CardHeader className="pb-2 bg-transparent border-none">
            <CardDescription className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">System Panels</CardDescription>
            <CardTitle className="text-lg font-bold flex items-center gap-2.5 text-foreground/90 mt-1">
              <Activity className="h-4 w-4 text-primary opacity-70 group-hover:scale-110 transition-transform" />
              {navItems.length} Available
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <div className="flex -space-x-2">
              {navItems.slice(0, 5).map((_, i) => (
                <div key={i} className="h-7 w-7 rounded-lg border border-border bg-black/20 shadow-sm" />
              ))}
              {navItems.length > 5 && (
                <div className="h-7 w-7 rounded-lg border border-primary/20 bg-primary/10 flex items-center justify-center text-[10px] font-bold text-primary/80 shadow-sm">
                  +{navItems.length - 5}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-8">
        <Card className="bg-secondary/10 border-border/50 shadow-sm overflow-hidden">
          <CardHeader className="border-b border-border/30 bg-black/5 pb-5 pt-6 px-8 flex flex-row items-end justify-between">
            <div className="space-y-1">
              <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">Navigation</div>
              <CardTitle className="text-xl font-bold tracking-tight text-foreground/90">Quick Access</CardTitle>
            </div>
            <Badge variant="secondary" className="mb-1 uppercase tracking-widest text-[9px] font-bold bg-secondary text-muted-foreground/60 border border-border/50">Control Layer</Badge>
          </CardHeader>
          <CardContent className="p-0">
            <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border/30">
              {navItems.map((item) => (
                <NavLink 
                  key={item.id} 
                  to={item.path}
                  className="flex items-center justify-between p-8 hover:bg-secondary/30 transition-all group relative"
                >
                  <div className="flex items-center gap-6">
                    <div className="h-10 w-10 rounded-xl bg-black/20 border border-border/50 flex items-center justify-center group-hover:border-primary/30 transition-all duration-500 shadow-sm">
                      <ArrowRight className="h-4 w-4 -rotate-45 group-hover:rotate-0 transition-transform duration-500 text-muted-foreground/40 group-hover:text-primary/80" />
                    </div>
                    <div>
                      <div className="text-base font-bold text-foreground/80 group-hover:text-foreground transition-colors tracking-tight">{item.label}</div>
                      <div className="text-xs text-muted-foreground/40 font-medium">Launch {item.label.toLowerCase()} module</div>
                    </div>
                  </div>
                  <div className="opacity-0 group-hover:opacity-100 transition-all duration-500 translate-x-2 group-hover:translate-x-0 text-[10px] font-black uppercase tracking-widest text-primary/60">
                    Open
                  </div>
                </NavLink>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-8 md:grid-cols-2">
           <Card className="bg-secondary/20 border-border/50 shadow-sm p-8 flex flex-col justify-between group hover:border-primary/20 transition-all duration-500 relative overflow-hidden">
            <div className="space-y-3 relative z-10">
              <div className="h-10 w-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-4 shadow-sm">
                <Users className="h-5 w-5 text-primary/80" />
              </div>
              <h3 className="text-xl font-bold text-foreground/90 tracking-tight">
                Identity Directory
              </h3>
              <p className="text-[14px] text-muted-foreground/50 font-medium leading-relaxed">
                Inspect synced identities, verify Lark membership status, and manage workspace-level access controls.
              </p>
            </div>
            <Button asChild variant="outline" className="w-fit mt-8 border-border bg-secondary/50 text-muted-foreground/70 hover:bg-secondary hover:text-foreground font-bold uppercase tracking-widest text-[10px] h-10 px-6 transition-all shadow-sm relative z-10">
              <NavLink to="/members" className="flex items-center gap-2">Manage Directory</NavLink>
            </Button>
          </Card>

          <Card className="bg-secondary/20 border-border/50 shadow-sm p-8 flex flex-col justify-between group hover:border-foreground/10 transition-all duration-500 relative overflow-hidden">
            <div className="space-y-3 relative z-10">
              <div className="h-10 w-10 rounded-xl bg-secondary border border-border flex items-center justify-center mb-4 shadow-sm">
                <Settings className="h-5 w-5 text-muted-foreground/60" />
              </div>
              <h3 className="text-xl font-bold text-foreground/90 tracking-tight">
                Core Governance
              </h3>
              <p className="text-[14px] text-muted-foreground/50 font-medium leading-relaxed">
                Configure platform integrations, manage audit logs, and define global security postures.
              </p>
            </div>
            <Button asChild variant="outline" className="w-fit mt-8 border-border bg-secondary/50 text-muted-foreground/70 hover:bg-secondary hover:text-foreground font-bold uppercase tracking-widest text-[10px] h-10 px-6 transition-all shadow-sm relative z-10">
              <NavLink to="/settings" className="flex items-center gap-2">System Settings</NavLink>
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
};
