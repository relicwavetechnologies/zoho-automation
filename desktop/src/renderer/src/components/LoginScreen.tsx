import { useAuth } from '../context/AuthContext'
import { cn } from '../lib/utils'
import { ShieldCheck, Sparkles } from 'lucide-react'
import { Logo } from './Logo'

export function LoginScreen(): JSX.Element {
  const { openLarkLogin, loading, error } = useAuth()

  return (
    <div className="flex h-full items-center justify-center bg-background antialiased selection:bg-primary/30">
      <div className="flex flex-col items-center gap-12 max-w-sm w-full px-8 py-16">
        
        {/* Divo Branding */}
        <div className="flex flex-col items-center gap-8 group">
          <div className="relative">
            <div className="absolute -inset-6 bg-primary/10 rounded-full blur-3xl opacity-50 group-hover:bg-primary/20 transition-all duration-700" />
            <div className="relative h-20 w-20 rounded-2xl bg-black/20 border border-border flex items-center justify-center shadow-2xl transition-all duration-500 group-hover:border-primary/30 group-hover:scale-105">
              <Logo size={44} />
            </div>
          </div>
          
          <div className="flex flex-col items-center gap-3">
            <h1 className="text-[10px] font-black uppercase tracking-[0.4em] text-primary/60">
              Introducing
            </h1>
            <div className="text-4xl font-bold text-foreground/90 tracking-tighter text-center">
              Divo
            </div>
            <p className="text-[13px] text-muted-foreground/50 text-center leading-relaxed font-medium max-w-[240px]">
              Your professional AI coworker for enterprise-scale automation.
            </p>
          </div>
        </div>

        <div className="w-full space-y-4">
          <button
            onClick={() => void openLarkLogin()}
            disabled={loading}
            className={cn(
              'w-full h-12 flex items-center justify-center gap-3 rounded-xl text-[12px] font-black uppercase tracking-widest transition-all duration-300 shadow-lg',
              'bg-primary text-primary-foreground hover:opacity-90 hover:scale-[1.01] active:scale-[0.99]',
              'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100',
            )}
          >
            {loading ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <>
                <ShieldCheck size={18} />
                <span>Sign in with Lark</span>
              </>
            )}
          </button>

          {/* Error display */}
          {error && (
            <div className="w-full px-4 py-3 rounded-xl bg-red-500/5 border border-red-500/10 text-[12px] text-red-500/70 font-medium flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
              <div className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
              {error}
            </div>
          )}

          <p className="text-[11px] text-muted-foreground/30 text-center leading-relaxed px-6 pt-4 font-medium uppercase tracking-wider">
            Enterprise authentication via Lark Workspace required.
          </p>
        </div>

        {/* Footer branding */}
        <div className="flex items-center gap-3 opacity-20 group">
          <div className="h-px w-12 bg-border transition-all duration-500 group-hover:w-16 group-hover:bg-primary/50" />
          <Sparkles size={12} className="text-primary transition-all duration-500 group-hover:scale-125" />
          <div className="h-px w-12 bg-border transition-all duration-500 group-hover:w-16 group-hover:bg-primary/50" />
        </div>
      </div>
    </div>
  )
}

function Loader2({ size, className }: { size?: number; className?: string }) {
  return (
    <div 
      style={{ width: size, height: size }} 
      className={cn("border-2 border-current/30 border-t-current rounded-full", className)} 
    />
  )
}
