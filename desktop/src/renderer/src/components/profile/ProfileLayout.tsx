import { useState } from 'react'
import { PanelLeftClose, Settings, User, Bell, Key, Zap, Building2, TerminalSquare } from 'lucide-react'
import { AccountSettings } from './AccountSettings'
import { cn } from '../../lib/utils'

export function ProfileLayout({ onClose }: { onClose: () => void }): JSX.Element {
  const [activeTab, setActiveTab] = useState('account')

  const navGroups = [
    {
      label: 'Account',
      items: [
        { id: 'account', icon: <Settings size={16} />, label: 'Account' },
        { id: 'preferences', icon: <Zap size={16} />, label: 'Preferences' },
        { id: 'personalization', icon: <User size={16} />, label: 'Personalization' },
        { id: 'assistant', icon: <TerminalSquare size={16} />, label: 'Assistant' },
        { id: 'shortcuts', icon: <Key size={16} />, label: 'Shortcuts' },
        { id: 'notifications', icon: <Bell size={16} />, label: 'Notifications' },
      ],
    },
    {
      label: 'Enterprise',
      items: [
        { id: 'enterprise', icon: <Building2 size={16} />, label: 'Upgrade to Enterprise' },
      ],
    },
  ]

  return (
    <div className="flex h-full w-full bg-[hsl(var(--background))]">
      {/* Settings Sidebar */}
      <div 
        className="w-[260px] shrink-0 border-r border-[hsl(0,0%,12%)] bg-[hsl(var(--sidebar-bg))] flex flex-col pt-3"
      >
        <div className="px-4 pb-4 flex items-center gap-3 text-[hsl(0,0%,60%)]">
          <button 
            onClick={onClose}
            className="p-1.5 -ml-1.5 hover:bg-[hsl(0,0%,15%)] hover:text-white rounded-md transition-colors"
          >
            <PanelLeftClose size={16} />
          </button>
          <span className="font-medium text-[13px]">Home</span>
        </div>

        <div className="flex-1 overflow-y-auto px-2">
          {navGroups.map((group, i) => (
            <div key={group.label} className={cn("mb-6", i > 0 && "mt-4")}>
              <div className="px-3 mb-2 text-[11px] font-medium text-[hsl(0,0%,45%)] tracking-wider">
                {group.label}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setActiveTab(item.id)}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] transition-colors",
                      activeTab === item.id 
                        ? "bg-[hsl(0,0%,20%)] text-white font-medium" 
                        : "text-[hsl(0,0%,70%)] hover:bg-[hsl(0,0%,12%)] hover:text-[hsl(0,0%,90%)]"
                    )}
                  >
                    <span className="shrink-0">{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[800px] px-8 py-12">
          {activeTab === 'account' && <AccountSettings />}
          {activeTab !== 'account' && (
            <div className="text-center text-[hsl(0,0%,50%)] mt-20">
              <p>This section is under construction.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
