/**
 * The preview's own furniture: prototype state, annotations, small primitives.
 *
 * Two things live here that the real app has no equivalent of.
 *
 * `PreviewProvider` holds the *mode* — first run, running, something wrong.
 * Every screen reads it rather than owning its own toggle, because the point of
 * the prototype is to walk one person through three versions of the same
 * product without leaving the page they are looking at.
 *
 * `Note` is the annotation. It renders nothing at all when annotations are off,
 * so the screens can be read as a product rather than as a document, and the
 * argument for each decision is one keystroke away rather than in a spec nobody
 * has open. Deliberately inline and in flow — a floating pin has to be
 * positioned, and a positioned pin is wrong the moment the layout moves.
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { Mode } from './data'

type PreviewState = {
  mode: Mode
  setMode: (m: Mode) => void
  notes: boolean
  setNotes: (v: boolean) => void
  /** Whether the member has connected a mailbox yet. Derived, but settable. */
  connected: boolean
  connect: () => void
  /** Whether they have signed in. The sign-in screen sets it. */
  signedIn: boolean
  signIn: () => void
  signOut: () => void
}

const Ctx = createContext<PreviewState | null>(null)

export function PreviewProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>('running')
  const [notes, setNotes] = useState(false)
  const [manualConnect, setManualConnect] = useState(false)
  const [signedIn, setSignedIn] = useState(true)

  const value = useMemo<PreviewState>(() => ({
    mode,
    setMode: (m) => { setMode(m); if (m !== 'first-run') setManualConnect(false) },
    notes,
    setNotes,
    connected: mode === 'first-run' ? manualConnect : true,
    connect: () => setManualConnect(true),
    signedIn,
    signIn: () => setSignedIn(true),
    signOut: () => setSignedIn(false),
  }), [mode, notes, manualConnect, signedIn])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePreview() {
  const v = useContext(Ctx)
  if (!v) throw new Error('usePreview outside PreviewProvider')
  return v
}

/**
 * One annotation.
 *
 * `n` is only for the reader's benefit — they are numbered per screen by hand
 * rather than by a counter, because a counter renumbers everything the moment
 * a note is inserted and the point of the number is that you can say "look at
 * three" out loud.
 */
export function Note({ n, title, children }: { n: number; title?: string; children: ReactNode }) {
  const { notes } = usePreview()
  if (!notes) return null
  return (
    <div className="mp-note">
      <span className="mp-note-n">{n}</span>
      <div>
        {title ? <b>{title}</b> : null}
        <p>{children}</p>
      </div>
    </div>
  )
}

/* The kit used to draw its own stand-in for Divo's mark. It is re-exported
   rather than removed, because the preview screens import it from here and the
   real mark is what they should have been drawing all along. */
export { DivoMark } from '@/components/admin/divo-mark'

/* ── Small shared pieces ─────────────────────────────── */

export const Pill = ({ tone, children }: { tone?: 'ok' | 'held' | 'fail' | 'blocked' | 'ai' | 'quiet'; children: ReactNode }) => (
  <span className="mp-pill" data-tone={tone ?? 'quiet'}>{children}</span>
)

export function SectionHead({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="mp-sec-h">
      <div>
        <h2>{title}</h2>
        {sub ? <p>{sub}</p> : null}
      </div>
      {right ? <div className="mp-sec-r">{right}</div> : null}
    </div>
  )
}

export function Stat({ k, v, s }: { k: string; v: string; s?: string }) {
  return (
    <div className="mp-stat">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
      {s ? <span className="s">{s}</span> : null}
    </div>
  )
}

/** Money, in the currency the member actually thinks in. */
export const inr = (n: number) => `₹${n < 1 ? n.toFixed(2) : n.toLocaleString('en-IN')}`

export const initialsOf = (name: string) =>
  name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')
