import { AuthProvider, useAuth } from './context/AuthContext'
import { ChatProvider } from './context/ChatContext'
import { WorkspaceProvider, useWorkspace } from './context/WorkspaceContext'
import { LoginScreen } from './components/LoginScreen'
import { Sidebar } from './components/Sidebar'
import { Header } from './components/Header'
import { ChatPane } from './components/ChatPane'
import { Composer } from './components/Composer'
import { WorkspaceGate } from './components/WorkspaceGate'
import { WorkspaceStudio } from './components/WorkspaceStudio'

import { useState } from 'react'

function AppShell(): JSX.Element {
  const { session, loading } = useAuth()
  const { hasWorkspace } = useWorkspace()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [editorOpen, setEditorOpen] = useState(false)

  if (loading) {
    return (
      <div
        className="flex h-full items-center justify-center"
        style={{ background: 'hsl(0 0% 4%)' }}
      >
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-[hsl(0,0%,12%)] animate-pulse" />
          <p className="text-xs text-[hsl(0,0%,35%)]">Loading...</p>
        </div>
      </div>
    )
  }

  if (!session) {
    return <LoginScreen />
  }

  if (!hasWorkspace) {
    return <WorkspaceGate />
  }

  return (
    <ChatProvider>
      <div className="flex h-full overflow-hidden" style={{ background: 'hsl(var(--background))' }}>
        <Sidebar isOpen={sidebarOpen} onToggle={() => setSidebarOpen(false)} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Header
            sidebarOpen={sidebarOpen}
            toggleSidebar={() => setSidebarOpen(true)}
            editorOpen={editorOpen}
            toggleEditor={() => setEditorOpen((prev) => !prev)}
          />
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <ChatPane />
              <Composer />
            </div>
            <WorkspaceStudio isOpen={editorOpen} onClose={() => setEditorOpen(false)} />
          </div>
        </div>
      </div>
    </ChatProvider>
  )
}

export function App(): JSX.Element {

  return (
    <AuthProvider>
      <WorkspaceProvider>
        <AppShell />
      </WorkspaceProvider>
    </AuthProvider>
  )
}
