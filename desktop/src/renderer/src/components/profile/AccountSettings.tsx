import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../context/AuthContext'
import { TokenUsageCard } from './TokenUsageCard'

export function AccountSettings(): JSX.Element {
  const { session, token, logout } = useAuth()
  
  // Parse session securely with fallbacks
  const userStr = localStorage.getItem('user_session')
  const userContext = userStr ? JSON.parse(userStr) : null
  
  const email = session?.email || userContext?.email || 'user@example.com'
  const name = session?.name || userContext?.name || email.split('@')[0]
  const username = name.toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(Math.random() * 1000)

  const [googleStatus, setGoogleStatus] = useState<{ configured: boolean; connected: boolean; email?: string; scopes?: string[] } | null>(null)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [googleConnecting, setGoogleConnecting] = useState(false)
  const [googleError, setGoogleError] = useState<string | null>(null)

  const loadGoogleStatus = useCallback(async () => {
    if (!token) return
    setGoogleLoading(true)
    setGoogleError(null)
    try {
      const res = await window.desktopAPI.auth.getGoogleStatus(token)
      if (res?.success && res.data) {
        setGoogleStatus(res.data as { configured: boolean; connected: boolean; email?: string; scopes?: string[] })
      } else {
        setGoogleStatus(null)
        setGoogleError('Unable to load Google connection status.')
      }
    } catch {
      setGoogleStatus(null)
      setGoogleError('Unable to load Google connection status.')
    } finally {
      setGoogleLoading(false)
    }
  }, [token])

  useEffect(() => {
    void loadGoogleStatus()
  }, [loadGoogleStatus])

  const handleGoogleConnect = useCallback(async () => {
    if (!token) return
    setGoogleConnecting(true)
    setGoogleError(null)
    try {
      await window.desktopAPI.auth.openGoogleConnect(token)
    } catch {
      setGoogleError('Could not start Google OAuth. Check server configuration.')
    } finally {
      setGoogleConnecting(false)
    }
  }, [token])

  const handleGoogleDisconnect = useCallback(async () => {
    if (!token) return
    setGoogleLoading(true)
    setGoogleError(null)
    try {
      await window.desktopAPI.auth.unlinkGoogle(token)
      await loadGoogleStatus()
    } catch {
      setGoogleError('Could not disconnect Google account.')
    } finally {
      setGoogleLoading(false)
    }
  }, [token, loadGoogleStatus])

  return (
    <div className="flex flex-col gap-10 text-[hsl(0,0%,85%)]">
      <div>
        <h2 className="text-[22px] font-semibold text-white mb-6">Account</h2>
        
        <div className="flex flex-col gap-0 border-t border-b border-[hsl(0,0%,15%)] divide-y divide-[hsl(0,0%,15%)]">
          {/* Avatar / Identity Row */}
          <div className="py-5 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-600 to-purple-600 flex items-center justify-center text-white font-bold text-lg">
                {name.charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="font-medium text-[14px] text-white">{name}</div>
                <div className="text-[12px] text-[hsl(0,0%,55%)]">v{username}</div>
              </div>
            </div>
            <button className="px-4 py-1.5 rounded-md border border-[hsl(0,0%,25%)] text-[13px] hover:bg-[hsl(0,0%,15%)] transition-colors">
              Change avatar
            </button>
          </div>

          {/* Full Name */}
          <div className="py-4 flex items-center justify-between">
            <div>
              <div className="font-medium text-[14px]">Full Name</div>
              <div className="text-[13px] text-[hsl(0,0%,55%)] mt-0.5">{name}</div>
            </div>
            <button className="px-4 py-1.5 rounded-md border border-[hsl(0,0%,25%)] text-[13px] hover:bg-[hsl(0,0%,15%)] transition-colors">
              Change full name
            </button>
          </div>

          {/* Username */}
          <div className="py-4 flex items-center justify-between">
            <div>
              <div className="font-medium text-[14px]">Username</div>
              <div className="text-[13px] text-[hsl(0,0%,55%)] mt-0.5">v{username}</div>
            </div>
            <button className="px-4 py-1.5 rounded-md border border-[hsl(0,0%,25%)] text-[13px] hover:bg-[hsl(0,0%,15%)] transition-colors">
              Change username
            </button>
          </div>

          {/* Email */}
          <div className="py-4 flex items-center justify-between">
            <div>
              <div className="font-medium text-[14px]">Email</div>
              <div className="text-[13px] text-[hsl(0,0%,55%)] mt-0.5">{email}</div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-[22px] font-semibold text-white mb-6">Google Workspace</h2>
        <div className="border border-[hsl(0,0%,15%)] rounded-xl bg-[hsl(0,0%,8%)] p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-[14px] text-white">Google Drive + Gmail</div>
              <div className="text-[13px] text-[hsl(0,0%,55%)] mt-1">
                Connect to enable Drive file access and Gmail send operations from the agent.
              </div>
            </div>
            <div className="text-[12px] px-2 py-1 rounded-full border border-[hsl(0,0%,25%)] text-[hsl(0,0%,65%)]">
              {googleStatus?.connected ? 'Connected' : googleStatus?.configured ? 'Not connected' : 'Not configured'}
            </div>
          </div>

          {googleStatus?.connected && (
            <div className="text-[12px] text-[hsl(0,0%,60%)]">
              Linked as {googleStatus.email ?? 'Google user'}
            </div>
          )}

          {googleError && <div className="text-[12px] text-red-400">{googleError}</div>}

          <div className="flex items-center gap-3">
            {!googleStatus?.connected && (
              <button
                onClick={() => void handleGoogleConnect()}
                disabled={!googleStatus?.configured || googleConnecting}
                className="px-4 py-2 rounded-md border border-[hsl(0,0%,25%)] text-[13px] hover:bg-[hsl(0,0%,15%)] transition-colors disabled:opacity-50"
              >
                {googleConnecting ? 'Opening browser…' : 'Connect Google'}
              </button>
            )}
            {googleStatus?.connected && (
              <button
                onClick={() => void handleGoogleDisconnect()}
                disabled={googleLoading}
                className="px-4 py-2 rounded-md border border-red-900/50 text-[13px] text-red-300 hover:bg-red-950/40 transition-colors disabled:opacity-50"
              >
                Disconnect
              </button>
            )}
            <button
              onClick={() => void loadGoogleStatus()}
              disabled={googleLoading}
              className="px-4 py-2 rounded-md border border-[hsl(0,0%,25%)] text-[13px] hover:bg-[hsl(0,0%,15%)] transition-colors disabled:opacity-50"
            >
              {googleLoading ? 'Refreshing…' : 'Refresh status'}
            </button>
          </div>

          <div className="text-[12px] text-[hsl(0,0%,55%)]">
            Scopes requested: Gmail send, Drive readonly, profile, email.
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-[22px] font-semibold text-white mb-6">Your Subscription & Usage</h2>
        <div className="border border-[hsl(0,0%,15%)] divide-y divide-[hsl(0,0%,15%)] rounded-xl overflow-hidden bg-[hsl(0,0%,8%)]">
          <div className="p-5 flex items-center justify-between">
            <div>
              <div className="font-medium text-[14px] flex items-center gap-2">
                Unlock the most powerful features <span className="text-[10px] bg-white text-black px-1.5 py-0.5 rounded font-bold">Pro</span>
              </div>
              <div className="text-[13px] text-[hsl(0,0%,55%)] mt-1">
                Get the most out of your workspace with Pro. <span className="text-[hsl(200,80%,60%)] hover:underline cursor-pointer">Learn more</span>
              </div>
            </div>
            <button className="px-4 py-2 rounded-lg bg-white text-black font-medium text-[13px] hover:bg-[hsl(0,0%,90%)] transition-colors">
              Upgrade plan
            </button>
          </div>
          <div className="p-5">
            <TokenUsageCard />
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-[22px] font-semibold text-white mb-6">System</h2>
        <div className="flex flex-col gap-0 border-t border-b border-[hsl(0,0%,15%)] divide-y divide-[hsl(0,0%,15%)]">
          <div className="py-4 flex items-center justify-between">
            <div className="text-[14px]">Support</div>
            <button className="px-4 py-1.5 rounded-md border border-[hsl(0,0%,25%)] text-[13px] hover:bg-[hsl(0,0%,15%)] transition-colors">
              Contact
            </button>
          </div>
          
          <div className="py-4 flex items-center justify-between">
            <div className="text-[14px] text-[hsl(0,0%,60%)]">You are signed in as v{username}</div>
            <button onClick={() => void logout()} className="px-4 py-1.5 rounded-md border border-[hsl(0,0%,25%)] text-[13px] hover:bg-[hsl(0,0%,15%)] transition-colors">
              Sign out
            </button>
          </div>

          <div className="py-4 flex items-center justify-between">
            <div>
              <div className="font-medium text-[14px]">Sign out of all sessions</div>
              <div className="text-[13px] text-[hsl(0,0%,55%)] mt-0.5">Devices or browsers where you are signed in</div>
            </div>
            <button className="px-4 py-1.5 rounded-md border border-[hsl(0,0%,25%)] text-[13px] hover:bg-[hsl(0,0%,15%)] transition-colors">
              Sign out of all sessions
            </button>
          </div>

          <div className="py-4 flex items-center justify-between">
            <div>
              <div className="font-medium text-[14px]">Delete account</div>
              <div className="text-[13px] text-[hsl(0,0%,55%)] mt-0.5">Permanently delete your account and data</div>
            </div>
            <button className="px-4 py-1.5 rounded-md border border-[hsl(0,0%,25%)] text-[13px] hover:bg-[hsl(0,0%,15%)] transition-colors">
              Learn more
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
