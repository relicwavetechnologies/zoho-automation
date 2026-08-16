/**
 * "Made for you" — the documents Divo wrote, small enough to glance at.
 *
 * A card is mostly its thumbnail, and the thumbnail is the document's own
 * opening lines at a size you cannot read. That is the intent: what a person
 * recognises across four cards is the *shape* of a document — a heading and
 * three paragraphs, a list, a table — long before they read one. An icon and a
 * date would have made four cards that look identical, which is the same
 * problem the row of Start buttons had on the band above.
 *
 * Clicking opens it in the panel beside the page rather than navigating. The
 * document came out of a chat, but it does not belong to it: sending somebody
 * to a week-old conversation to read a file is making them visit the machine
 * that made the thing.
 *
 * Utilities against `--bui-*` rather than `workspace.css`, for the reason
 * `upnext.view.tsx` gives — nothing here shares a stylesheet with anything, so
 * it lands beside somebody else's rewrite of the page it sits on.
 */
import { Code2, FileText } from 'lucide-react'
import { useMade, type MadeItem } from './made'
import { ago } from '../decisions/decision'

function Card({ item, onOpen }: { item: MadeItem; onOpen: (item: MadeItem) => void }) {
  const Mark = item.mime === 'text/html' ? Code2 : FileText

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      /* Capped rather than left to the track. A person with one document would
         otherwise get a single card the full width of the page, which reads as
         a banner about a document rather than as one of a set. */
      className="group flex max-w-[300px] flex-col gap-2 rounded-[18px] bg-surface p-2
                 text-left shadow-card transition-[transform,box-shadow]
                 hover:-translate-y-[1px] focus-visible:-translate-y-[1px]"
    >
      {/*
        The page, at a distance.

        Real text at a size nobody reads, faded out at the foot rather than cut,
        so the thumbnail reads as a document continuing past the edge of the
        card instead of one that stops mid-sentence. `select-none` and
        `aria-hidden` because this is a picture of the file: a screen reader
        should hear the title once, not the first fifty words of the body.
      */}
      <span
        aria-hidden
        className="relative block h-[96px] select-none overflow-hidden rounded-[13px]
                   bg-canvas px-3 pt-3 shadow-hairline"
      >
        {item.lines.length > 0 ? (
          <span
            className="block [mask-image:linear-gradient(to_bottom,#000_54%,transparent)]"
          >
            {item.lines.map((line, index) => (
              <span
                key={index}
                className={`block truncate ${
                  index === 0
                    ? 'text-[8px] font-semibold leading-[1.5] text-ink'
                    : 'text-[7px] leading-[1.9] text-ink-3'
                }`}
              >
                {line}
              </span>
            ))}
          </span>
        ) : (
          // A document with nothing to show is still a document. An empty box
          // would read as one that failed to load.
          <span className="flex h-full items-center justify-center pb-3 text-ink-3">
            <Mark size={20} />
          </span>
        )}
      </span>

      <span className="flex min-w-0 flex-col gap-0.5 px-1 pb-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <Mark size={12} className="shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium leading-tight text-ink">
            {item.title}
          </span>
        </span>
        <span className="truncate text-[11.5px] leading-tight text-ink-3">
          {/* The version is only worth saying once there is one to say. "v1" on
              every card is a column of ones. */}
          {item.kind}{item.revised ? ` · v${item.version}` : ''} · {ago(item.updatedAt)}
        </span>
      </span>
    </button>
  )
}

/** The card's own geometry, empty. Same box, same thumbnail, same two lines. */
function CardSkeleton({ seed }: { seed: number }) {
  return (
    <div className="flex max-w-[300px] flex-col gap-2 rounded-[18px] bg-surface p-2 shadow-card">
      <span className="block h-[96px] rounded-[13px] bg-canvas shadow-hairline" />
      <span className="flex flex-col gap-0.5 px-1 pb-0.5">
        <span
          className="block h-[15px] animate-pulse rounded-full bg-fill"
          style={{ width: `${52 + ((seed * 13) % 26)}%` }}
        />
        <span className="block h-[14px] w-[42%] animate-pulse rounded-full bg-fill" />
      </span>
    </div>
  )
}

export function Made({ limit = 4, onOpen }: {
  limit?: number
  onOpen: (item: MadeItem) => void
}) {
  const { items, loading } = useMade(limit)

  /* Nothing at all when there is none — the page's rule. A workspace where Divo
     has not written anything yet does not need a card explaining what an
     artifact would be. While the read is out the band shows its own shape
     instead, so the page below it does not move when the documents land. */
  if (!loading && items.length === 0) return null

  return (
    <section className="mb-6" {...(loading ? { 'aria-busy': 'true' as const } : {})}>
      <div className="mb-3">
        <h2 className="text-[15px] font-medium leading-tight tracking-[-0.01em] text-ink">
          Made for you
        </h2>
        <p className="mt-1 text-[12.5px] leading-tight text-ink-3">
          Documents from your chats — open one to read it here
        </p>
      </div>

      {/* `auto-fit`, so four documents fill the row rather than sitting beside
          an empty fifth track — the cards' own width cap is what stops one
          document becoming a poster. */}
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(184px,1fr))]">
        {loading
          /* As many as were asked for. The row is the right width from the
             first frame that way, so the cards land in place rather than the
             grid re-dividing itself under them. */
          ? Array.from({ length: limit }, (_, i) => <CardSkeleton key={i} seed={i} />)
          : items.map((item) => <Card key={item.artifactId} item={item} onOpen={onOpen} />)}
      </div>
    </section>
  )
}
