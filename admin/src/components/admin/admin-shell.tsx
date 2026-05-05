import { Outlet } from "react-router-dom"
import { AdminSidebar } from "@/components/admin/admin-sidebar"
import { TopBar } from "@/components/admin/top-bar"

export function AdminShell() {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <aside className="hidden shrink-0 lg:block">
        <AdminSidebar />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <div className="min-h-0 flex-1 overflow-hidden bg-mat lg:rounded-tl-2xl">
          <div className="h-full overflow-y-auto">
            <main className="space-y-5 p-4 md:p-6">
              <Outlet />
            </main>
          </div>
        </div>
      </div>
    </div>
  )
}
