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
import { DivoDexMark } from '@/components/DivoDexBrand'
import { Button as AstryxButton } from '@astryxdesign/core/Button'
import { TextInput as AstryxTextInput } from '@astryxdesign/core/TextInput'

import { DivoRunReplay } from '@/components/sign-in/DivoRunReplay'
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
            <DivoRunReplay />
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

            {/* Astryx owns the pending state: `clickAction` keeps the spinner,
                the disabled window, and the aria-busy announcement tied to the
                actual promise, so they cannot drift out of sync the way a
                hand-held `isSigningIn` flag can. */}
            <AstryxButton
              label={isSigningIn ? 'Waiting for Lark…' : 'Sign in with Lark'}
              variant="primary"
              size="lg"
              // Full-width via the Tailwind bridge rather than `xstyle`:
              // xstyle takes authored StyleX, which is the one thing in this
              // setup that would drag in the StyleX compiler.
              className="w-full"
              clickAction={signIn}
            />
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
            <div className="mt-3">
              {/* Label hidden, not dropped: Astryx renders it at the full form
                  type scale, which on a tucked-away advanced field out-shouted
                  the page's own greeting. The disclosure summary above already
                  names it for sighted users; screen readers still get it. */}
              <AstryxTextInput
                label="Backend URL"
                isLabelHidden
                value={backendUrl}
                onChange={(value) => setBackendUrl(value)}
                isDisabled={isSigningIn}
                size="sm"
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

  return (
    <div className="flex h-svh overflow-hidden bg-background animate-in fade-in duration-500">
      {dragStrip}

      <div className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-2 pb-2 md:flex">
        {/* Window-controls strip — empty on purpose, it's where the traffic
            lights already sit. */}
        <div className="h-8 shrink-0" />

        {/* Brand row: mark, wordmark, search affordance. Drawn rather than
            skeletoned — these are the parts of the chrome we already know, so
            faking them as grey bars would be pretending not to. */}
        <div className="flex h-10 items-center gap-2 px-1">
          <div className="size-5 rounded-md bg-sidebar-foreground/[0.10]" />
          <SkeletonBar className="h-3.5 w-16" delay={0} />
          <div className="ml-auto size-4 rounded bg-sidebar-foreground/[0.07]" />
        </div>

        <div className="mt-2 flex flex-col gap-1">
          {NAV_WIDTHS.map((width, index) => (
            <SkeletonRow key={index} width={width} delay={80 + index * 70} />
          ))}
        </div>

        <div className="mt-5 flex flex-col gap-1">
          <SkeletonBar className="mx-3 mb-1 h-2.5 w-10" delay={300} />
          {CHAT_WIDTHS.map((width, index) => (
            <SkeletonRow
              key={index}
              width={width}
              delay={340 + index * 55}
              // Thread rows carry no icon, so the bar runs the full row.
              bare
            />
          ))}
        </div>

        <div className="mt-auto flex h-9 items-center gap-2 rounded-lg px-1">
          <div className="size-6 rounded-full bg-sidebar-foreground/[0.09]" />
          <SkeletonBar className="h-3 w-20" delay={820} />
        </div>
      </div>

      {/* The mark is the one thing worth actually rendering: it tells the user
          which app is starting, which no arrangement of grey boxes can. */}
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-7 px-6">
        <DivoBrandGlyph />
        <SkeletonBar className="h-3 w-40 rounded-full" delay={120} />
        <div className="h-28 w-full max-w-2xl rounded-2xl border border-border/60 bg-card/40" />
      </div>
    </div>
  )
}

/**
 * Placeholder widths, as percentages.
 *
 * Fixed rather than random: uniform full-width blocks are the single biggest
 * tell that a skeleton is fake, but random widths would reshuffle on every
 * render and jitter. These are hand-picked to look like real nav labels and
 * thread titles — a couple of long ones, a couple of stubs.
 */
const NAV_WIDTHS = [46, 62, 38]
const CHAT_WIDTHS = [78, 55, 88, 41, 70, 84, 49, 63]

/** One sheened bar. `delay` staggers it against its neighbours. */
function SkeletonBar({
  className,
  delay = 0,
}: {
  className?: string
  delay?: number
}) {
  return (
    <div
      className={cn(
        'skeleton-sheen rounded bg-sidebar-foreground/[0.06]',
        className
      )}
      style={{ animationDelay: `${delay}ms` }}
    />
  )
}

/** A sidebar row: optional leading icon block plus a label bar. */
function SkeletonRow({
  width,
  delay,
  bare = false,
}: {
  width: number
  delay: number
  bare?: boolean
}) {
  return (
    <div className="flex h-7 items-center gap-2.5 px-1">
      {!bare && (
        <div className="size-4 shrink-0 rounded bg-sidebar-foreground/[0.07]" />
      )}
      {/* The bar takes the remaining space and a spacer eats the rest, so
          `width` reads as "how much of the row this label fills". */}
      <SkeletonBar className="h-3 min-w-0 flex-1" delay={delay} />
      <div style={{ width: `${100 - width}%` }} className="shrink-0" />
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
