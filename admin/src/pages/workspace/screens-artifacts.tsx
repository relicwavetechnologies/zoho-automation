/**
 * Artifacts — the thing Divo makes while you chat, and somewhere to look at it.
 *
 * ── Where this stands today ────────────────────────────
 * Artifacts are real now, and this page has not caught up with them.
 *
 * A web run can write a document and file it: `divo-artifact` is loaded for the
 * web channel only (runtime.mjs `scopedManifest`), the tool lifts the body out
 * of the container into the `Artifact` table, and the panel beside the chat
 * renders it — `artifacts/panel.tsx`. `GET /api/artifacts` lists a
 * member's own, which is exactly the list this page wants.
 *
 * What this page still shows that does not exist:
 *
 *   · Kinds. A deck, a to-do and a research brief are all markdown; nothing
 *     classifies them, and `mimeFromPath()` still accepts markdown only.
 *   · Sharing, owners and grants. An artifact belongs to one member and there
 *     is no way to give it to a second one.
 *   · Version history. The store counts revisions but keeps only the newest, so
 *     there is nothing to browse back through.
 *
 * Each of those is marked in the UI with a `DataNote` rather than left to be
 * discovered, and the list itself is the part worth wiring first.
 */
import { useEffect, useState } from 'react'
import {
  ArrowLeft, Check, Clock, Code2, Download, ExternalLink, Eye, FileText, Globe, Layers,
  Link2, ListChecks, Lock, MessageSquare, Pencil, Share2, ShieldCheck, Sparkles, TriangleAlert, Users,
} from 'lucide-react'
import { DataNote, Empty, Fade, PageHeader, Panel, Seg, SkelRows, useStaged } from './ui'
import type { Toast } from './ui'

type Props = { replay: number; toast: Toast; go: (s: string) => void }

type ArtifactKind = 'deck' | 'todo' | 'research' | 'doc'

type Artifact = {
  id: string
  title: string
  kind: ArtifactKind
  /** The real file the agent wrote. Artifacts are ordinary workspace files. */
  file: string
  madeBy: string
  madeIn: 'lark' | 'desktop'
  when: string
  shared: string | null
  live?: boolean
}

const ARTIFACTS: Artifact[] = [
  {
    id: 'a_deck', title: 'Acme × Northwind — pitch', kind: 'deck', file: 'artifacts/northwind-pitch.html',
    madeBy: 'Ananya', madeIn: 'lark', when: 'Updating now', shared: 'Finance · 6 people', live: true,
  },
  {
    id: 'a_todo', title: 'Quarter close checklist', kind: 'todo', file: 'artifacts/quarter-close.todo.json',
    madeBy: 'Ananya', madeIn: 'lark', when: '2 hours ago', shared: null,
  },
  {
    id: 'a_res', title: 'Vendor pricing — what I found', kind: 'research', file: 'artifacts/vendor-pricing.md',
    madeBy: 'Ananya', madeIn: 'desktop', when: 'Yesterday', shared: 'Link · anyone at Acme',
  },
  {
    id: 'a_doc', title: 'March reconciliation notes', kind: 'doc', file: 'artifacts/march-recon.md',
    madeBy: 'Ananya', madeIn: 'lark', when: '3 days ago', shared: null,
  },
]

const KIND_META: Record<ArtifactKind, { icon: typeof FileText; label: string }> = {
  deck: { icon: Layers, label: 'Deck · HTML' },
  todo: { icon: ListChecks, label: 'Checklist' },
  research: { icon: Globe, label: 'Research' },
  doc: { icon: FileText, label: 'Document' },
}

