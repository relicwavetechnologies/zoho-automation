import { createRootRoute, Outlet } from '@tanstack/react-router'
// import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { motion, useReducedMotion, type Variants } from 'framer-motion'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
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
import { DivoDexMark } from '@/components/DivoDexBrand'
import { DivoShowcase } from '@/components/sign-in/DivoShowcase'
import {
  type DivoSessionStatus,
  getStoredDivoBackendUrl,
  normalizeDivoBackendUrl,
  signInDivoWithLark,
  storeDivoBackendUrl,
  validateDivoSession,
} from '@/lib/divo-auth'
import { cn } from '@/lib/utils'
import { TeachReliabilityProvider } from '@/providers/TeachReliabilityProvider'

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
  // Only the first validation gates the app. `divo_validate_session` is two
  // network round-trips (GET /me + runtime context refresh), so re-running it
  // blocking on every session event would unmount the whole UI mid-session.
  const [isBooting, setIsBooting] = useState(true)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshSession = useCallback(async () => {
    try {
      const next = await validateDivoSession()
      setSession(next.configured ? next : null)
      if (next.backendUrl) {
        setBackendUrl(next.backendUrl)
        storeDivoBackendUrl(next.backendUrl)
      }
      setError(null)
    } catch (err) {
      setSession(null)
      setError(err instanceof Error ? err.message : 'Unable to verify the Divo session.')
    } finally {
      setIsBooting(false)
    }
  }, [])

  useEffect(() => {
    void refreshSession()
  }, [refreshSession])

  useEffect(() => {
    if (!IS_TAURI) return
    let cancelled = false
    let unlisten: (() => void) | undefined

    void listen<{ configured?: boolean }>('divo-session-changed', (event) => {
      if (event.payload?.configured) {
        void refreshSession()
        return
      }
      setSession(null)
      setIsBooting(false)
      void invoke('pi_stop').catch(() => undefined)
    }).then((dispose) => {
      if (cancelled) {
        dispose()
        return
      }
      unlisten = dispose
    })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [refreshSession])

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

  if (isBooting) return <DivoBootSkeleton />


  if (session?.configured) return <>{children}</>

  return (
    <main className="grid h-svh overflow-hidden bg-background text-foreground lg:grid-cols-[1.1fr_0.9fr]">
      {/* Window drag strip so the frameless window stays movable on the gate */}
      {IS_TAURI && (
        <div
          className="fixed inset-x-0 top-0 z-30 h-10"
          data-tauri-drag-region
          aria-hidden
        />
      )}

      {/* ── Branding panel (desktop only) ── */}
      <section className="relative hidden overflow-hidden bg-zinc-950 text-white lg:flex">
        <DivoAmbientBackdrop tone="dark" />
        <motion.div
          variants={SIGN_IN_CONTAINER}
          initial="hidden"
          animate="show"
          className="relative z-10 flex h-full w-full flex-col justify-between p-12 xl:p-14"
        >
          <motion.div variants={SIGN_IN_ITEM} className="flex items-center gap-3">
            <DivoDexMark decorative className="size-9 text-primary" />
            <div>
              <p className="text-sm font-medium">Divo Dex</p>
              <p className="text-xs text-white/45">Company workspace</p>
            </div>
          </motion.div>

          {/* The panel is a running product demo rather than a static pitch —
              five miniatures of real Divo surfaces, cycling. */}
          <motion.div
            variants={SIGN_IN_ITEM}
            className="flex flex-1 items-center justify-center py-8"
          >
            <DivoShowcase />
          </motion.div>
        </motion.div>
      </section>

      {/* ── Form panel ── */}
      <section className="relative flex items-center justify-center px-6 py-10">
        <motion.div
          variants={SIGN_IN_CONTAINER}
          initial="hidden"
          animate="show"
          className="w-full max-w-sm"
        >
          <motion.div variants={SIGN_IN_ITEM} className="mb-8 lg:hidden">
            <DivoBrandGlyph />
          </motion.div>

          <motion.p
            variants={SIGN_IN_ITEM}
            className="text-sm text-muted-foreground"
          >
            Welcome to Divo Dex
          </motion.p>
          <motion.h2
            variants={SIGN_IN_ITEM}
            className="mt-2 font-studio text-3xl font-medium tracking-tight"
          >
            Sign in to continue
          </motion.h2>
          <motion.p
            variants={SIGN_IN_ITEM}
            className="mt-3 text-sm leading-6 text-muted-foreground"
          >
            Desktop access unlocks once your Divo Dex workspace session is
            active.
          </motion.p>

          <motion.div variants={SIGN_IN_ITEM} className="mt-8 space-y-3">
            {error ? (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
              >
                {error}
              </motion.div>
            ) : null}

            <Button
              className={cn(
                'group relative h-11 w-full overflow-hidden text-sm font-medium'
              )}
              onClick={() => void signIn()}
              disabled={isSigningIn}
            >
              {/* Sheen sweep on hover */}
              <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full" />
              <span className="relative flex items-center justify-center gap-2">
                {isSigningIn ? (
                  <>
                    <span className="size-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
                    Waiting for Lark…
                  </>
                ) : (
                  'Sign in with Lark'
                )}
              </span>
            </Button>
          </motion.div>

          <motion.details
            variants={SIGN_IN_ITEM}
            className="group mt-4 w-full"
          >
            <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground/80 transition-colors hover:text-foreground">
              Backend settings
              <svg
                className="size-3 transition-transform group-open:rotate-180"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path
                  d="m6 9 6 6 6-6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </summary>
            <div className="mt-3 space-y-1.5">
              <label className="block text-xs font-medium text-muted-foreground">
                Backend URL
              </label>
              <Input
                value={backendUrl}
                onChange={(event) => setBackendUrl(event.target.value)}
                disabled={isSigningIn}
                className="h-10 text-sm"
              />
            </div>
          </motion.details>

          <motion.p
            variants={SIGN_IN_ITEM}
            className="mt-8 text-[11px] leading-5 text-muted-foreground/70"
          >
            Tokens stay in the desktop session store. Backend-owned integrations
            remain server-side.
          </motion.p>
        </motion.div>
      </section>
    </main>
  )
}

