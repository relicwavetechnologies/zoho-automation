import { useState } from 'react'
import { cn } from '../../lib/utils'
import { Check, Command, Monitor, Moon, Sun } from 'lucide-react'

// --- Reusable Settings Components ---

function SettingSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="animate-in fade-in slide-in-from-bottom-2 duration-500">
      <h2 className="text-[24px] font-bold text-foreground/90 mb-6 tracking-tight">{title}</h2>
      <div className="flex flex-col gap-0 border-t border-b border-border/50 divide-y divide-border/50">
        {children}
      </div>
    </section>
  )
}

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="py-6 flex items-start justify-between gap-8">
      <div className="flex-1">
        <div className="text-[14px] font-bold text-foreground/90">{label}</div>
        {description && <p className="text-[13px] text-muted-foreground/60 mt-1 leading-relaxed max-w-md font-medium">{description}</p>}
      </div>
      <div className="shrink-0 pt-0.5">
        {children}
      </div>
    </div>
  )
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-secondary"
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-lg ring-0 transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5"
        )}
      />
    </button>
  )
}

// --- Specific Section Components ---

export function PreferencesSettings() {
  const [theme, setTheme] = useState('system')
  
  return (
    <SettingSection title="Preferences">
      <SettingRow label="Appearance" description="Choose how Divo looks on your screen. Dark mode is recommended for focus.">
        <div className="flex p-1 bg-black/20 rounded-xl border border-border/50 shadow-sm">
          {[
            { id: 'light', icon: <Sun size={14} />, label: 'Light' },
            { id: 'dark', icon: <Moon size={14} />, label: 'Dark' },
            { id: 'system', icon: <Monitor size={14} />, label: 'System' },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all",
                theme === t.id ? "bg-secondary text-foreground shadow-sm" : "text-muted-foreground/50 hover:text-muted-foreground"
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </SettingRow>
      <SettingRow label="Language" description="Interface language for menus and buttons.">
        <select className="bg-black/40 border border-border rounded-lg px-3 py-1.5 text-[13px] text-foreground/80 outline-none focus:border-primary/30 w-48 shadow-sm transition-colors">
          <option>English (US)</option>
          <option>English (UK)</option>
          <option>Hindi</option>
          <option>Chinese</option>
        </select>
      </SettingRow>
      <SettingRow label="Default Model" description="The default AI brain used for new conversations.">
        <select className="bg-black/40 border border-border rounded-lg px-3 py-1.5 text-[13px] text-foreground/80 outline-none focus:border-primary/30 w-48 shadow-sm transition-colors">
          <option>Divo High (O3)</option>
          <option>Divo Fast (Groq)</option>
          <option>Divo Xtreme (Gemini)</option>
        </select>
      </SettingRow>
    </SettingSection>
  )
}

export function PersonalizationSettings() {
  return (
    <SettingSection title="Personalization">
      <SettingRow label="Custom Instructions" description="What would you like Divo to know about you to provide better responses?">
        <textarea 
          placeholder="e.g. 'I am a software engineer working on React applications. Please be concise and focus on performance.'"
          className="w-full min-h-[140px] bg-black/40 border border-border rounded-xl px-4 py-3 text-[13px] text-foreground/80 outline-none focus:border-primary/30 resize-none mt-2 placeholder:text-muted-foreground/30 shadow-sm transition-colors"
        />
      </SettingRow>
      <SettingRow label="Professional Role" description="Your primary role helps Divo tailor its tone and technical depth.">
        <input 
          type="text" 
          placeholder="e.g. Lead Designer"
          className="w-full bg-black/40 border border-border rounded-lg px-4 py-2 text-[13px] text-foreground/80 outline-none focus:border-primary/30 mt-2 placeholder:text-muted-foreground/30 shadow-sm transition-colors"
        />
      </SettingRow>
    </SettingSection>
  )
}

export function AssistantSettings() {
  const [showReasoning, setShowReasoning] = useState(true)
  const [conciseResponses, setConciseResponses] = useState(false)

  return (
    <SettingSection title="Assistant">
      <SettingRow label="Show Reasoning" description="Display the agent's step-by-step thinking process during execution.">
        <Switch checked={showReasoning} onChange={setShowReasoning} />
      </SettingRow>
      <SettingRow label="Concise Mode" description="Prioritize shorter, higher-signal responses over detailed explanations.">
        <Switch checked={conciseResponses} onChange={setConciseResponses} />
      </SettingRow>
      <SettingRow label="Response Tone" description="Adjust how Divo communicates with you.">
        <div className="grid grid-cols-2 gap-2 mt-2">
          {['Professional', 'Casual', 'Technical', 'Friendly'].map((tone) => (
            <button key={tone} className="px-4 py-2.5 rounded-lg border border-border bg-secondary/20 text-[11px] font-bold uppercase tracking-widest text-muted-foreground hover:bg-secondary hover:text-foreground transition-all text-left shadow-sm">
              {tone}
            </button>
          ))}
        </div>
      </SettingRow>
    </SettingSection>
  )
}

export function ShortcutsSettings() {
  const shortcuts = [
    { label: 'New Chat', keys: ['Cmd', 'N'] },
    { label: 'Toggle Sidebar', keys: ['Cmd', '\\'] },
    { label: 'Search History', keys: ['Cmd', 'P'] },
    { label: 'Open Settings', keys: ['Cmd', ','] },
    { label: 'Switch Workspace', keys: ['Cmd', 'O'] },
  ]

  return (
    <SettingSection title="Shortcuts">
      <div className="py-2">
        <div className="grid gap-1">
          {shortcuts.map((s) => (
            <div key={s.label} className="py-4 flex items-center justify-between">
              <span className="text-[14px] font-medium text-foreground/80">{s.label}</span>
              <div className="flex gap-1.5">
                {s.keys.map((k) => (
                  <kbd key={k} className="min-w-[32px] h-7 flex items-center justify-center px-2 rounded-lg border border-border bg-secondary/40 text-[11px] font-black uppercase shadow-sm">
                    {k === 'Cmd' ? <Command size={12} /> : k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </SettingSection>
  )
}

export function NotificationsSettings() {
  const [desktopAlerts, setDesktopAlerts] = useState(true)
  const [soundEnabled, setSoundEnabled] = useState(false)

  return (
    <SettingSection title="Notifications">
      <SettingRow label="Desktop Alerts" description="Receive a notification when a long-running job completes.">
        <Switch checked={desktopAlerts} onChange={setDesktopAlerts} />
      </SettingRow>
      <SettingRow label="Notification Sound" description="Play a subtle chime when Divo needs your attention.">
        <Switch checked={soundEnabled} onChange={setSoundEnabled} />
      </SettingRow>
    </SettingSection>
  )
}
