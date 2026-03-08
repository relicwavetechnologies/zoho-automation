import { FormEvent, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { cn } from '../lib/utils'

export function LoginScreen(): JSX.Element {
  const { login, openBrowserLogin, loading, error } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    await login(email.trim(), password)
  }

  return (
    <div className="flex h-full items-center justify-center" style={{ background: 'hsl(0 0% 4%)' }}>
      <div className="flex flex-col items-center gap-8 max-w-sm px-6">
        {/* Logo / Brand */}
        <div className="flex flex-col items-center gap-3">
          <div className="h-12 w-12 rounded-xl bg-[hsl(0,0%,12%)] border border-[hsl(0,0%,18%)] flex items-center justify-center">
            <span className="text-lg font-semibold text-[hsl(0,0%,70%)]">C</span>
          </div>
          <h1 className="text-xl font-medium text-[hsl(0,0%,88%)] tracking-tight">
            Cursorr Desktop
          </h1>
          <p className="text-sm text-[hsl(0,0%,45%)] text-center leading-relaxed">
            AI workspace for Zoho, Outreach, and Lark automation.
            Sign in with your workspace member account or continue through your browser.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="w-full flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-[hsl(0,0%,45%)]">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              required
              className="w-full rounded-lg border border-[hsl(0,0%,16%)] bg-[hsl(0,0%,7%)] px-3 py-2.5 text-sm text-[hsl(0,0%,88%)] outline-none transition-colors placeholder:text-[hsl(0,0%,28%)] focus:border-[hsl(0,0%,32%)]"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium uppercase tracking-wide text-[hsl(0,0%,45%)]">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
              required
              className="w-full rounded-lg border border-[hsl(0,0%,16%)] bg-[hsl(0,0%,7%)] px-3 py-2.5 text-sm text-[hsl(0,0%,88%)] outline-none transition-colors placeholder:text-[hsl(0,0%,28%)] focus:border-[hsl(0,0%,32%)]"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !email.trim() || !password}
            className={cn(
              'mt-2 w-full px-5 py-2.5 rounded-lg text-sm font-medium transition-all',
              'bg-[hsl(0,0%,93%)] text-[hsl(0,0%,7%)]',
              'hover:bg-[hsl(0,0%,85%)]',
              'disabled:opacity-40 disabled:cursor-not-allowed',
            )}
          >
            {loading ? 'Signing in...' : 'Sign in with Email'}
          </button>
        </form>

        <div className="w-full flex items-center gap-3 text-[10px] uppercase tracking-[0.2em] text-[hsl(0,0%,28%)]">
          <div className="h-px flex-1 bg-[hsl(0,0%,14%)]" />
          <span>or</span>
          <div className="h-px flex-1 bg-[hsl(0,0%,14%)]" />
        </div>

        <button
          onClick={() => void openBrowserLogin()}
          disabled={loading}
          className={cn(
            'w-full px-5 py-2.5 rounded-lg text-sm font-medium transition-all',
            'border border-[hsl(0,0%,16%)] bg-[hsl(0,0%,8%)] text-[hsl(0,0%,82%)]',
            'hover:bg-[hsl(0,0%,11%)] hover:border-[hsl(0,0%,24%)]',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          )}
        >
          {loading ? 'Working...' : 'Continue in Browser'}
        </button>

        {/* Error display */}
        {error && (
          <div className="w-full px-3 py-2 rounded-lg bg-[hsl(0,50%,12%)] border border-[hsl(0,50%,20%)] text-sm text-[hsl(0,60%,70%)]">
            {error}
          </div>
        )}

        {/* Help text */}
        <p className="text-xs text-[hsl(0,0%,35%)] text-center">
          Use your workspace member credentials for direct sign-in.
          Browser sign-in remains available if you need the desktop handoff flow.
        </p>
      </div>
    </div>
  )
}