/* ══ List ══════════════════════════════════════════════ */
export function Artifacts({ replay, toast }: Props) {
  const [r1] = useStaged([300], replay)
  const [open, setOpen] = useState<string | null>(null)

  if (open) {
    const artifact = ARTIFACTS.find((a) => a.id === open)!
    return <ArtifactViewer artifact={artifact} onBack={() => setOpen(null)} toast={toast} />
  }

  return (
    <>
      <PageHeader
        eyebrow="Your workspace"
        title="Things Divo made"
        /*
         * Said once, at the top, rather than left to be inferred from the
         * "Needs backend" note further down. Everything on this page is a
         * picture of a screen that does not exist yet, and a reader who works
         * that out only after clicking a card has been misled by us.
         */
        badge={<span className="ws-soon">Coming soon</span>}
        description="Decks, checklists and research Divo produced while working with you. Each one is a real file it can keep editing."
      />
      <div className="ws-stack">
        <Panel>
          <div className="ws-panel-body">
            {!r1 ? <SkelRows n={2} /> : (
              <Fade>
                <div className="ws-art-grid">
                  {ARTIFACTS.map((a) => {
                    const Icon = KIND_META[a.kind].icon
                    return (
                      // A <button> may only contain phrasing content, and this
                      // card is a thumbnail over a title and a caption. Same
                      // pattern the skills tree uses: a div that announces
                      // itself as a button and answers both Enter and Space,
                      // which is what a real button does.
                      <div
                        role="button"
                        tabIndex={0}
                        className="ws-art-card"
                        key={a.id}
                        onClick={() => setOpen(a.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(a.id) }
                        }}
                      >
                        <div className="ws-art-thumb" data-kind={a.kind}>
                          {a.kind === 'deck' ? <DeckThumb /> : <Icon size={26} />}
                          {a.live ? (
                            <span className="ws-art-live"><span className="ws-live-dot" />Divo is editing</span>
                          ) : null}
                        </div>
                        <div className="ws-art-meta">
                          <b>{a.title}</b>
                          <p>
                            {KIND_META[a.kind].label} · {a.when}
                            {a.shared ? ` · ${a.shared}` : ' · only you'}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </Fade>
            )}
          </div>
          <div className="ws-panel-foot">
            <DataNote source="artifacts" />
            Artifacts are real in chat — this list is not yet reading them
          </div>
        </Panel>

        <Panel title="Where this stands" description="What a document can already do, and what this page still shows that it cannot">
          <div className="ws-rows">
            <Step
              n="1"
              title="Divo writes a file and shows it beside the chat"
              body="The model writes an ordinary markdown file, then badges it. The badge lifts the body out of the container and files it against you, so it outlives the run — and the panel next to the conversation renders it."
              state="live"
            />
            <Step
              n="2"
              title="Revising a document updates it in place"
              body="A second badge on the same file is the same document, one version later. The tab refreshes rather than a second one appearing."
              state="live"
            />
            <Step
              n="3"
              title="This list, reading the real ones"
              body="Every document you own is already listed by the artifacts route. This page is still showing four fixtures instead of calling it."
              state="small"
            />
            <Step
              n="4"
              title="Anything other than markdown"
              body="mimeFromPath() still returns markdown or nothing, so a deck has nowhere to land. Model-written HTML also needs a separate origin before it can be rendered — not a sanitiser."
              state="new"
            />
            <Step
              n="5"
              title="Sharing, and a Lark link"
              body="A document belongs to one person and there is no way to give it to a second. Lark cannot show one at all: its runs are never given the tool, which is what keeps the two surfaces honest."
              state="new"
            />
          </div>
        </Panel>
      </div>
    </>
  )
}

function Step({ n, title, body, state }: { n: string; title: string; body: string; state: 'live' | 'small' | 'new' }) {
  return (
    <div className="ws-row" style={{ alignItems: 'flex-start' }}>
      <span className="ws-ic" data-tone={state === 'live' ? 'ok' : state === 'new' ? 'warn' : undefined}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{n}</span>
      </span>
      <div className="ws-row-main">
        <b>
          {title}
          {state === 'live' ? <span className="badge b-ok"><span className="dot" />Exists</span> : null}
          {state === 'small' ? <span className="ws-tag">Small change</span> : null}
          {state === 'new' ? <span className="ws-note" data-kind="new">Net-new</span> : null}
        </b>
        <p>{body}</p>
      </div>
    </div>
  )
}

const DeckThumb = () => (
  <div style={{ width: '76%', aspectRatio: '16/9', background: '#faf9f6', borderRadius: 4, padding: 10, display: 'flex', flexDirection: 'column', justifyContent: 'center', boxShadow: '0 1px 6px rgba(0,0,0,.14)' }}>
    <div style={{ width: 26, height: 3, borderRadius: 999, background: '#f54e00' }} />
    <div style={{ width: '78%', height: 6, borderRadius: 999, background: '#2b2924', marginTop: 7 }} />
    <div style={{ width: '54%', height: 4, borderRadius: 999, background: '#bdb9b0', marginTop: 5 }} />
    <div style={{ width: '64%', height: 4, borderRadius: 999, background: '#d5d1c8', marginTop: 4 }} />
  </div>
)

/* ══ Viewer ════════════════════════════════════════════
   The screen the whole idea rests on. An artifact is not a download — it is a
   live surface the agent keeps writing to while you watch. */
function ArtifactViewer({ artifact, onBack, toast }: { artifact: Artifact; onBack: () => void; toast: Toast }) {
  const [slide, setSlide] = useState(0)
  const [editing, setEditing] = useState(Boolean(artifact.live))
  const [revision, setRevision] = useState(artifact.live ? 6 : 4)

  // Demonstrates the file-write event: while Divo is editing, the open render
  // advances on its own. No refresh, no re-open.
  useEffect(() => {
    if (!editing) return
    const t = setTimeout(() => { setRevision((r) => r + 1); setEditing(false) }, 5200)
    return () => clearTimeout(t)
  }, [editing])

  const Icon = KIND_META[artifact.kind].icon

  return (
    <>
      <div className="crumbs">
        <button type="button" className="btn" style={{ height: 30, padding: '0 11px' }} onClick={onBack}>
          <ArrowLeft size={13} />Things Divo made
        </button>
      </div>

      <PageHeader
        title={artifact.title}
        description={`${KIND_META[artifact.kind].label} · made by Divo for ${artifact.madeBy} in ${artifact.madeIn === 'lark' ? 'a Lark chat' : 'the desktop app'}`}
        actions={
          <>
            <button type="button" className="btn" onClick={() => toast('Downloaded the file')}><Download size={14} />Download</button>
            <button type="button" className="btn primary" onClick={() => toast('Share settings')}><Share2 size={14} />Share</button>
          </>
        }
      />

      {editing ? (
        <div className="ws-ceiling" style={{ marginBottom: 16, background: 'color-mix(in srgb, var(--cur-primary) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--cur-primary) 28%, transparent)' }}>
          <span style={{ color: 'var(--cur-primary)', display: 'inline-flex', marginTop: 3 }}><span className="ws-live-dot" /></span>
          <div>
            <b>Divo is editing this right now</b> — adding a slide on implementation timeline. This page will update on its
            own; you do not need to refresh.
          </div>
        </div>
      ) : null}

      <div className="ws-view">
        <div className="ws-canvas">
          <div className="ws-canvas-bar">
            <Icon size={13} />
            <span className="mono" style={{ fontSize: 11 }}>{artifact.file}</span>
            <span style={{ flex: 1 }} />
            {artifact.kind === 'deck' ? (
              <span className="ws-tag" title="Agent-written HTML never runs on the dashboard origin. It renders inside a sandboxed frame with no access to your session.">
                <ShieldCheck size={11} />Sandboxed
              </span>
            ) : null}
            <span>v{revision}</span>
          </div>

          <div className="ws-canvas-body">
            {artifact.kind === 'deck' ? <DeckRender slide={slide} onSlide={setSlide} revision={revision} /> : null}
            {artifact.kind === 'todo' ? <TodoRender toast={toast} /> : null}
            {artifact.kind === 'research' ? <ResearchRender /> : null}
            {artifact.kind === 'doc' ? (
              <Empty icon={FileText} title="March reconciliation notes" body="Markdown renders inline. This is the one artifact type the current tool already supports." />
            ) : null}
          </div>
        </div>

        <div className="ws-stack">
          <Panel title="Who can see it">
            <div className="ws-panel-body">
              {artifact.shared ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                    <span className="ws-ic"><Users size={14} /></span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{artifact.shared}</div>
                      <div className="ws-sub" style={{ marginTop: 2 }}>Can view, cannot edit</div>
                    </div>
                  </div>
                  <button type="button" className="btn" style={{ width: '100%' }} onClick={() => toast('Link copied')}>
                    <Link2 size={14} />Copy link
                  </button>
                </>
              ) : (
                <>
                  <div className="ws-private">
                    <Lock size={15} />
                    <div>Only you. Artifacts are private until you share them, the same as skills.</div>
                  </div>
                  <button type="button" className="btn" style={{ width: '100%', marginTop: 12 }} onClick={() => toast('Share with your team')}>
                    <Share2 size={14} />Share
                  </button>
                </>
              )}
            </div>
            <div className="ws-panel-foot"><DataNote source="artifactSharing" /> Needs an owner and grants</div>
          </Panel>

          <Panel title="History" description="Every time Divo touched the file">
            <div className="ws-panel-body">
              <Version now label={`Revision ${revision}`} detail={editing ? 'Writing now' : 'Just now — added the timeline slide'} last={false} />
              <Version label={`Revision ${revision - 1}`} detail="12 minutes ago — rewrote the pricing table" last={false} />
              <Version label={`Revision ${revision - 2}`} detail="28 minutes ago — first draft from your brief" last />
            </div>
            <div className="ws-panel-foot"><DataNote source="artifactHistory" /> Needs versioned storage</div>
          </Panel>

          <Panel title="Where it came from">
            <div className="ws-panel-body">
              <div className="ws-row" style={{ padding: 0 }}>
                <span className="ws-ic"><MessageSquare size={14} /></span>
                <div className="ws-row-main">
                  <b style={{ fontWeight: 400 }}>A Lark chat with Divo</b>
                  <p>"Make me a deck for the Northwind pitch"</p>
                </div>
              </div>
              <button type="button" className="btn" style={{ width: '100%', marginTop: 14 }} onClick={() => toast('Opens the Lark thread')}>
                <ExternalLink size={14} />Open the chat
              </button>
            </div>
          </Panel>
        </div>
      </div>
    </>
  )
}

function Version({ label, detail, now, last }: { label: string; detail: string; now?: boolean; last?: boolean }) {
  return (
    <div className="ws-ver">
      <div className="ws-ver-line">
        <span className="ws-ver-dot" data-now={now} />
        {!last ? <span className="ws-ver-rail" /> : null}
      </div>
      <div style={{ paddingBottom: last ? 0 : 12 }}>
        <b>{label}</b>
        <p>{detail}</p>
      </div>
    </div>
  )
}

/* ── The deck: agent-written HTML, rendered ─────────── */
const SLIDES = [
  {
    eyebrow: 'Acme Technologies',
    title: 'Cutting vendor spend by 18% without changing suppliers',
    body: 'Prepared for Northwind Logistics · March 2026',
    bullets: [],
  },
  {
    eyebrow: 'The problem',
    title: 'You are paying twice for the same freight capacity',
    body: '',
    bullets: [
      'Six overlapping contracts across three regions',
      '₹2.1 crore of duplicated minimum commitments',
      'No single view of what has actually been used',
    ],
  },
  {
    eyebrow: 'What we found',
    title: 'Three contracts carry 71% of the waste',
    body: 'Pulled from your own invoice history — no new data collection needed.',
    bullets: [
      'Sharma Textiles — ₹84 lakh unused commitment',
      'Coastal Freight — overlapping with Northwind Direct',
      'Meridian — auto-renewed twice without review',
    ],
  },
  {
    eyebrow: 'How we get there',
    title: 'Twelve weeks, three checkpoints',
    body: 'Consolidate, renegotiate, then hold the line with monthly review.',
    bullets: [],
  },
]

function DeckRender({ slide, onSlide, revision }: { slide: number; onSlide: (n: number) => void; revision: number }) {
  const available = Math.min(SLIDES.length, revision >= 7 ? 4 : 3)
  const s = SLIDES[Math.min(slide, available - 1)]
  return (
    <>
      <div className="ws-sandbox">
        <div className="ws-slide">
          <div className="eyebrow-s">{s.eyebrow}</div>
          <h3>{s.title}</h3>
          {s.body ? <p>{s.body}</p> : null}
          {s.bullets.length ? <ul>{s.bullets.map((b) => <li key={b}>{b}</li>)}</ul> : null}
        </div>
        <div className="ws-slide-nav">
          {Array.from({ length: available }).map((_, i) => (
            <button
              type="button"
              key={i}
              className="ws-slide-pip"
              data-on={i === Math.min(slide, available - 1)}
              aria-label={`Slide ${i + 1}`}
              onClick={() => onSlide(i)}
            />
          ))}
        </div>
      </div>
      <div className="ws-sub" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 7 }}>
        <Code2 size={12} />
        Raw HTML written by Divo, rendered in a sandboxed frame — it cannot read your session or call out.
      </div>
    </>
  )
}

