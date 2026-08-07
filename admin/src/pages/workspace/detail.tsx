/**
 * The detail-page shell: header, a main body, and an inspector rail.
 *
 * Divo's detail screens are stacked full-width panels — a person's page runs to
 * five of them and you scroll a long way to learn a little. This is the other
 * arrangement: the thing itself fills the body, and everything *about* it sits
 * in a rail on the right as `label → control` rows, grouped into sections you
 * can fold away.
 *
 * Written to be reused. Automations is the first screen on it; person,
 * department and run detail are the obvious next ones.
 */
import { useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronDown } from 'lucide-react'

export function DetailPage({
  onBack, title, badge, meta, actions, children, rail,
}: {
  onBack?: () => void
  title: ReactNode
  /** A status pill beside the title. */
  badge?: ReactNode
  /** Quiet text on the right of the header — "Edited 6 minutes ago". */
  meta?: ReactNode
  actions?: ReactNode
  children: ReactNode
  rail: ReactNode
}) {
  return (
    <div className="dt">
      <header className="dt-hd">
        {onBack ? (
          <button type="button" className="dt-back" onClick={onBack} aria-label="Back">
            <ArrowLeft size={15} />
          </button>
        ) : null}
        <h1>{title}</h1>
        {badge}
        <div className="dt-hd-r">
          {meta ? <span className="dt-meta">{meta}</span> : null}
          {actions}
        </div>
      </header>

      <div className="dt-split">
        <div className="dt-main">{children}</div>
        <aside className="dt-rail">{rail}</aside>
      </div>
    </div>
  )
}

/**
 * A foldable group in the rail.
 *
 * Open by default: a rail that greets you closed is a rail you have to click
 * four times before it tells you anything. `defaultOpen={false}` is for the
 * sections that are usually empty.
 */
export function RailSection({
  title, aside, defaultOpen = true, children,
}: { title: string; aside?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className="dt-sec">
      <div className="dt-sec-hd">
        <button type="button" className="dt-sec-t" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <ChevronDown size={14} className={open ? 'dt-chev open' : 'dt-chev'} />
          {title}
        </button>
        {aside}
      </div>
      {open ? <div className="dt-sec-b">{children}</div> : null}
    </section>
  )
}

/** One `label → value` line in a rail section. */
export function RailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dt-row">
      <span className="dt-row-l">{label}</span>
      <span className="dt-row-v">{children}</span>
    </div>
  )
}

/**
 * The rail's read-only value treatment — a chip, matching the reference.
 *
 * `tone="plain"` drops the chip for values that are prose rather than a
 * setting; a paragraph inside a pill reads as something you can press.
 */
export function RailChip({ children, tone }: { children: ReactNode; tone?: 'plain' }) {
  return <span className="dt-chip" data-tone={tone}>{children}</span>
}

/** What a rail section says when it has nothing to list. */
export const RailEmpty = ({ children }: { children: ReactNode }) => (
  <p className="dt-empty">{children}</p>
)
