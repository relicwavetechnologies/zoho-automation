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
      <div className="flex justify-between items-end mb-2">
        <div className="text-[14px] font-medium text-white">Monthly AI Token Usage</div>
        <div className="text-[13px]">
          <span className="text-white font-medium">{usage.used.toLocaleString()}</span>
          <span className="text-[hsl(0,0%,50%)]"> / {usage.limit.toLocaleString()}</span>
        </div>
      </div>
      
      <div className="h-2.5 w-full bg-[hsl(0,0%,20%)] rounded-full overflow-hidden mt-1">
        <div 
          className="h-full bg-gradient-to-r from-[hsl(200,80%,50%)] to-[hsl(260,80%,60%)] transition-all duration-1000 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      
      {percent > 90 && (
        <div className="text-[12px] text-orange-400 mt-2">
          You are nearing your monthly token limit.
        </div>
      )}
    </div>
  )
}
