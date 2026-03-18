import { FormEvent, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';

import { useAdminAuth } from '../auth/AdminAuthProvider';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { ShieldCheck, Sparkles } from 'lucide-react';

export const LoginPage = () => {
  const { session, loginCompanyAdmin, loginSuperAdmin } = useAdminAuth();
  const [mode, setMode] = useState<'super' | 'company'>('company');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (session) {
    return <Navigate to="/home" replace />;
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
    <div className="min-h-screen flex items-center justify-center bg-background p-4 text-foreground antialiased font-sans">
      <div className="w-full max-w-md space-y-8 animate-in fade-in zoom-in-95 duration-500">
        
        {/* Logo Section */}
        <div className="flex flex-col items-center gap-6">
          <div className="relative group">
            <div className="absolute -inset-4 bg-primary/20 rounded-full blur-2xl group-hover:bg-primary/30 transition-all duration-500 opacity-50" />
            <div className="relative h-16 w-16 rounded-2xl bg-card border border-border flex items-center justify-center shadow-2xl shadow-black/50 transition-transform duration-300 group-hover:scale-105 group-hover:border-primary/50">
              <span className="text-3xl font-bold bg-gradient-to-br from-white to-white/60 bg-clip-text text-transparent">D</span>
              <div className="absolute -top-1 -right-1">
                 <Sparkles className="text-primary animate-pulse" size={16} fill="currentColor" />
              </div>
            </div>
          </div>
          <div className="text-center space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Divo Control Hub</h1>
            <p className="text-sm text-muted-foreground font-medium">Manage your intelligent workspace</p>
          </div>
        </div>

        <Card className="bg-card border-border shadow-2xl shadow-black/40 overflow-hidden">
          <CardHeader className="space-y-1 pb-6 border-b border-border/40">
            <div className="flex p-1 bg-muted/40 rounded-xl border border-border/20">
              <button
                type="button"
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all ${mode === 'company' ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/20' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setMode('company')}
              >
                Company Admin
              </button>
              <button
                type="button"
                className={`flex-1 py-2 text-xs font-semibold rounded-lg transition-all ${mode === 'super' ? 'bg-primary text-primary-foreground shadow-lg shadow-primary/20' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => setMode('super')}
              >
                Super Admin
              </button>
            </div>
          </CardHeader>

          <CardContent className="pt-8">
            <form onSubmit={onSubmit} className="space-y-5">
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground/80 ml-1">Admin Email</label>
                <Input
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                  placeholder="admin@company.com"
                  className="bg-background border-border focus-visible:ring-primary/50 h-11 rounded-xl"
                  required
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground/80 ml-1">Password</label>
                <Input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  placeholder="••••••••"
                  className="bg-background border-border focus-visible:ring-primary/50 h-11 rounded-xl"
                  required
                />
              </div>

              {error && (
                <div className="bg-destructive/10 border border-destructive/20 text-destructive p-3.5 rounded-xl text-xs font-medium flex items-center gap-2 animate-in slide-in-from-top-1">
                  <div className="h-1.5 w-1.5 rounded-full bg-destructive" />
                  {error}
                </div>
              )}

              <Button 
                disabled={submitting} 
                type="submit" 
                className="w-full h-11 bg-primary text-primary-foreground hover:bg-primary/90 font-bold rounded-xl transition-all active:scale-[0.98] shadow-lg shadow-primary/10"
              >
                {submitting ? 'Authenticating...' : 'Sign In to Hub'}
              </Button>

              <div className="flex flex-col gap-3 pt-2 text-center">
                <Link className="text-xs text-muted-foreground hover:text-primary transition-colors font-medium" to="/signup/company-admin">
                  Create company admin account
                </Link>
                <div className="h-px w-8 bg-border/40 mx-auto" />
                <Link className="text-xs text-muted-foreground hover:text-primary transition-colors font-medium" to="/signup/member-invite">
                  Accept invite to join company
                </Link>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Footer branding */}
        <div className="flex items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/20 pt-4">
          <ShieldCheck size={12} />
          <span>Secure Administration</span>
        </div>
      </div>
    </div>
  );
};
