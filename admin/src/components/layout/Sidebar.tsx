import { NavLink } from 'react-router-dom';
import { Settings2, Users, LayoutDashboard, Shield, ChevronRight, Plug, KeyRound } from 'lucide-react';
import type { AdminNavItem } from '../../auth/types';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/utils';

const iconMap: Record<string, React.ReactNode> = {
  Overview: <LayoutDashboard strokeWidth={1.5} className="h-4 w-4 shrink-0" />,
  Members: <Users strokeWidth={1.5} className="h-4 w-4 shrink-0" />,
  Controls: <Settings2 strokeWidth={1.5} className="h-4 w-4 shrink-0" />,
  RBAC: <Shield strokeWidth={1.5} className="h-4 w-4 shrink-0" />,
  Integrations: <Plug strokeWidth={1.5} className="h-4 w-4 shrink-0" />,
  'Tool Access': <KeyRound strokeWidth={1.5} className="h-4 w-4 shrink-0" />,
};

interface SidebarProps {
  navItems: AdminNavItem[];
  isCollapsed?: boolean;
}

export const Sidebar = ({ navItems, isCollapsed = false }: SidebarProps) => {
  return (
    <aside className={cn(
      "flex flex-col h-full bg-[#0c0c0c] border-r border-[#1a1a1a] text-zinc-400 transition-all duration-300 ease-in-out shrink-0",
      isCollapsed ? "w-[68px]" : "w-[240px]"
    )}>
      <div className={cn("py-5 flex flex-col justify-center min-h-[64px]", isCollapsed ? "px-0 items-center" : "px-4")}>
        <div className={cn("flex items-center gap-3", isCollapsed ? "justify-center" : "mb-1")}>
          <div className="h-6 w-6 rounded bg-[#222] border border-[#333] flex items-center justify-center shrink-0">
            <span className="text-zinc-300 font-medium text-[10px]">C</span>
          </div>
          {!isCollapsed && (
            <div className="flex flex-col">
              <h1 className="text-sm font-medium text-zinc-200 uppercase tracking-widest">Control Hub</h1>
              <p className="text-[10px] text-zinc-600 leading-tight">Role-scoped operations</p>
            </div>
          )}
        </div>
      </div>

      <ScrollArea className="flex-1 px-3 py-2">
        <nav className="flex flex-col gap-1">
          {navItems.map((item) => (
            <NavLink
              key={item.id}
              to={item.path}
              title={isCollapsed ? item.label : undefined}
              className={({ isActive }) =>
                cn(
                  "flex items-center rounded-sm text-[13px] transition-colors group relative",
                  isCollapsed ? "justify-center px-0 py-2.5" : "gap-3 px-3 py-2",
                  isActive
                    ? 'bg-[#1a1a1a] text-zinc-100 font-medium'
                    : 'text-zinc-500 hover:text-zinc-300'
                )
              }
            >
              {iconMap[item.label] || <ChevronRight strokeWidth={1.5} className="h-4 w-4 shrink-0" />}

              {!isCollapsed && <span>{item.label}</span>}

              {/* Optional: Add custom pure CSS tooltip for collapsed state if desired, but native title above usually suffices */}
            </NavLink>
          ))}
        </nav>
      </ScrollArea>

      <div className={cn("mt-auto pb-4", isCollapsed ? "px-2" : "px-4")}>
        {!isCollapsed ? (
          <div className="rounded-md bg-[#111] p-3 flex flex-col gap-1">
            <span className="text-xs text-zinc-500">Version</span>
            <Badge variant="secondary" className="bg-[#1a1a1a] text-zinc-400 font-mono text-[10px] w-fit hover:bg-[#1a1a1a]">
              v0.1.0-beta
            </Badge>
          </div>
        ) : (
          <div className="flex justify-center w-full">
            <div title="v0.1.0-beta" className="h-[2px] w-4 bg-[#333] rounded-full mx-auto" />
          </div>
        )}
      </div>
    </aside>
  );
};
