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
    <div className="flex-1 flex flex-col items-center justify-center p-6 h-full overflow-y-auto" style={{ background: 'hsl(var(--background))' }}>
      <div className="w-full max-w-3xl flex flex-col items-center">
        <h1 className="text-[32px] font-serif text-[hsl(0,0%,90%)] mb-8 tracking-tight text-center">
          <span className="text-[#00ffff] drop-shadow-[0_0_8px_rgba(0,255,255,0.4)]">Odin</span> works for you.
        </h1>
        
        <div className="w-full relative shadow-2xl rounded-2xl transition-all">
          <Composer isHome={true} />
        </div>

        {/* Gallery Section */}
        <div className="mt-8 w-full animate-in fade-in duration-700">
          {/* Tabs */}
          <div className="flex items-center gap-6 mb-4 text-[13px] text-[hsl(0,0%,50%)] font-medium">
            <button className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[hsl(0,0%,15%)] text-[hsl(0,0%,90%)] transition-colors">
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
            <div className="group relative rounded-xl overflow-hidden bg-[hsl(0,0%,10%)] border border-[hsl(0,0%,18%)] hover:border-[hsl(0,0%,25%)] transition-all cursor-pointer flex flex-col aspect-[4/3]">
              <div className="flex-1 relative overflow-hidden bg-[#0A0A0A]">
                <img src={analyticsImg} alt="S&P 500" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity duration-300 group-hover:scale-105" />
              </div>
              <div className="p-3 flex items-center gap-2 text-[13px] text-[hsl(0,0%,70%)] group-hover:text-[hsl(0,0%,90%)] bg-[hsl(0,0%,10%)]">
                <LineChart size={15} />
                <span className="truncate">S&P 500 Bubble...</span>
              </div>
            </div>

            {/* Card 2 */}
            <div className="group relative rounded-xl overflow-hidden bg-[hsl(0,0%,10%)] border border-[hsl(0,0%,18%)] hover:border-[hsl(0,0%,25%)] transition-all cursor-pointer flex flex-col aspect-[4/3]">
              <div className="flex-1 relative overflow-hidden bg-[#0A0A0A]">
                <img src={dashboardImg} alt="ASCII Canvas" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity duration-300 group-hover:scale-105" />
              </div>
              <div className="p-3 flex items-center gap-2 text-[13px] text-[hsl(0,0%,70%)] group-hover:text-[hsl(0,0%,90%)] bg-[hsl(0,0%,10%)]">
                <Terminal size={15} />
                <span className="truncate">ASCII Canvas</span>
              </div>
            </div>

            {/* Card 3 */}
            <div className="group relative rounded-xl overflow-hidden bg-[hsl(0,0%,10%)] border border-[hsl(0,0%,18%)] hover:border-[hsl(0,0%,25%)] transition-all cursor-pointer flex flex-col aspect-[4/3]">
              <div className="flex-1 relative overflow-hidden bg-[#0A0A0A]">
                <img src={creativeImg} alt="US Presidential" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity duration-300 group-hover:scale-105" />
              </div>
              <div className="p-3 flex items-center gap-2 text-[13px] text-[hsl(0,0%,70%)] group-hover:text-[hsl(0,0%,90%)] bg-[hsl(0,0%,10%)]">
                <Map size={15} />
                <span className="truncate">US Presidential E...</span>
              </div>
            </div>

            {/* Card 4 */}
            <div className="group relative rounded-xl overflow-hidden bg-[hsl(0,0%,10%)] border border-[hsl(0,0%,18%)] hover:border-[hsl(0,0%,25%)] transition-all cursor-pointer flex flex-col aspect-[4/3]">
              <div className="flex-1 relative overflow-hidden bg-[#0A0A0A]">
                <img src={documentImg} alt="Document" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity duration-300 group-hover:scale-105" />
              </div>
              <div className="p-3 flex items-center gap-2 text-[13px] text-[hsl(0,0%,70%)] group-hover:text-[hsl(0,0%,90%)] bg-[hsl(0,0%,10%)]">
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

