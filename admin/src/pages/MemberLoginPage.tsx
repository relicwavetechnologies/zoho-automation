import { useState, FormEvent } from 'react';
import { api } from '../lib/api';

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
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: '#0a0a0a' }}>
      <div className="w-full max-w-md">
        <div className="border border-zinc-800 rounded-xl p-6" style={{ background: '#111' }}>
          <div className="mb-6">
            <h1 className="text-lg font-medium text-zinc-100">
              {isDesktopFlow ? 'Sign in to Desktop' : 'Member Sign In'}
            </h1>
            <p className="text-sm text-zinc-500 mt-1">
              {isDesktopFlow
                ? 'Sign in to connect your desktop app.'
                : 'Sign in with your workspace credentials.'}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm text-zinc-400">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
                placeholder="you@company.com"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm text-zinc-400">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-100 text-sm placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
                placeholder="Enter your password"
              />
            </div>

            {error && (
              <div className="px-3 py-2 rounded-lg bg-red-950 border border-red-900 text-sm text-red-400">
                {error}
              </div>
            )}

            {success && (
              <div className="px-3 py-2 rounded-lg bg-emerald-950 border border-emerald-900 text-sm text-emerald-400">
                {success}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full px-4 py-2 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-medium hover:bg-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <div className="mt-4 text-center">
            <a href="/login" className="text-xs text-zinc-600 hover:text-zinc-400">
              Admin login
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};
