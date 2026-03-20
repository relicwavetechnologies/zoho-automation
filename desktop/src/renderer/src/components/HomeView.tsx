import { useWorkspace } from '../context/WorkspaceContext'
import { Composer } from './Composer'
import { LayoutGrid, Briefcase, Code, ListTodo, LineChart, Terminal, Map, FileText, Shuffle } from 'lucide-react'
import dashboardImg from '../assets/dashboard.png'
import analyticsImg from '../assets/analytics.png'
import creativeImg from '../assets/creative.png'
import documentImg from '../assets/document.png'
export function HomeView(): JSX.Element {
  const { currentWorkspace } = useWorkspace()

  return (
    <div className="flex-1 flex flex-col items-center justify-start py-20 px-6 h-full overflow-y-auto" style={{ background: 'hsl(var(--background))' }}>
      <div className="w-full max-w-[760px] flex flex-col items-center">
        <h1 className="text-[32px] font-bold text-foreground/90 mb-10 tracking-tight text-center">
          <span className="text-primary/80">Divo</span> works for you.
        </h1>

        <div className="w-full relative rounded-2xl transition-all">
          <Composer isHome={true} />
        </div>

        {/* Gallery Section */}
        <div className="mt-16 w-full animate-in fade-in duration-1000 slide-in-from-bottom-4">
          {/* Tabs */}
          <div className="flex items-center justify-center gap-8 mb-6 text-[12px] text-muted-foreground/60 font-bold uppercase tracking-widest">
            <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary text-foreground transition-all">
              <LayoutGrid size={14} />
              Gallery
            </button>
            <button className="flex items-center gap-2 hover:text-foreground transition-all">
              <Briefcase size={14} />
              Business
            </button>
            <button className="flex items-center gap-2 hover:text-foreground transition-all">
              <Code size={14} />
              Prototype
            </button>
            <button className="flex items-center gap-2 hover:text-foreground transition-all">
              <ListTodo size={14} />
              Organize
            </button>
          </div>

          {/* Cards Grid */}
          <div className="grid grid-cols-4 gap-4 w-full">
...
            {/* Card 1 */}
            <div className="group relative rounded-xl overflow-hidden bg-secondary/30 border border-border hover:border-primary/20 transition-all cursor-pointer flex flex-col aspect-[4/3]">
              <div className="flex-1 relative overflow-hidden bg-black/40">
                <img src={analyticsImg} alt="S&P 500" className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity duration-500 group-hover:scale-105" />
              </div>
              <div className="p-3 flex items-center gap-2 text-[12px] font-medium text-muted-foreground group-hover:text-foreground bg-secondary/20">
                <LineChart size={14} />
                <span className="truncate">S&P 500 Analytics</span>
              </div>
            </div>

            {/* Card 2 */}
            <div className="group relative rounded-xl overflow-hidden bg-secondary/30 border border-border hover:border-primary/20 transition-all cursor-pointer flex flex-col aspect-[4/3]">
              <div className="flex-1 relative overflow-hidden bg-black/40">
                <img src={dashboardImg} alt="ASCII Canvas" className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity duration-500 group-hover:scale-105" />
              </div>
              <div className="p-3 flex items-center gap-2 text-[12px] font-medium text-muted-foreground group-hover:text-foreground bg-secondary/20">
                <Terminal size={14} />
                <span className="truncate">ASCII Canvas</span>
              </div>
            </div>

            {/* Card 3 */}
            <div className="group relative rounded-xl overflow-hidden bg-secondary/30 border border-border hover:border-primary/20 transition-all cursor-pointer flex flex-col aspect-[4/3]">
              <div className="flex-1 relative overflow-hidden bg-black/40">
                <img src={creativeImg} alt="US Presidential" className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity duration-500 group-hover:scale-105" />
              </div>
              <div className="p-3 flex items-center gap-2 text-[12px] font-medium text-muted-foreground group-hover:text-foreground bg-secondary/20">
                <Map size={14} />
                <span className="truncate">Global Map View</span>
              </div>
            </div>

            {/* Card 4 */}
            <div className="group relative rounded-xl overflow-hidden bg-secondary/30 border border-border hover:border-primary/20 transition-all cursor-pointer flex flex-col aspect-[4/3]">
              <div className="flex-1 relative overflow-hidden bg-black/40">
                <img src={documentImg} alt="Document" className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity duration-500 group-hover:scale-105" />
              </div>
              <div className="p-3 flex items-center gap-2 text-[12px] font-medium text-muted-foreground group-hover:text-foreground bg-secondary/20">
                <FileText size={14} />
                <span className="truncate">Document Builder</span>
              </div>
            </div>
          </div>

          {/* Footer Links */}
          <div className="flex items-center justify-between mt-6 px-1 text-[12px] text-muted-foreground/50 font-medium">
            <button className="flex items-center gap-2 hover:text-foreground transition-colors">
              <LayoutGrid size={14} />
              View all
            </button>
            <button className="flex items-center gap-2 hover:text-foreground transition-colors">
              <Shuffle size={14} />
              Shuffle
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
