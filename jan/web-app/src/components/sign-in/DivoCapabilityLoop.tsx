import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { CheckIcon, SearchIcon, WaypointsIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type ComponentType } from 'react'

import {
  CanvaIcon,
  GmailIcon,
  GoogleAppsScriptIcon,
  GoogleCalendarIcon,
  GoogleChatIcon,
  GoogleContactsIcon,
  GoogleDocsIcon,
  GoogleDriveIcon,
  GoogleFormsIcon,
  GoogleSheetsIcon,
  GoogleSlidesIcon,
  GoogleTasksIcon,
  LarkIcon,
  SemrushIcon,
  ZohoIcon,
} from '@/components/brand-icons'
import { cn } from '@/lib/utils'

/**
 * The sign-in panel's product loop.
 *
 * The previous version cycled five self-contained scenes on a timer, which
 * reads as a slideshow: five claims, none of them finished. This plays a
 * SINGLE run and lets it accumulate — request, plan, each tool firing in turn,
 * then the answer — because the thing worth showing is not that Divo has a
 * Gmail integration, it is that Divo chains them and shows its work. A viewer
 * who looks away and back is still inside the same story.
 *
 * Everything here is a MOCKUP and must stay one. The gate renders before any
 * session exists, so nothing in this file may touch a store, the gateway, or
 * Tauri. Hand-building the miniatures also means a refactor of the real chat
 * cannot take the sign-in screen down with it.
 */

/** Beat duration. Slow enough to read a line, brisk enough to feel like work. */
const BEAT_MS = 1150
/** How long the finished run rests before starting over. */
const HOLD_MS = 3400

type ToolMark = ComponentType<{ className?: string }>

/**
 * Every integration Divo can reach, as its real mark.
 *
 * The constellation exists to answer "what is this connected to?" at a glance,
 * which a list of names cannot do — logos are recognised pre-attentively. The
 * ones the run actually touches light up, so the ring doubles as a legend for
 * the timeline instead of being decoration parked next to it.
 */
const CONSTELLATION: { id: string; Mark: ToolMark }[] = [
  { id: 'gmail', Mark: GmailIcon },
  { id: 'drive', Mark: GoogleDriveIcon },
  { id: 'calendar', Mark: GoogleCalendarIcon },
  { id: 'docs', Mark: GoogleDocsIcon },
  { id: 'sheets', Mark: GoogleSheetsIcon },
  { id: 'slides', Mark: GoogleSlidesIcon },
  { id: 'forms', Mark: GoogleFormsIcon },
  { id: 'tasks', Mark: GoogleTasksIcon },
  { id: 'contacts', Mark: GoogleContactsIcon },
  { id: 'chat', Mark: GoogleChatIcon },
  { id: 'appsScript', Mark: GoogleAppsScriptIcon },
  { id: 'lark', Mark: LarkIcon },
  { id: 'zoho', Mark: ZohoIcon },
  { id: 'canva', Mark: CanvaIcon },
  { id: 'semrush', Mark: SemrushIcon },
]

type Beat =
  | { kind: 'ask'; text: string }
  | { kind: 'think'; text: string }
  | { kind: 'tool'; tool: string; label: string; detail: string }
  | { kind: 'result'; text: string }

/**
 * One real errand, told end to end.
 *
 * Deliberately spans three vendors: a single-tool demo would look like a
 * shortcut, and the whole argument for an agent is that it crosses systems
 * nobody has wired together.
 */
const RUN: Beat[] = [
  { kind: 'ask', text: 'Which invoices are overdue, and who do I chase?' },
  { kind: 'think', text: 'Checking billing, then matching owners to contacts' },
  { kind: 'tool', tool: 'zoho', label: 'Zoho Books', detail: 'list overdue invoices' },
  { kind: 'tool', tool: 'contacts', label: 'Google Contacts', detail: 'resolve account owners' },
  { kind: 'tool', tool: 'gmail', label: 'Gmail', detail: 'draft 3 follow-ups' },
  { kind: 'result', text: '3 overdue · ₹4.2L · drafts ready to send' },
]

const MARKS = new Map(CONSTELLATION.map((entry) => [entry.id, entry.Mark]))

function ToolMarkFor({ id, className }: { id: string; className?: string }) {
  const Mark = MARKS.get(id)
  return Mark ? <Mark className={className} /> : null
}

