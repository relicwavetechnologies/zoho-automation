import { createRootRoute, Outlet } from '@tanstack/react-router'
// import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

import { useEffect, useState, type ReactNode } from 'react'
import DialogAppUpdater from '@/containers/dialogs/AppUpdater'
import BackendUpdater from '@/containers/dialogs/BackendUpdater'
import { Fragment } from 'react/jsx-runtime'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { InterfaceProvider } from '@/providers/InterfaceProvider'
import { KeyboardShortcutsProvider } from '@/providers/KeyboardShortcuts'
import { DataProvider } from '@/providers/DataProvider'
import { route } from '@/constants/routes'
import { ExtensionProvider } from '@/providers/ExtensionProvider'
import { ToasterProvider } from '@/providers/ToasterProvider'
import { useAnalytic } from '@/hooks/useAnalytic'
import { PromptAnalytic } from '@/containers/analytics/PromptAnalytic'
import { useJanModelPrompt } from '@/hooks/useJanModelPrompt'
import { PromptJanModel } from '@/containers/PromptJanModel'
import { AnalyticProvider } from '@/providers/AnalyticProvider'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import ToolApproval from '@/containers/dialogs/ToolApproval'
import { TranslationProvider } from '@/i18n/TranslationContext'
import OutOfContextPromiseModal from '@/containers/dialogs/OutOfContextDialog'
import AttachmentIngestionDialog from '@/containers/dialogs/AttachmentIngestionDialog'
import GlobalError from '@/containers/GlobalError'
import { GlobalEventHandler } from '@/providers/GlobalEventHandler'
import { ServiceHubProvider } from '@/providers/ServiceHubProvider'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { LeftSidebar } from '@/components/left-sidebar'
import { WindowControls } from '@/components/WindowControls'
import { WindowResizeGrips } from '@/components/WindowResizeGrips'
import ErrorDialog from '@/containers/dialogs/ErrorDialog'
import LlamacppBusyOnExitDialog from '@/containers/dialogs/LlamacppBusyOnExitDialog'
import LlamacppOomListener from '@/containers/dialogs/LlamacppOomListener'
import MissingDependenciesDialog from '@/containers/dialogs/MissingDependenciesDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  type DivoSessionStatus,
  getDivoSessionStatus,
  getStoredDivoBackendUrl,
  normalizeDivoBackendUrl,
  signInDivoWithLark,
  storeDivoBackendUrl,
} from '@/lib/divo-auth'
import { cn } from '@/lib/utils'

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: ({ error }) => <GlobalError error={error} />,
})

const AppLayout = () => {
  const { productAnalyticPrompt } = useAnalytic()
  const { showJanModelPrompt } = useJanModelPrompt()
  const {
    open: isLeftPanelOpen,
    setLeftPanel,
    width: sidebarWidth,
    setLeftPanelWidth,
  } = useLeftPanel()

  return (
    <div className="bg-neutral-50 dark:bg-background size-full relative">
      <SidebarProvider
        open={isLeftPanelOpen}
        onOpenChange={setLeftPanel}
        defaultWidth={sidebarWidth}
        onWidthChange={setLeftPanelWidth}
      >
        <AnalyticProvider />
        <KeyboardShortcutsProvider />
        {/* Fake absolute panel top to enable window drag */}
        {(IS_WINDOWS || IS_LINUX) && <WindowControls />}
        {IS_LINUX && <WindowResizeGrips />}
        {IS_TAURI && (
          <div
            className="fixed w-full h-12 z-20 top-0 cursor-grab active:cursor-grabbing"
            title="Drag window"
            aria-label="Window drag area"
            data-tauri-drag-region
          />
        )}
        <DialogAppUpdater />
        <BackendUpdater />
        <LeftSidebar />
        <SidebarInset>
          <div className="bg-neutral-50 dark:bg-background size-full">
            <Outlet />
          </div>
        </SidebarInset>

        {productAnalyticPrompt && <PromptAnalytic />}
        {showJanModelPrompt && <PromptJanModel />}
      </SidebarProvider>
    </div>
  )
}

const LogsLayout = () => {
  return (
    <Fragment>
      <main className="relative h-svh text-sm antialiased select-text bg-app">
        <div className="flex h-full">
          {/* Main content panel */}
          <div className="h-full flex w-full">
            <div className="bg-background text-foreground border w-full overflow-hidden">
              <Outlet />
            </div>
          </div>
        </div>
      </main>
    </Fragment>
  )
}

function DivoSignInGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<DivoSessionStatus | null>(null)
  const [backendUrl, setBackendUrl] = useState(getStoredDivoBackendUrl)
  const [isChecking, setIsChecking] = useState(true)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshSession = async () => {
    setIsChecking(true)
    try {
      const next = await getDivoSessionStatus()
      setSession(next.configured ? next : null)
      if (next.backendUrl) {
        setBackendUrl(next.backendUrl)
        storeDivoBackendUrl(next.backendUrl)
      }
    } catch {
      setSession(null)
    } finally {
      setIsChecking(false)
    }
  }

  useEffect(() => {
    void refreshSession()
  }, [])

  const signIn = async () => {
    setIsSigningIn(true)
    setError(null)
    try {
      const normalized = normalizeDivoBackendUrl(backendUrl)
      setBackendUrl(normalized)
      const next = await signInDivoWithLark(normalized)
      setSession(next.configured ? next : null)
    } catch (err) {
      setError(String(err))
      setSession(null)
    } finally {
      setIsSigningIn(false)
    }
  }

  if (isChecking) {
    return (
      <div className="grid h-svh place-items-center bg-background text-foreground">
        <div className="text-sm text-muted-foreground">Checking Divo session...</div>
      </div>
    )
  }

  if (session?.configured) return <>{children}</>

  return (
    <main className="grid h-svh bg-background text-foreground lg:grid-cols-[1.05fr_0.95fr]">
      <section className="relative hidden overflow-hidden border-r border-border/70 bg-zinc-950 lg:block">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_28%_24%,rgba(56,189,248,0.18),transparent_34%),radial-gradient(circle_at_72%_62%,rgba(244,63,94,0.14),transparent_30%)]" />
        <div className="relative flex h-full flex-col justify-between p-12">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-lg border border-white/10 bg-white/10 text-sm font-semibold text-white">
              D
            </div>
            <div>
              <p className="text-sm font-medium text-white">Divo Desktop</p>
              <p className="text-xs text-white/50">Company workspace</p>
            </div>
          </div>

          <div className="max-w-xl">
            <p className="text-sm uppercase tracking-[0.22em] text-cyan-200/70">Secure agent workspace</p>
            <h1 className="mt-5 text-5xl font-medium leading-tight tracking-normal text-white">
              Work through your company context, tools, and permissions.
            </h1>
            <p className="mt-5 max-w-lg text-base leading-7 text-white/60">
              Sign in once, then Divo can route Pi through backend-owned skills,
              connected accounts, RBAC, and approvals.
            </p>
          </div>

          <div className="grid max-w-xl gap-3 text-sm text-white/60">
            {['Backend-owned credentials', 'Role-based tool access', 'Audited gateway execution'].map((item) => (
              <div key={item} className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3">
                {item}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="flex min-h-0 items-center justify-center px-6 py-10">
        <div className="w-full max-w-md">
          <div className="mb-8 lg:hidden">
            <div className="grid size-11 place-items-center rounded-lg border border-border bg-card text-sm font-semibold">
              D
            </div>
          </div>

          <p className="text-sm text-muted-foreground">Welcome to Divo</p>
          <h2 className="mt-2 text-3xl font-medium tracking-normal">Sign in to continue</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Desktop access is locked until your Divo backend session is active.
          </p>

          <div className="mt-8 space-y-3">
            <label className="block text-xs font-medium text-muted-foreground">Backend URL</label>
            <Input
              value={backendUrl}
              onChange={(event) => setBackendUrl(event.target.value)}
              disabled={isSigningIn}
            />
            {error ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}
            <Button
              className={cn('mt-2 h-11 w-full')}
              onClick={() => void signIn()}
              disabled={isSigningIn}
            >
              {isSigningIn ? 'Waiting for Lark...' : 'Sign in with Lark'}
            </Button>
          </div>

          <p className="mt-5 text-xs leading-5 text-muted-foreground">
            This uses the same Divo sign-in flow as Settings. Tokens stay in the
            desktop session store and backend-owned integrations remain server-side.
          </p>
        </div>
      </section>
    </main>
  )
}

function RootLayout() {
  const getInitialLayoutType = () => {
    const pathname = window.location.pathname
    return (
      pathname === route.localApiServerlogs ||
      pathname === route.systemMonitor ||
      pathname === route.appLogs
    )
  }

  const IS_LOGS_ROUTE = getInitialLayoutType()

  return (
    <Fragment>
      <ServiceHubProvider>
        <ThemeProvider />
        <InterfaceProvider />
        <ToasterProvider />
        <TranslationProvider>
          <ExtensionProvider>
            <DataProvider />
            <GlobalEventHandler />
            {IS_LOGS_ROUTE ? <LogsLayout /> : (
              <DivoSignInGate>
                <AppLayout />
              </DivoSignInGate>
            )}
          </ExtensionProvider>
          {/* <TanStackRouterDevtools position="bottom-right" /> */}
          <ToolApproval />
          <AttachmentIngestionDialog />
          <ErrorDialog />
          <LlamacppBusyOnExitDialog />
          <LlamacppOomListener />
          <MissingDependenciesDialog />
          <OutOfContextPromiseModal />
        </TranslationProvider>
      </ServiceHubProvider>
    </Fragment>
  )
}
