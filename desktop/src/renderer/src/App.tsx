import { AuthProvider, useAuth } from './context/AuthContext'
import { ChatProvider } from './context/ChatContext'
import { WorkspaceProvider, useWorkspace } from './context/WorkspaceContext'
import { LoginScreen } from './components/LoginScreen'
import { Sidebar } from './components/Sidebar'
import { Header } from './components/Header'
import { ChatLayout } from './components/ChatLayout'
import { WorkspaceGate } from './components/WorkspaceGate'
import { WorkspaceStudio } from './components/WorkspaceStudio'
import { ProfileLayout } from './components/profile/ProfileLayout'
import { ScheduleWorkView } from './components/ScheduleWorkView'
import { logFrontendDebug, logFrontendError } from './lib/frontend-debug-log'

import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'

type RendererErrorBoundaryState = {
  error: Error | null
}

class RendererErrorBoundary extends Component<{ children: ReactNode }, RendererErrorBoundaryState> {
  state: RendererErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RendererErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    logFrontendError('react.error_boundary', error, {
      componentStack: errorInfo.componentStack,
    })
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full items-center justify-center bg-[hsl(0_0%_4%)] px-6">
          <div className="w-full max-w-3xl rounded-2xl border border-[hsl(0_52%_28%)] bg-[hsl(0_38%_12%)] p-6 text-[hsl(0_0%_92%)] shadow-2xl">
            <h1 className="text-lg font-semibold text-[hsl(0_85%_78%)]">Frontend exception</h1>
            <p className="mt-2 text-sm text-[hsl(0_0%_82%)]">
              The renderer crashed while rendering this screen. The exact error was captured in the frontend debug log and browser console.
            </p>
            <div className="mt-4 rounded-xl border border-[hsl(0_40%_22%)] bg-[hsl(0_30%_10%)] p-4 font-mono text-xs text-[hsl(0_0%_88%)]">
              {this.state.error.message || 'Unknown renderer error'}
            </div>
            <p className="mt-4 text-xs text-[hsl(0_0%_68%)]">
              Check DevTools console or localStorage key <code>cursorr_frontend_debug_log</code>, then reload the desktop app after the underlying issue is fixed.
            </p>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

function AppShell(): JSX.Element {
  const { session, loading } = useAuth()
  const { hasWorkspace } = useWorkspace()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [editorOpen, setEditorOpen] = useState(false)
  const [currentView, setCurrentView] = useState<'chat' | 'schedule' | 'settings'>('chat')

  useEffect(() => {
    logFrontendDebug('app.shell.ready', {
      hasSession: Boolean(session),
      hasWorkspace,
    })

    const handleError = (event: ErrorEvent) => {
      logFrontendError('window.error', event.error ?? event.message, {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      })
    }

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      logFrontendError('window.unhandled_rejection', event.reason)
    }

    window.addEventListener('error', handleError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)
    return () => {
      window.removeEventListener('error', handleError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    }
  }, [hasWorkspace, session])

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
      <div className="flex h-full overflow-hidden bg-transparent">
        <Sidebar 
          isOpen={sidebarOpen} 
          onToggle={() => setSidebarOpen(false)} 
          currentView={currentView}
          onChatClick={() => setCurrentView('chat')}
          onScheduleClick={() => setCurrentView('schedule')}
          onSettingsClick={() => setCurrentView(prev => prev === 'settings' ? 'chat' : 'settings')}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Header
            sidebarOpen={sidebarOpen}
            toggleSidebar={() => setSidebarOpen(true)}
            editorOpen={editorOpen}
            toggleEditor={() => setEditorOpen((prev) => !prev)}
          />
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              {currentView === 'settings' ? (
                <ProfileLayout onClose={() => setCurrentView('chat')} />
              ) : currentView === 'schedule' ? (
                <ScheduleWorkView />
              ) : (
                <ChatLayout />
              )}
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
        <RendererErrorBoundary>
          <AppShell />
        </RendererErrorBoundary>
      </WorkspaceProvider>
    </AuthProvider>
  )
}
