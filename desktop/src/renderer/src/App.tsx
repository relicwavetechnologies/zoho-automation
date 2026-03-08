import { AuthProvider, useAuth } from './context/AuthContext'
import { ChatProvider } from './context/ChatContext'
import { LoginScreen } from './components/LoginScreen'
import { Sidebar } from './components/Sidebar'
import { Header } from './components/Header'
import { ChatPane } from './components/ChatPane'
import { Composer } from './components/Composer'

function AppShell(): JSX.Element {
  const { session, loading } = useAuth()

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

  return (
    <ChatProvider>
      <div className="flex h-full" style={{ background: 'hsl(var(--background))' }}>
        <Sidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <Header />
          <ChatPane />
          <Composer />
        </div>
      </div>
    </ChatProvider>
  )
}

export function App(): JSX.Element {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  )
}
