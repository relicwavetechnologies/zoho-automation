import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  BicepsFlexedIcon,
  CheckIcon,
  GraduationCapIcon,
  SearchIcon,
  ShieldCheckIcon,
  SquareTerminalIcon,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import {
  CanvaIcon,
  GmailIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  LarkIcon,
  ZohoIcon,
} from '@/components/brand-icons'
import { DivoDexMark } from '@/components/DivoDexBrand'
import { cn } from '@/lib/utils'

/**
 * The sign-in panel's product loop: five scenes, each a miniature of a real
 * Divo surface, cycling on a timer.
 *
 * These are deliberately *mockups*, not live components — the gate renders
 * before any session exists, so nothing here may touch a store, the gateway, or
 * Tauri. Keeping them hand-built also means a refactor of the real chat cannot
 * break the sign-in screen.
 */

const SCENE_MS = 5200

/** Rows animate in sequence so a scene assembles rather than snapping in. */
const scene = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.12 } },
}

const row = {
  hidden: { opacity: 0, y: 10 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] as const },
  },
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={row} className={className}>
      {children}
    </motion.div>
  )
}

/** The chrome every scene sits in — a floating panel, like a window of the app. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur-sm">
      {children}
    </div>
  )
}

function UserBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl bg-white/10 px-3.5 py-2 text-[13px] leading-snug text-white/85">
        {children}
      </div>
    </div>
  )
}

/** A work-log line, matching the real chat's icon + label rows. */
function ToolRow({
  icon,
  label,
  running,
}: {
  icon: ReactNode
  label: string
  running?: boolean
}) {
  return (
    <div className="flex items-center gap-2.5 text-white/55">
      <span className="grid size-4 shrink-0 place-items-center">{icon}</span>
      <span className={cn('truncate text-[12.5px]', running && 'text-shimmer')}>
        {label}
      </span>
    </div>
  )
}

const SCENES = [
  {
    id: 'ask',
    eyebrow: 'Just ask',
    title: 'Plain language in. Real work out.',
    body: 'Divo picks the right tools and shows every step it takes.',
    render: () => (
      <Frame>
        <motion.div variants={scene} initial="hidden" animate="show" className="space-y-3">
          <Row>
            <UserBubble>Which invoices are overdue this week?</UserBubble>
          </Row>
          <Row>
            <ToolRow
              icon={<SearchIcon className="size-4" />}
              label="Ran skill search"
            />
          </Row>
          <Row>
            <ToolRow
              icon={<ZohoIcon className="size-4" />}
              label="Running zoho books"
              running
            />
          </Row>
          <Row>
            <div className="rounded-xl bg-white/[0.04] px-3 py-2.5 text-[13px] leading-relaxed text-white/70">
              <span className="font-medium text-white/90">4 invoices</span> are
              past due, totalling{' '}
              <span className="font-medium text-white/90">₹8.24L</span>. The
              oldest is 23 days out.
            </div>
          </Row>
        </motion.div>
      </Frame>
    ),
  },
  {
    id: 'tools',
    eyebrow: 'Connected',
    title: 'Your apps, already wired in.',
    body: 'No setup per chat — permissions come from your workspace.',
    render: () => (
      <Frame>
        <motion.div variants={scene} initial="hidden" animate="show" className="grid grid-cols-2 gap-2">
          {[
            { icon: <LarkIcon className="size-4" />, name: 'Lark' },
            { icon: <ZohoIcon className="size-4" />, name: 'Zoho Books' },
            { icon: <GmailIcon className="size-4" />, name: 'Gmail' },
            { icon: <GoogleDriveIcon className="size-4" />, name: 'Drive' },
            { icon: <GoogleCalendarIcon className="size-4" />, name: 'Calendar' },
            { icon: <CanvaIcon className="size-4" />, name: 'Canva' },
          ].map((tool) => (
            <Row key={tool.name}>
              <div className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
                <span className="shrink-0">{tool.icon}</span>
                <span className="flex-1 truncate text-[12.5px] text-white/75">
                  {tool.name}
                </span>
                <CheckIcon className="size-3.5 shrink-0 text-primary" />
              </div>
            </Row>
          ))}
        </motion.div>
      </Frame>
    ),
  },
  {
    id: 'approval',
    eyebrow: 'In your control',
    title: 'Nothing leaves without your say-so.',
    body: 'Every outbound action pauses for approval, with the exact payload.',
    render: () => (
      <Frame>
        <motion.div variants={scene} initial="hidden" animate="show" className="space-y-3">
          <Row>
            <div className="flex items-center gap-2.5">
              <ShieldCheckIcon className="size-4 shrink-0 text-primary" />
              <span className="text-[12.5px] font-medium text-white/85">
                Approval needed
              </span>
            </div>
          </Row>
          <Row>
            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex items-center gap-2 text-[12.5px] text-white/70">
                <LarkIcon className="size-4 shrink-0" />
                Send message to #finance
              </div>
              <p className="mt-2 border-l-2 border-white/15 pl-2.5 text-[12px] leading-relaxed text-white/45">
                “Reminder: 4 invoices are past due. Summary attached.”
              </p>
            </div>
          </Row>
          <Row>
            <div className="flex gap-2">
              <div className="flex-1 rounded-lg bg-primary px-3 py-2 text-center text-[12.5px] font-medium text-primary-foreground">
                Approve
              </div>
              <div className="rounded-lg border border-white/12 px-3 py-2 text-[12.5px] text-white/55">
                Decline
              </div>
            </div>
          </Row>
        </motion.div>
      </Frame>
    ),
  },
  {
    id: 'knowledge',
    eyebrow: 'Grounded',
    title: 'Answers from your company, not the internet.',
    body: 'Divo remembers your context and cites where an answer came from.',
    render: () => (
      <Frame>
        <motion.div variants={scene} initial="hidden" animate="show" className="space-y-3">
          <Row>
            <UserBubble>What&apos;s our refund policy for annual plans?</UserBubble>
          </Row>
          <Row>
            <ToolRow
              icon={<DivoDexMark decorative className="size-4" />}
              label="Recalled from memory"
            />
          </Row>
          <Row>
            <div className="rounded-xl bg-white/[0.04] px-3 py-2.5 text-[13px] leading-relaxed text-white/70">
              Pro-rated after 30 days, full refund before.
              <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-white/40">
                <GoogleDriveIcon className="size-3" />
                Billing Policy v4 · Finance
              </div>
            </div>
          </Row>
        </motion.div>
      </Frame>
    ),
  },
  {
    id: 'teach',
    eyebrow: 'It learns',
    title: 'Show it once. It keeps the workflow.',
    body: 'Record how you do something and Divo turns it into a reusable skill.',
    render: () => (
      <Frame>
        <motion.div variants={scene} initial="hidden" animate="show" className="space-y-2.5">
          {[
            { icon: <GraduationCapIcon className="size-4" />, label: 'Recorded your walkthrough', done: true },
            { icon: <SquareTerminalIcon className="size-4" />, label: 'Traced the steps you took', done: true },
            { icon: <BicepsFlexedIcon className="size-4" />, label: 'Saved as “Weekly AR chase”', done: true },
          ].map((step) => (
            <Row key={step.label}>
              <div className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
                <span className="shrink-0 text-white/50">{step.icon}</span>
                <span className="flex-1 truncate text-[12.5px] text-white/75">
                  {step.label}
                </span>
                <CheckIcon className="size-3.5 shrink-0 text-primary" />
              </div>
            </Row>
          ))}
          <Row>
            <p className="pt-1 text-[12px] text-white/40">
              Next time, just ask — Divo runs it end to end.
            </p>
          </Row>
        </motion.div>
      </Frame>
    ),
  },
]

