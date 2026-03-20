import { useMemo } from 'react'
import { useWorkspace } from '../context/WorkspaceContext'
import { Composer } from './Composer'
import { Plus, Sparkles, Terminal } from 'lucide-react'

const GREETINGS = [
  "How can I help you work today?",
  "Ready to automate the boring stuff?",
  "What's the plan, boss?",
  "Let's build something impressive.",
  "At your service. What's on your mind?",
  "Ready for some high-signal output?",
  "Shall we streamline your workflow?",
  "Your AI coworker is online. What's next?",
  "Let's make some magic happen.",
  "System ready. Awaiting your instructions.",
  "How about we crush some tasks today?",
  "Ready to coordinate. What's the mission?"
]

export function HomeView(): JSX.Element {
  const { currentWorkspace } = useWorkspace()
  
  // Select a random greeting on mount
  const greeting = useMemo(() => {
    return GREETINGS[Math.floor(Math.random() * GREETINGS.length)]
  }, [])

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 h-full bg-background selection:bg-primary/30">
      <div className="w-full max-w-[760px] flex flex-col items-center -mt-20">
        
        {/* Stylish Minimal Branding */}
        <div className="flex flex-col items-center gap-4 mb-12">
          <div className="relative group">
            <div className="absolute -inset-4 bg-primary/10 rounded-full blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
            <div className="relative text-[11px] font-black uppercase tracking-[0.5em] text-primary/80 border border-primary/20 bg-primary/5 px-4 py-1.5 rounded-lg shadow-sm">
              Divo
            </div>
          </div>
          <h1 className="mt-3 text-[32px] sm:text-[42px] font-medium tracking-[-0.02em] text-foreground/80 text-center animate-in fade-in duration-1000 slide-in-from-bottom-1 max-w-[640px] leading-[1.15]">
            {greeting}
          </h1>
        </div>
        
        {/* Main Action */}
        <div className="w-full relative animate-in fade-in duration-1000 zoom-in-[0.98]">
          <Composer isHome={true} />
        </div>

        {/* Minimal Suggested Starts */}
        <div className="mt-14 flex flex-wrap justify-center gap-3 animate-in fade-in duration-1000 slide-in-from-bottom-2">
          <button className="group flex items-center gap-2.5 px-4 py-2 rounded-xl bg-secondary/10 border border-border/30 hover:border-primary/30 hover:bg-secondary/20 transition-all shadow-sm">
            <Plus size={14} className="text-muted-foreground/40 group-hover:text-primary/60" />
            <span className="text-[12px] font-bold text-muted-foreground/60 group-hover:text-foreground/80 tracking-tight">New Workflow</span>
          </button>
          
          <button className="group flex items-center gap-2.5 px-4 py-2 rounded-xl bg-secondary/10 border border-border/30 hover:border-primary/30 hover:bg-secondary/20 transition-all shadow-sm">
            <Sparkles size={14} className="text-muted-foreground/40 group-hover:text-primary/60" />
            <span className="text-[12px] font-bold text-muted-foreground/60 group-hover:text-foreground/80 tracking-tight">Search Assets</span>
          </button>

          <button className="group flex items-center gap-2.5 px-4 py-2 rounded-xl bg-secondary/10 border border-border/30 hover:border-primary/30 hover:bg-secondary/20 transition-all shadow-sm">
            <Terminal size={14} className="text-muted-foreground/40 group-hover:text-primary/60" />
            <span className="text-[12px] font-bold text-muted-foreground/60 group-hover:text-foreground/80 tracking-tight">Run Command</span>
          </button>
        </div>

        {/* Subtle Branding Footer */}
        <div className="mt-24 flex items-center gap-3 opacity-10 grayscale hover:opacity-20 transition-opacity duration-500 cursor-default select-none">
          <div className="h-px w-8 bg-current" />
          <div className="text-[9px] font-black uppercase tracking-[0.4em] text-muted-foreground">
            Professional Intelligence
          </div>
          <div className="h-px w-8 bg-current" />
        </div>
      </div>
    </div>
  )
}
