/**
 * "Up next" — the one band at the top of Home that says what to deal with now.
 *
 * It replaces a list of open Lark tasks with five identical `Start` buttons
 * down its right edge. That list had a real problem underneath the styling:
 * every row looked equally urgent, because every row *was* drawn equally, so
 * the only way to find the late one was to read all five. A dashboard band that
 * has to be read in full is a list, not a dashboard.
 *
 * Three things carry the ranking now, and none of them is a colour on its own:
 * position (the merge in `upnext.ts` sorts by urgency), a left mark whose shape
 * differs by kind and whose colour differs by urgency, and the due text set in
 * tabular figures so a column of them lines up and can be scanned without
 * being read.
 *
 * Written in utilities against `--bui-*` rather than in `workspace.css`. Partly
 * because that is how the reference builds its own rows and how the chat
 * surface here already works — but mostly because this file then has no shared
 * stylesheet to edit, which is what lets it land beside somebody else's
 * in-progress rewrite of the page it sits on.
 */
import { ArrowRight, ShieldCheck } from 'lucide-react'
import { lateCount, upNext, type UpNextItem, type Urgency } from './upnext'
import type { Decision } from '../decisions/decision'
import type { OpenTask } from '../data/use-my-tasks'

/**
 * What each urgency looks like.
 *
 * A table rather than a chain of ternaries in the markup, so "what colour is
 * late" is answered once and the row below is legible as a layout.
 *
 * `later` is deliberately not a colour. A band where every row is tinted has
 * told you nothing — the tint only means something while most rows do not have
 * one, which is the same reason the app spends its orange on the brand alone.
 */
const TONE: Record<Urgency, { mark: string; text: string }> = {
  late:  { mark: 'var(--bui-red)',    text: 'text-[var(--bui-red)]' },
  today: { mark: 'var(--bui-orange)', text: 'text-[var(--bui-orange)]' },
  soon:  { mark: 'var(--bui-ink-3)',  text: 'text-ink-2' },
  later: { mark: 'var(--bui-line-strong)', text: 'text-ink-3' },
}

function Row({ item, onPick }: { item: UpNextItem; onPick: (item: UpNextItem) => void }) {
  const tone = TONE[item.urgency]

  return (
    <button
      type="button"
      onClick={() => onPick(item)}
      className="group flex w-full items-center gap-3 border-t border-line px-4 py-3
                 text-left transition-colors first:border-t-0 hover:bg-fill"
    >
      {/*
        The mark says two things at once: its shape is the kind and its colour
        is the urgency. An approval gets a glyph because it is not this person's
        own work — somebody is stopped waiting on it — and a task gets a dot,
        which is quieter on a band that is mostly tasks.
      */}
      <span className="grid w-4 shrink-0 place-items-center" aria-hidden>
        {item.kind === 'approval'
          ? <ShieldCheck size={14} style={{ color: tone.mark }} />
          : <span className="block h-[7px] w-[7px] rounded-full" style={{ background: tone.mark }} />}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12.5px] font-medium leading-tight text-ink">
          {item.title}
        </span>
        <span className="truncate text-[12px] leading-tight text-ink-3">
          {item.kind === 'approval' ? `${item.source} needs a decision` : item.source}
        </span>
      </span>

      {/*
        The clock and the verb share a column, right-aligned, so both edges of
        the band are a straight line down the page. `tabular-nums` is what makes
        the times readable as a column rather than as six separate sentences.
      */}
      <span className="flex shrink-0 flex-col items-end gap-0.5">
        {item.when ? (
          <span className={`text-[12px] font-medium leading-tight tabular-nums ${tone.text}`}>
            {item.when}
          </span>
        ) : null}
        <span className="flex items-center gap-1 text-[12px] leading-tight text-ink-3
                         transition-colors group-hover:text-ink">
          {item.kind === 'approval' ? 'Review' : 'Start'}
          <ArrowRight size={12} className="transition-transform group-hover:translate-x-0.5" />
        </span>
      </span>
    </button>
  )
}

