/**
 * One row of the work log.
 *
 * The governing rule, and the one thing that makes this read like the desktop
 * work log rather than a status page: **a step is expanded while it is running
 * and folds to a single sentence once it settles.** Detail is offered at the
 * moment it is being produced and withdrawn the moment it stops being news —
 * so a finished ten-step run is ten quiet lines, and the one step still working
 * is the only thing with any weight on the screen.
 *
 * Everything else follows from that. No progress bars, no spinner parked in a
 * corner, no badge that says "running". The live row simply looks alive and
 * the settled ones do not.
 */
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { ToolMark, tool } from './tools'
import type { Beat } from './beats'

/* ── Step ─────────────────────────────────────────────────
   Two states, one shape. Live: open, the label shimmering, the chip carrying
   what the call is aimed at. Settled: one line, foldable back open by anyone
   who wants the detail. Both carry the vendor mark, in the same slot at the
   same size — it is how the row is identified at a glance, and identity should
   not depend on whether the work has finished yet.

   A step used to stream a list of detail lines while it ran, which is why the
   fold exists at all. Nothing has produced one since the surface started
   reading a real run: the only tool that reports work underneath itself is the
   one that spawns agents, and those get drawn as agents. What is left in the
   fold is the call's own target and the app it belongs to. */

export function Step({
  beat, live,
}: {
  beat: Extract<Beat, { t: 'step' }>
  live: boolean
}) {
  /* `null` means "follow the run" — open while live, folded once settled. A
     click pins it either way, and the pin survives the step settling, because
     someone who opened a row to read it should not have it shut in their face. */
  const [pinned, setPinned] = useState<boolean | null>(null)
  const open = pinned ?? live
  const meta = tool(beat.tool)

  return (
    <div style={{ animation: 'bui-fade-up 320ms cubic-bezier(0.23,1,0.32,1) both' }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setPinned(!open)}
        className="group flex w-full items-center gap-2.5 py-0.5 text-left text-[13px] text-ink-2 transition-colors duration-100 hover:text-ink"
      >
        {/* A running step keeps its own mark rather than turning into a
            spinner. The spinner was on screen at exactly the moment somebody is
            watching the log, so the one thing they could not see was which
            system Divo was in — the marks only appeared once the work was over
            and the answer had made them redundant. The desktop settled this the
            same way: a running Gmail call should look like Gmail.

            The label carries "in flight" instead, so the row keeps its shape
            when it settles and only the shimmer falls away. Swapping the glyph
            made every step twitch sideways as it finished.

            Held back while settled and full while running, so the mark of the
            call actually in flight is the brightest thing in the log. */}
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          <ToolMark name={beat.tool} size={14} dim={!live} />
        </span>

        {/* The shimmer is a class on the row's own label rather than the
            `Shimmer` component, which carries its own type size — borrowing it
            here would resize the title as the step settled, which is the twitch
            the mark was just stopped from causing.

            No colour of its own: the row owns the weight, so hovering brightens
            label and detail together instead of half the line. */}
        <span className={`shrink-0 ${live ? 'bui-shimmer' : ''}`}>
          {beat.title}
        </span>

        {/* Live: the chip carries the real target — the query, the file, the
            sheet name. Settled: the chip gives way to the one-line result,
            because what it did now matters more than what it was aimed at.

            Both sit a weight below the label and are never title-cased: a query,
            a path or a command is verbatim, and tidying it corrupts what it
            says. */}
        <span className="min-w-0 truncate text-ink-3 transition-colors duration-100 group-hover:text-ink-2">
          {live ? beat.chip : beat.done}
        </span>

        {/* Trails, and only on hover. Drawn at rest on every row it made the log
            a column of chevrons — structure to decode rather than read — and the
            marks it competed with are the thing worth seeing. A running row has
            none at all: it is already open, and there is nothing to offer. */}
        {!live && (
          <ChevronRight
            size={13}
            className={`shrink-0 text-ink-3 opacity-0 transition-all duration-150 group-hover:opacity-100 ${open ? 'rotate-90 opacity-100' : ''}`}
          />
        )}
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? '1fr' : '0fr',
          opacity: open ? 1 : 0,
          transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-0.5 mb-1 ml-[7px] flex flex-col gap-0.5 border-l border-line py-0.5 pl-4">
            {/* Once settled the chip has left the header, so it reappears here
                — the query is still the most useful thing in the detail. */}
            {!live && beat.chip && (
              <span className="mb-0.5 text-[11.5px] text-ink-3">{beat.chip}</span>
            )}
            {/* The app's name, in text. The mark is already on the row header
                two lines up — repeating it here was the logo showing up twice
                inside one step for no added information. */}
            <span className="mt-1 text-[11px] text-ink-3">{meta.app}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