const SIGN_IN_CONTAINER: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.07, delayChildren: 0.12 },
  },
}

const SIGN_IN_ITEM: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.55, ease: [0.16, 1, 0.3, 1] },
  },
}

/** Hold off on any loading UI so a fast session check never flashes a screen. */
const BOOT_SKELETON_DELAY_MS = 500

/**
 * Shown only while the *first* session validation is in flight, and only once
 * it has run long enough to be worth acknowledging. Mirrors the real layout —
 * sidebar rail plus composer — so the app appears to be arriving rather than
 * blocked behind a gate.
 */
function DivoBootSkeleton() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), BOOT_SKELETON_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  // Keep the frameless window draggable even while nothing else is painted.
  const dragStrip = IS_TAURI ? (
    <div className="fixed inset-x-0 top-0 z-30 h-10" data-tauri-drag-region aria-hidden />
  ) : null

  if (!visible) return <div className="h-svh bg-background">{dragStrip}</div>

  const block = 'rounded-lg bg-sidebar-foreground/[0.07]'

  return (
    <div className="flex h-svh overflow-hidden bg-background animate-in fade-in duration-500">
      {dragStrip}
      <div className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-2 md:flex">
        <div className="flex flex-col gap-1 motion-reduce:animate-none animate-pulse">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className={cn(block, 'h-9')} />
          ))}
        </div>
        <div className="mt-6 flex flex-col gap-1 motion-reduce:animate-none animate-pulse">
          <div className="mx-2.5 mb-1 h-3 w-14 rounded bg-sidebar-foreground/[0.05]" />
          {Array.from({ length: 7 }).map((_, index) => (
            <div key={index} className="h-8 rounded-lg bg-sidebar-foreground/[0.04]" />
          ))}
        </div>
        <div className={cn(block, 'mt-auto h-11 motion-reduce:animate-none animate-pulse')} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-6 px-6">
        <div className="h-7 w-64 max-w-full rounded-md bg-foreground/[0.06] motion-reduce:animate-none animate-pulse" />
        <div className="h-28 w-full max-w-2xl rounded-2xl border border-border/60 bg-card/40" />
      </div>
    </div>
  )
}

/** The Divo mark, framed by a soft coral glow that breathes. */
function DivoBrandGlyph() {
  const reduce = useReducedMotion()
  return (
    <div className="relative grid size-16 place-items-center">
      <motion.span
        aria-hidden
        className="absolute inset-0 rounded-[22px] bg-primary/25 blur-2xl"
        animate={
          reduce
            ? undefined
            : { opacity: [0.35, 0.7, 0.35], scale: [0.9, 1.08, 0.9] }
        }
        transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="relative grid size-16 place-items-center rounded-[20px] border border-border/60 bg-card/60 backdrop-blur-sm">
        <DivoDexMark decorative className="size-8 text-primary" />
      </div>
    </div>
  )
}

/**
 * Slowly drifting coral orbs + dot grid + vignette. Respects reduced motion.
 * `tone="app"` fades into the themed background; `tone="dark"` fades into the
 * always-dark branding panel.
 */
function DivoAmbientBackdrop({ tone = 'app' }: { tone?: 'app' | 'dark' }) {
  const reduce = useReducedMotion()
  const isDark = tone === 'dark'
  const loop = (i: number) =>
    reduce
      ? undefined
      : {
          x: [0, i % 2 === 0 ? 40 : -40, 0],
          y: [0, i % 2 === 0 ? -30 : 30, 0],
          scale: [1, 1.12, 1],
        }
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <motion.div
        className={cn(
          'absolute -left-24 top-[-10%] size-[42vw] rounded-full blur-[120px]',
          isDark ? 'bg-primary/25' : 'bg-primary/20'
        )}
        animate={loop(0)}
        transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className={cn(
          'absolute right-[-8%] top-[20%] size-[36vw] rounded-full blur-[120px]',
          isDark ? 'bg-primary/15' : 'bg-primary/10'
        )}
        animate={loop(1)}
        transition={{ duration: 22, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className={cn(
          'absolute bottom-[-15%] left-1/3 size-[38vw] rounded-full blur-[130px]',
          isDark ? 'bg-primary/10' : 'bg-primary/[0.08]'
        )}
        animate={loop(2)}
        transition={{ duration: 26, repeat: Infinity, ease: 'easeInOut' }}
      />
      {/* Faint dot grid for texture */}
      <div
        className={cn(
          'absolute inset-0 [background-size:26px_26px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_72%)]',
          isDark
            ? 'opacity-[0.5] [background-image:radial-gradient(circle_at_center,rgba(255,255,255,0.08)_1px,transparent_1px)]'
            : 'opacity-[0.4] [background-image:radial-gradient(circle_at_center,var(--border)_1px,transparent_1px)]'
        )}
      />
      {/* Depth vignette */}
      <div
        className={cn(
          'absolute inset-0',
          isDark
            ? 'bg-[radial-gradient(ellipse_at_center,transparent_30%,#09090b_92%)]'
            : 'bg-[radial-gradient(ellipse_at_center,transparent_35%,var(--background)_92%)]'
        )}
      />
    </div>
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
            <DivoSignInGate>
              <TeachReliabilityProvider />
              {IS_LOGS_ROUTE ? <LogsLayout /> : <AppLayout />}
            </DivoSignInGate>
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
