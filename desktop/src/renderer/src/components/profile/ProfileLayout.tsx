import { useState } from 'react'
import { PanelLeftClose, Settings, User, Bell, Key, Zap, Building2, TerminalSquare } from 'lucide-react'
import { AccountSettings } from './AccountSettings'
import { 
  PreferencesSettings, 
  PersonalizationSettings, 
  AssistantSettings, 
  ShortcutsSettings, 
  NotificationsSettings 
} from './UnifiedSettings'
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
    <div className="flex h-full w-full bg-background text-foreground">
      {/* Settings Sidebar */}
      <aside 
        className="w-[260px] shrink-0 border-r border-border bg-background/50 backdrop-blur-md flex flex-col py-5 px-4"
      >
        <div className="mb-8 flex items-center gap-3">
          <button 
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground transition-all shadow-sm"
            title="Back to home"
          >
            <PanelLeftClose size={16} />
          </button>
          <span className="text-[10px] font-black uppercase tracking-[0.25em] text-primary/80">Divo</span>
        </div>

        <div className="flex-1 overflow-y-auto space-y-6">
          {navGroups.map((group, i) => (
            <div key={group.label} className="flex flex-col gap-1">
              <div className="px-3 mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/30">
                {group.label}
              </div>
              <div className="flex flex-col gap-1">
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setActiveTab(item.id)}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-xl text-[13px] font-medium transition-all",
                      activeTab === item.id 
                        ? "bg-secondary text-foreground border border-border shadow-sm" 
                        : "text-muted-foreground/70 hover:bg-secondary/30 hover:text-foreground border border-transparent"
                    )}
                  >
                    <span className={cn("shrink-0 opacity-70", activeTab === item.id && "text-primary opacity-100")}>{item.icon}</span>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto bg-secondary/5">
        <div className="mx-auto w-full max-w-[800px] px-12 py-16">
          {activeTab === 'account' && <AccountSettings />}
          {activeTab === 'preferences' && <PreferencesSettings />}
          {activeTab === 'personalization' && <PersonalizationSettings />}
          {activeTab === 'assistant' && <AssistantSettings />}
          {activeTab === 'shortcuts' && <ShortcutsSettings />}
          {activeTab === 'notifications' && <NotificationsSettings />}
          
          {activeTab === 'enterprise' && (
            <div className="flex flex-col items-center justify-center mt-20 text-center">
              <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary mb-4 border border-primary/20 shadow-sm">
                <Building2 size={24} />
              </div>
              <h3 className="text-xl font-bold text-foreground/90 tracking-tight">Enterprise Controls</h3>
              <p className="text-sm text-muted-foreground/60 mt-2 max-w-[320px] leading-relaxed">
                Scale Divo across your entire organization with SSO, advanced security policies, and team-wide usage analytics.
              </p>
              <button className="mt-8 px-6 py-2.5 rounded-lg bg-primary text-primary-foreground font-bold text-[12px] uppercase tracking-wider hover:opacity-90 transition-all shadow-sm">
                Contact Sales
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