export function DivoShowcase() {
  const [index, setIndex] = useState(0)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    // Reduced motion gets a static first scene rather than a timed carousel.
    if (reduceMotion) return
    const timer = window.setInterval(
      () => setIndex((i) => (i + 1) % SCENES.length),
      SCENE_MS
    )
    return () => window.clearInterval(timer)
  }, [reduceMotion])

  const active = SCENES[index]!

  return (
    <div className="flex w-full max-w-lg flex-col gap-6">
      {/* Fixed height so the copy and the progress rail below never shift as
          scenes of different lengths swap in — centred within it, so a short
          scene splits the slack instead of leaving it all underneath. */}
      <div className="relative flex min-h-[248px] items-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={active.id}
            className="w-full"
            initial={{ opacity: 0, y: reduceMotion ? 0 : 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -8 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          >
            {active.render()}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="min-h-[92px]">
        <AnimatePresence mode="wait">
          <motion.div
            key={`${active.id}-copy`}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-primary/80">
              {active.eyebrow}
            </p>
            <h2 className="mt-2.5 font-studio text-xl font-medium leading-snug tracking-tight text-white">
              {active.title}
            </h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-white/45">
              {active.body}
            </p>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Segments double as chapter markers and as a progress bar for the
          current scene — the fill is what tells you it is still moving. */}
      <div className="flex gap-1.5" role="tablist" aria-label="Divo capabilities">
        {SCENES.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={i === index}
            aria-label={s.title}
            onClick={() => setIndex(i)}
            className="group h-6 flex-1 py-2.5"
          >
            <span className="block h-[3px] w-full overflow-hidden rounded-full bg-white/12">
              {i === index && !reduceMotion ? (
                <motion.span
                  key={`${s.id}-fill`}
                  className="block h-full rounded-full bg-primary"
                  initial={{ width: '0%' }}
                  animate={{ width: '100%' }}
                  transition={{ duration: SCENE_MS / 1000, ease: 'linear' }}
                />
              ) : (
                <span
                  className={cn(
                    'block h-full rounded-full transition-colors',
                    i === index ? 'bg-primary' : 'bg-transparent group-hover:bg-white/25'
                  )}
                />
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
