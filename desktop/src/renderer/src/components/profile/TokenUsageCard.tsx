import { useState, useEffect } from 'react'

export function TokenUsageCard(): JSX.Element {
  const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadUsage() {
      try {
        const token = localStorage.getItem('auth_token')
        if (token && window.desktopAPI?.auth?.getUsage) {
          const res = await window.desktopAPI.auth.getUsage(token)
          if (res.success && res.data) {
            setUsage(res.data as any)
          }
        }
      } catch (err) {
        console.error('Failed to load token usage', err)
      } finally {
        setLoading(false)
      }
    }
    void loadUsage()
  }, [])

  if (loading) {
    return <div className="text-[13px] text-[hsl(0,0%,50%)] animate-pulse">Loading usage data...</div>
  }

  if (!usage) {
    return <div className="text-[13px] text-red-400">Unable to load token usage statstics.</div>
  }

  const percent = Math.min(100, Math.max(0, (usage.used / usage.limit) * 100))

  return (
    <div className="flex flex-col w-full">
      <div className="flex justify-between items-end mb-3">
        <div className="text-[13px] font-bold uppercase tracking-widest text-muted-foreground/50">Usage</div>
        <div className="text-[13px]">
          <span className="text-foreground/90 font-bold">{usage.used.toLocaleString()}</span>
          <span className="text-muted-foreground/40 font-medium"> / {usage.limit.toLocaleString()} tokens</span>
        </div>
      </div>
      
      <div className="h-2 w-full bg-secondary rounded-full overflow-hidden border border-border/30">
        <div 
          className="h-full bg-primary transition-all duration-1000 ease-out shadow-[0_0_12px_rgba(var(--primary),0.3)]"
          style={{ width: `${percent}%` }}
        />
      </div>
      
      {percent > 90 && (
        <div className="text-[11px] font-bold uppercase tracking-wider text-amber-500/80 mt-3 flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
          Nearing monthly limit
        </div>
      )}
    </div>
  )
}