/** A work-log line, matching the vocabulary of the real chat's timeline. */
function BeatRow({ beat, isLatest }: { beat: Beat; isLatest: boolean }) {
  if (beat.kind === 'ask') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-2xl rounded-br-md bg-white/10 px-3.5 py-2 text-[13px] leading-snug text-white/85">
          {beat.text}
        </div>
      </div>
    )
  }

  if (beat.kind === 'think') {
    return (
      <div className="flex items-center gap-2.5 text-white/45">
        <WaypointsIcon strokeWidth={1.5} className="size-4 shrink-0" />
        {/* Only the newest line shimmers. A settled step that keeps pulsing
            reads as stuck rather than finished. */}
        <span className={cn('truncate text-[12.5px]', isLatest && 'text-shimmer')}>
          {beat.text}
        </span>
      </div>
    )
  }

  if (beat.kind === 'tool') {
    return (
      <div className="flex items-center gap-2.5">
        <span className="grid size-4 shrink-0 place-items-center">
          <ToolMarkFor id={beat.tool} className="size-4" />
        </span>
        <span className="shrink-0 text-[12.5px] text-white/70">{beat.label}</span>
        <span
          className={cn(
            'min-w-0 truncate text-[12.5px] text-white/40',
            isLatest && 'text-shimmer'
          )}
        >
          {beat.detail}
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2.5 text-emerald-300/90">
      <CheckIcon strokeWidth={2} className="size-4 shrink-0" />
      <span className="truncate text-[12.5px]">{beat.text}</span>
    </div>
  )
}

/**
 * The integration ring.
 *
 * Marks used by the run so far come forward; the rest stay dim but present —
 * the dim ones are the actual message ("and everything else is already here"),
 * so they are never hidden, only receded.
 */
function Constellation({ activeTools }: { activeTools: Set<string> }) {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-2">
      {CONSTELLATION.map(({ id, Mark }) => {
        const active = activeTools.has(id)
        return (
          <li key={id}>
            <motion.span
              aria-hidden
              animate={{
                opacity: active ? 1 : 0.28,
                scale: active ? 1 : 0.92,
              }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              className={cn(
                'grid size-8 place-items-center rounded-xl border transition-colors',
                active
                  ? 'border-white/20 bg-white/10'
                  : 'border-white/[0.06] bg-white/[0.02]'
              )}
            >
              <Mark className="size-4" />
            </motion.span>
          </li>
        )
      })}
    </ul>
  )
}

export function DivoCapabilityLoop() {
  const reduceMotion = useReducedMotion()
  // `visible` counts beats revealed so far. The run builds up rather than
  // swapping, which is what makes it read as one task instead of a carousel.
  const [visible, setVisible] = useState(reduceMotion ? RUN.length : 0)

  useEffect(() => {
    // Reduced motion gets the finished state outright: the information is the
    // point, the animation is the garnish.
    if (reduceMotion) {
      setVisible(RUN.length)
      return
    }

    const done = visible >= RUN.length
    const timer = setTimeout(
      () => setVisible(done ? 0 : visible + 1),
      done ? HOLD_MS : BEAT_MS
    )
    return () => clearTimeout(timer)
  }, [visible, reduceMotion])

  const beats = RUN.slice(0, visible)

  const activeTools = useMemo(
    () =>
      new Set(
        beats.flatMap((beat) => (beat.kind === 'tool' ? [beat.tool] : []))
      ),
    [beats]
  )

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 backdrop-blur-sm">
        {/* Top-anchored, matching the real chat: the request stays pinned and
            the work log grows beneath it. Bottom-anchoring made the run climb
            upward, which left the question hanging in the middle of an empty
            card and read backwards from every other timeline in the product.

            Fixed height so the panel never reflows as lines land — a jumping
            card under a settling headline looks broken, not alive. */}
        <div className="flex min-h-[188px] flex-col justify-start gap-2.5">
          <AnimatePresence initial={false}>
            {beats.map((beat, index) => (
              <motion.div
                key={`${beat.kind}-${index}`}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              >
                <BeatRow beat={beat} isLatest={index === beats.length - 1} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>

      <Constellation activeTools={activeTools} />

      <p className="text-center text-[11.5px] leading-5 text-white/35">
        <SearchIcon
          strokeWidth={1.5}
          className="mr-1.5 inline size-3.5 align-[-2px]"
        />
        Divo picks the tools, chains them, and shows every step.
      </p>
    </div>
  )
}