/* ── Checklist artifact ─────────────────────────────── */
const TODOS = [
  { group: 'Before the 5th', items: [
    { t: 'Reconcile the vendor ledger', d: 'Divo did this — 214 lines matched, 3 flagged', done: true },
    { t: 'Chase the six overdue invoices', d: 'Waiting on your approval to send', done: false },
    { t: 'Close the intercompany transfers', d: '', done: false },
  ] },
  { group: 'Before the board pack', items: [
    { t: 'Sign off the aged-debt sheet', d: 'Priya has drafted it', done: false },
    { t: 'Confirm the FX rate for March', d: '', done: false },
  ] },
]

function TodoRender({ toast }: { toast: Toast }) {
  const [done, setDone] = useState<string[]>(['Reconcile the vendor ledger'])
  return (
    <div className="ws-todo">
      {TODOS.map((g) => (
        <div key={g.group}>
          <div className="ws-todo-grp">{g.group}</div>
          {g.items.map((i) => {
            const isDone = done.includes(i.t)
            return (
              <div className="ws-todo-i" data-done={isDone} key={i.t}>
                <button
                  type="button"
                  className="ws-todo-box"
                  data-done={isDone}
                  aria-label={i.t}
                  onClick={() => {
                    setDone((d) => (d.includes(i.t) ? d.filter((x) => x !== i.t) : [...d, i.t]))
                    toast(isDone ? 'Reopened' : 'Done — Divo has been told')
                  }}
                >
                  <Check size={11} />
                </button>
                <div>
                  <b>{i.t}</b>
                  {i.d ? <p>{i.d}</p> : null}
                </div>
              </div>
            )
          })}
        </div>
      ))}
      <div className="ws-private" style={{ marginTop: 20 }}>
        <Sparkles size={15} />
        <div>Ticking something here tells Divo in the chat too — the artifact and the conversation stay in step.</div>
      </div>
    </div>
  )
}

