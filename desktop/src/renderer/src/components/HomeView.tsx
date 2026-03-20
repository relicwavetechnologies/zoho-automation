import { useMemo } from 'react'
import { useWorkspace } from '../context/WorkspaceContext'
import { Composer } from './Composer'
import { Plus, Sparkles, Terminal } from 'lucide-react'
import { Logo } from './Logo'

const GREETINGS = [
  "How can I help?",
  "What's the plan, boss?",
  "Let's build something impressive.",
  "Ready for your instructions.",
  "Shall we automate today?",
  "What's the mission today?",
  "Let's crush some tasks.",
  "Awaiting your next move.",
  "Ready to coordinate everything.",
  "System online. What's next?",
  "Let's make progress happen.",
  "Your AI coworker's ready.",
  "Tell me your goal.",
  "Ready to streamline work.",
  "Let's build the future.",
  "What should we solve?",
  "Ready to assist you.",
  "Let's get to work.",
  "How can I assist?"
]

export function HomeView(): JSX.Element {
  const { currentWorkspace } = useWorkspace()
  
  // Select a random greeting on mount
  const greeting = useMemo(() => {
    return GREETINGS[Math.floor(Math.random() * GREETINGS.length)]
  }, [])

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 h-full bg-background selection:bg-primary/30">
      <div className="w-full max-w-[760px] flex flex-col items-center -mt-24">
        
        {/* Stylish Side-by-Side Branding */}
        <div className="flex items-center gap-5 mb-14 animate-in fade-in duration-1000 slide-in-from-bottom-2">
          <div className="relative group">
            <div className="absolute -inset-3 bg-primary/10 rounded-full blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-700" />
            <Logo size={48} className="relative transition-transform duration-500 group-hover:scale-105" />
          </div>
          <h1 className="text-[32px] sm:text-[40px] font-medium tracking-[-0.03em] text-foreground/85 leading-none">
            {greeting}
          </h1>
        </div>
        
        {/* Main Action */}
        <div className="w-full relative animate-in fade-in duration-1000 zoom-in-[0.99] delay-100">
          <Composer isHome={true} />
        </div>

        {/* Minimal Suggested Starts */}
        <div className="mt-16 flex flex-wrap justify-center gap-3 animate-in fade-in duration-1000 slide-in-from-bottom-2 delay-300">
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
        <div className="mt-28 flex items-center gap-3 opacity-10 grayscale hover:opacity-20 transition-opacity duration-700 cursor-default select-none delay-500">
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
