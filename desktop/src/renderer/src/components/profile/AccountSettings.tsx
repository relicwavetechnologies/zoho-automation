import { useState, useEffect } from 'react'
import { useAuth } from '../../context/AuthContext'
import { TokenUsageCard } from './TokenUsageCard'

export function AccountSettings(): JSX.Element {
  const { session, logout } = useAuth()
  
  // Parse session securely with fallbacks
  const userStr = localStorage.getItem('user_session')
  const userContext = userStr ? JSON.parse(userStr) : null
  
  const email = session?.email || userContext?.email || 'user@example.com'
  const name = session?.name || userContext?.name || email.split('@')[0]
  const username = name.toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(Math.random() * 1000)

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