/* ── Research artifact, with its sources ─────────────── */
const SOURCES = [
  { host: 'northwindlogistics.com', mark: 'N', title: 'Northwind published freight rate card, Q1 2026', snip: 'Base rate per container held flat year on year; fuel surcharge moved from fixed to indexed.' },
  { host: 'sharmatextiles.in', mark: 'S', title: 'Sharma Textiles annual report', snip: 'Confirms the minimum commitment structure and the auto-renewal clause referenced in your contract.' },
  { host: 'freightwaves.com', mark: 'F', title: 'Indian container rates soften into March', snip: 'Spot rates fell 11% quarter on quarter, which is the basis for the renegotiation window below.' },
]

const ResearchRender = () => (
  <>
    <p className="ws-sentence" style={{ marginBottom: 6 }}>
      Three of your six freight contracts overlap on the same lanes, and spot rates have fallen enough that
      renegotiating two of them now is worth roughly <b>₹1.4 crore</b> a year.
    </p>
    <p className="ws-sentence-note">
      The full working is in the file. What follows is where each number came from.
    </p>

    <div className="ws-lbl" style={{ marginTop: 26, marginBottom: 6 }}>Sources</div>
    <div>
      {SOURCES.map((s) => (
        <div className="ws-src" key={s.host}>
          <span className="ws-src-fav">{s.mark}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <b>{s.title}</b>
            <p>{s.snip}</p>
            <span className="host">{s.host}</span>
          </div>
          <ExternalLink size={13} className="muted" style={{ flexShrink: 0, marginTop: 3 }} />
        </div>
      ))}
    </div>
  </>
)
