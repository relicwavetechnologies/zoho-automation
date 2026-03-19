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
    <div className="flex-1 flex flex-col items-center justify-center p-6 h-full overflow-y-auto">
      <div className="w-full max-w-4xl flex flex-col items-center">
        <div className="mb-4 rounded-full border border-sky-300/12 bg-sky-400/8 px-4 py-1.5 text-[11px] uppercase tracking-[0.24em] text-sky-100/70">
          Desktop Command Center
        </div>
        <h1 className="text-[34px] font-serif text-[hsl(0,0%,94%)] mb-4 tracking-tight text-center">
          <span className="text-sky-100 drop-shadow-[0_0_10px_rgba(120,180,230,0.18)]">Divo</span> now feels native to the workflow studio.
        </h1>
        <p className="mb-8 max-w-2xl text-center text-sm leading-7 text-white/55">
          Start a thread, run workspace actions, or move into scheduled automation without leaving the same visual system.
          {currentWorkspace ? ` Active workspace: ${currentWorkspace.name}.` : ''}
        </p>
        
        <div className="glass-panel-strong w-full relative rounded-[28px] px-4 py-4 transition-all">
          <Composer isHome={true} />
        </div>

        {/* Gallery Section */}
        <div className="mt-8 w-full animate-in fade-in duration-700">
          {/* Tabs */}
          <div className="flex items-center gap-6 mb-4 text-[13px] text-[hsl(0,0%,50%)] font-medium">
            <button className="glass-button flex items-center gap-2 px-3 py-1.5 rounded-full text-[hsl(0,0%,92%)] transition-colors">
              <LayoutGrid size={15} />
              From the gallery
            </button>
            <button className="flex items-center gap-2 px-2 py-1.5 hover:text-[hsl(0,0%,80%)] transition-colors">
              <Briefcase size={15} />
              Build a business
            </button>
            <button className="flex items-center gap-2 px-2 py-1.5 hover:text-[hsl(0,0%,80%)] transition-colors">
              <Code size={15} />
              Create a prototype
            </button>
            <button className="flex items-center gap-2 px-2 py-1.5 hover:text-[hsl(0,0%,80%)] transition-colors">
              <ListTodo size={15} />
              Organize my...
            </button>
          </div>

          {/* Cards Grid */}
          <div className="grid grid-cols-4 gap-4">
            {/* Card 1 */}
            <div className="glass-panel group relative rounded-[24px] overflow-hidden hover:border-sky-300/12 transition-all cursor-pointer flex flex-col aspect-[4/3]">
              <div className="flex-1 relative overflow-hidden bg-[#0A0A0A]">
                <img src={analyticsImg} alt="S&P 500" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity duration-300 group-hover:scale-105" />
              </div>
              <div className="p-3 flex items-center gap-2 text-[13px] text-[hsl(0,0%,72%)] group-hover:text-[hsl(0,0%,94%)] bg-transparent">
                <LineChart size={15} />
                <span className="truncate">S&P 500 Bubble...</span>
              </div>
            </div>

            {/* Card 2 */}
            <div className="glass-panel group relative rounded-[24px] overflow-hidden hover:border-sky-300/12 transition-all cursor-pointer flex flex-col aspect-[4/3]">
              <div className="flex-1 relative overflow-hidden bg-[#0A0A0A]">
                <img src={dashboardImg} alt="ASCII Canvas" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity duration-300 group-hover:scale-105" />
              </div>
              <div className="p-3 flex items-center gap-2 text-[13px] text-[hsl(0,0%,72%)] group-hover:text-[hsl(0,0%,94%)] bg-transparent">
                <Terminal size={15} />
                <span className="truncate">ASCII Canvas</span>
              </div>
            </div>

            {/* Card 3 */}
            <div className="glass-panel group relative rounded-[24px] overflow-hidden hover:border-sky-300/12 transition-all cursor-pointer flex flex-col aspect-[4/3]">
              <div className="flex-1 relative overflow-hidden bg-[#0A0A0A]">
                <img src={creativeImg} alt="US Presidential" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity duration-300 group-hover:scale-105" />
              </div>
              <div className="p-3 flex items-center gap-2 text-[13px] text-[hsl(0,0%,72%)] group-hover:text-[hsl(0,0%,94%)] bg-transparent">
                <Map size={15} />
                <span className="truncate">US Presidential E...</span>
              </div>
            </div>

            {/* Card 4 */}
            <div className="glass-panel group relative rounded-[24px] overflow-hidden hover:border-sky-300/12 transition-all cursor-pointer flex flex-col aspect-[4/3]">
              <div className="flex-1 relative overflow-hidden bg-[#0A0A0A]">
                <img src={documentImg} alt="Document" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity duration-300 group-hover:scale-105" />
              </div>
              <div className="p-3 flex items-center gap-2 text-[13px] text-[hsl(0,0%,72%)] group-hover:text-[hsl(0,0%,94%)] bg-transparent">
                <FileText size={15} />
                <span className="truncate">Document</span>
              </div>
            </div>
          </div>

          {/* Footer Links */}
          <div className="flex items-center justify-between mt-5 px-1 text-[13px] text-[hsl(0,0%,50%)]">
            <button className="flex items-center gap-2 hover:text-[hsl(0,0%,80%)] transition-colors">
              <LayoutGrid size={15} />
              View all
            </button>
            <button className="flex items-center gap-2 hover:text-[hsl(0,0%,80%)] transition-colors">
              <Shuffle size={15} />
              Shuffle
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