/**
 * The band's own shape, while the two reads behind it are still out.
 *
 * Not `SkelRows`, which is the shape of a `.ws-row` — an icon tile, two lines
 * and a button — and this band has none of those. A placeholder that resolves
 * into something a different height is the reflow skeletons exist to prevent,
 * so the bars here are the line boxes of the real row: 15px for the title,
 * 14px for the source, the same `gap-0.5` between them.
 *
 * Four rows rather than the six the band can hold. It is a guess either way,
 * and a band that shrinks as it loads is gentler than one that grows: the
 * content below settles upward into space that was already on screen.
 */
function Loading() {
  return (
    <section className="mb-6" aria-busy="true">
      <div className="mb-3">
        <h2 className="text-[15px] font-medium leading-tight tracking-[-0.01em] text-ink">
          Up next
        </h2>
        <p className="mt-1 text-[12.5px] leading-tight text-ink-3">Looking for what needs you</p>
      </div>
      <div className="overflow-hidden rounded-card bg-surface shadow-card">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 border-t border-line px-4 py-3 first:border-t-0">
            <span className="grid w-4 shrink-0 place-items-center">
              <span className="block h-[7px] w-[7px] animate-pulse rounded-full bg-fill" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              {/* Uneven, and the same unevenness every time. A column of equal
                  bars reads as a table of one repeated value; a column that
                  reshuffles on each render reads as content arriving. */}
              <span
                className="block h-[15px] animate-pulse rounded-full bg-fill"
                style={{ width: `${38 + ((i * 17) % 30)}%` }}
              />
              <span className="block h-[14px] w-[54px] animate-pulse rounded-full bg-fill" />
            </span>
            <span className="block h-[14px] w-[52px] shrink-0 animate-pulse rounded-full bg-fill" />
          </div>
        ))}
      </div>
    </section>
  )
}

export function UpNext({
  tasks, approvals, reachable, limit = 6, loading = false, onStartTask, onOpenApproval, now,
}: {
  tasks: readonly OpenTask[]
  approvals: readonly Decision[]
  /** False when Divo cannot see this person's Lark at all. */
  reachable: boolean
  limit?: number
  /** True until both reads behind the band have answered. */
  loading?: boolean
  onStartTask: (task: OpenTask) => void
  onOpenApproval: (approval: Decision) => void
  /** Injected by the tests that pin a clock; the app never passes it. */
  now?: Date
}) {
  /* The band held the page open with nothing in it while both reads were out,
     then appeared under whatever the reader was looking at. It has a size
     before it has contents now — and it still leaves entirely when the answer
     turns out to be "nothing", which is one settle rather than a jump. */
  if (loading) return <Loading />

  /* Counted before the cut, so the header does not quietly agree with the
     limit and under-report the day. */
  const all = upNext(tasks, approvals, Number.MAX_SAFE_INTEGER, now)
  const shown = all.slice(0, limit)
  const late = lateCount(all)

  /* Nothing when there is nothing, and nothing when Divo cannot see. Somebody
     with no Lark linked is not missing a feature they asked for, and an offer
     to connect belongs on the Connected panel that already makes it. */
  if (shown.length === 0) return null

  return (
    <section className="mb-6">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-medium leading-tight tracking-[-0.01em] text-ink">
            Up next
          </h2>
          <p className="mt-1 text-[12.5px] leading-tight text-ink-3">
            {/* Says where the rows came from, because two sources land in one
                list and a reader who sees an approval here should not have to
                guess whether Lark sent it. */}
            {reachable ? 'Approvals and Lark tasks waiting on you' : 'Approvals waiting on you'}
          </p>
        </div>
        {late > 0 ? (
          <span
            className="shrink-0 rounded-chip px-2 py-1 text-[11px] font-medium leading-none
                       tabular-nums text-[var(--bui-red)]"
            style={{ background: 'var(--bui-red-tint)' }}
          >
            {late} late
          </span>
        ) : null}
      </div>

      <div className="overflow-hidden rounded-card bg-surface shadow-card">
        {shown.map((item) => (
          <Row
            key={item.id}
            item={item}
            onPick={(picked) => {
              if (picked.approval) onOpenApproval(picked.approval)
              else if (picked.task) onStartTask(picked.task)
            }}
          />
        ))}
      </div>

      {/* Says the list was cut, and by how much. A band that silently shows six
          of eleven reads as "eleven is all there is". */}
      {all.length > shown.length ? (
        <p className="mt-2 text-[12px] text-ink-3">
          {all.length - shown.length} more waiting
        </p>
      ) : null}
    </section>
  )
}
