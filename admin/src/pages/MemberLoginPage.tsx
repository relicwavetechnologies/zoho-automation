import { useState, FormEvent } from 'react';
import { api } from '../lib/api';
import { ShieldCheck, Sparkles, ArrowRight } from 'lucide-react';

export const MemberLoginPage = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const isDesktopFlow = window.location.search.includes('desktop=true');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const result = await api.post<{ token: string; session: { userId: string; companyId: string; role: string } }>(
        '/api/member/auth/login',
        { email, password },
      );

      if (isDesktopFlow) {
        // Generate a desktop handoff code and redirect back to the desktop app
        const handoff = await api.post<{ code: string; expiresAt: string }>(
          '/api/desktop/auth/handoff',
          {},
          result.token,
        );

        // Redirect to custom protocol
        window.location.href = `cursorr://auth/callback?code=${handoff.code}`;
        setSuccess('Redirecting to desktop app...');
      } else {
        setSuccess('Login successful. You can close this page.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
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
            <h1 className="text-2xl font-bold tracking-tight">
              {isDesktopFlow ? 'Authorize Desktop' : 'Sign in to Divo'}
            </h1>
            <p className="text-sm text-muted-foreground font-medium">
              {isDesktopFlow ? 'Connect your local AI coworker' : 'Access your professional workspace'}
            </p>
          </div>
        </div>

        <div className="bg-card border border-border rounded-2xl p-8 shadow-2xl shadow-black/40">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground/80 ml-1">Work Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 py-3 rounded-xl bg-background border border-border text-foreground text-sm placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/50 transition-all"
                placeholder="you@company.com"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground/80 ml-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full px-4 py-3 rounded-xl bg-background border border-border text-foreground text-sm placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/50 transition-all"
                placeholder="Enter your password"
              />
            </div>

            {error && (
              <div className="px-4 py-3 rounded-xl bg-destructive/10 border border-destructive/20 text-xs font-medium text-destructive flex items-center gap-2 animate-in slide-in-from-top-1">
                <div className="h-1.5 w-1.5 rounded-full bg-destructive" />
                {error}
              </div>
            )}

            {success && (
              <div className="px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-xs font-medium text-emerald-500 flex items-center gap-2 animate-in slide-in-from-top-1">
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {success}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-12 flex items-center justify-center gap-2 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-[0.98] shadow-lg shadow-primary/10"
            >
              {loading ? 'Authenticating...' : (
                <>
                  <span>Sign In</span>
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>

          <div className="mt-8 text-center border-t border-border/40 pt-6">
            <a href="/login" className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/40 hover:text-primary transition-colors">
              Administrative Access
            </a>
          </div>
        </div>

        {/* Footer branding */}
        <div className="flex items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/20 pt-4">
          <ShieldCheck size={12} />
          <span>Intelligent Workplace</span>
        </div>
      </div>
    </div>
  );
};
