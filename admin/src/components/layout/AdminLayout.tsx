import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { LogOut, User, Menu } from 'lucide-react';
import { useAdminAuth } from '../../auth/AdminAuthProvider';
import { Sidebar } from './Sidebar';
import { Button } from '../ui/button';
import { roleLabel } from '../../lib/labels';
import { Avatar, AvatarFallback } from '../ui/avatar';

export const AdminLayout = () => {
  const { session, navItems, logout } = useAdminAuth();
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <div className="flex h-screen w-full bg-[#0c0c0c] text-zinc-300 font-sans overflow-hidden antialiased selection:bg-zinc-800">
      <Sidebar navItems={navItems} isCollapsed={isCollapsed} />

      <main className="flex-1 flex flex-col min-w-0 bg-[#0c0c0c]">
        <header className="h-14 border-b border-[#1a1a1a] flex items-center justify-between px-6 shrink-0 bg-[#0c0c0c]/95 backdrop-blur supports-[backdrop-filter]:bg-[#0c0c0c]/60">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-zinc-400 hover:text-zinc-100 hover:bg-[#1a1a1a] -ml-2"
              onClick={() => setIsCollapsed(!isCollapsed)}
            >
              <Menu className="h-4 w-4" />
            </Button>
            <h2 className="text-sm font-medium text-zinc-100 flex items-center gap-2">
              <span className="text-zinc-500">Workspace</span> / Default
            </h2>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="flex flex-col items-end">
                <span className="text-xs font-medium text-zinc-200">Admin User</span>
                <span className="text-[10px] text-zinc-500">{roleLabel(session?.role)}</span>
              </div>
              <Avatar className="h-8 w-8 rounded-md border border-[#222]">
                <AvatarFallback className="bg-[#111] text-zinc-300 rounded-md">
                  <User className="h-4 w-4" />
                </AvatarFallback>
              </Avatar>
            </div>

            <div className="w-px h-4 bg-[#222] mx-1"></div>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-zinc-400 hover:text-zinc-100 hover:bg-[#1a1a1a]"
              onClick={() => void logout()}
            >
              <LogOut className="h-4 w-4 mr-2" />
              Sign out
            </Button>
          </div>
        </header>

        <div className="flex-1 overflow-auto bg-[#0a0a0a]">
          <div className="max-w-6xl mx-auto p-8 w-full">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
};
