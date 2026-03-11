import { useAuth } from '../context/AuthContext'
import { cn } from '../lib/utils'

export function LoginScreen(): JSX.Element {
  const { openLarkLogin, loading, error } = useAuth()

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
            Sign in with your connected Lark workspace account to use the same Lark-powered flow from desktop.
          </p>
        </div>

        <button
          onClick={() => void openLarkLogin()}
          disabled={loading}
          className={cn(
            'w-full px-5 py-2.5 rounded-lg text-sm font-medium transition-all',
            'bg-[hsl(0,0%,93%)] text-[hsl(0,0%,7%)]',
            'hover:bg-[hsl(0,0%,85%)]',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          )}
        >
          {loading ? 'Opening Lark…' : 'Continue with Lark'}
        </button>

        {/* Error display */}
        {error && (
          <div className="w-full px-3 py-2 rounded-lg bg-[hsl(0,50%,12%)] border border-[hsl(0,50%,20%)] text-sm text-[hsl(0,60%,70%)]">
            {error}
          </div>
        )}

        {/* Help text */}
        <p className="text-xs text-[hsl(0,0%,35%)] text-center">
          Your company must already have Lark installed, and your Lark email must match an existing workspace member account.
        </p>
      </div>
    </div>
  )
}
