import { useAuth } from '../context/AuthContext'
import { cn } from '../lib/utils'
import { ShieldCheck, Sparkles } from 'lucide-react'

export function LoginScreen(): JSX.Element {
  const { openLarkLogin, loading, error } = useAuth()

  return (
    <div className="flex h-full items-center justify-center bg-background antialiased selection:bg-primary/30">
      <div className="flex flex-col items-center gap-10 max-w-sm w-full px-8 py-12">
        
        {/* Divo Branding */}
        <div className="flex flex-col items-center gap-6 group">
          <div className="relative">
            <div className="absolute -inset-4 bg-primary/20 rounded-full blur-2xl group-hover:bg-primary/30 transition-all duration-500 opacity-50" />
            <div className="relative h-20 w-20 rounded-[24px] bg-card border border-border flex items-center justify-center shadow-2xl shadow-black/50 group-hover:scale-105 group-hover:border-primary/50 transition-all duration-300">
              <span className="text-4xl font-bold bg-gradient-to-br from-white to-white/60 bg-clip-text text-transparent">D</span>
              <div className="absolute -top-1 -right-1">
                 <Sparkles className="text-primary animate-pulse" size={20} fill="currentColor" />
              </div>
            </div>
          </div>
          
          <div className="flex flex-col items-center gap-2">
            <h1 className="text-3xl font-bold text-foreground tracking-tight text-center">
              Meet <span className="text-primary">Divo</span>
            </h1>
            <p className="text-[13px] text-muted-foreground text-center leading-relaxed font-medium">
              Your professional AI coworker for Zoho, Outreach, and Lark automation.
            </p>
          </div>
        </div>

        <div className="w-full space-y-4">
          <button
            onClick={() => void openLarkLogin()}
            disabled={loading}
            className={cn(
              'w-full h-12 flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-all duration-200 shadow-lg shadow-primary/10',
              'bg-primary text-primary-foreground hover:bg-primary/90 hover:scale-[1.02] active:scale-[0.98]',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100',
            )}
          >
            {loading ? (
              <div className="h-4 w-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
            ) : (
              <>
                <ShieldCheck size={18} />
                <span>Continue with Lark</span>
              </>
            )}
          </button>

          {/* Error display */}
          {error && (
            <div className="w-full px-4 py-3 rounded-xl bg-destructive/10 border border-destructive/20 text-[13px] text-destructive flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
              <div className="h-1.5 w-1.5 rounded-full bg-destructive animate-pulse" />
              {error}
            </div>
          )}

          <div className="flex flex-col gap-4 pt-2">
            <p className="text-[11px] text-muted-foreground/40 text-center leading-normal px-4">
              Requires a connected Lark workspace account. 
              Your email must match an existing company member.
            </p>
          </div>
        </div>

        {/* Footer branding */}
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/20">
          <div className="h-px w-8 bg-current" />
          <span>Intelligent Automation</span>
          <div className="h-px w-8 bg-current" />
        </div>
      </div>
    </div>
  )
}
