/**
 * Home — the composer-first landing.
 *
 * Two halves with different rules.
 *
 * The top half is NEW and deliberately inert: a composer and an onboarding
 * carousel. The composer does not send anything. Chat, runs and the work log
 * are being ported from the desktop separately, and wiring a send button here
 * first would mean inventing a second way to start a run that then has to be
 * unpicked. It says so on the control rather than accepting text and dropping
 * it — a box that swallows a sentence in silence is worse than one that admits
 * it is not ready.
 *
 * The bottom half is the OLD `YouHome`, unchanged in what it reads. Same four
 * hooks, same fields, same empty and error states. This screen is a re-skin,
 * not a rewrite, and the panels that were already telling the truth keep
 * telling it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, ArrowUpRight, Check, ChevronLeft, ChevronRight, Link2, Lock, MessageSquare,
  Plus, Sparkles, X,
} from 'lucide-react'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { ago, expiryLabel, useApprovals } from './data/use-approvals'
import { useMyRuns, useMyUsage, changePct, durationLabel } from './data/use-my-activity'
import { useConnections, CONNECTABLE } from './data/use-connections'
import type { MyRun } from './data/use-my-activity'
import type { Provider } from './fixtures'
import {
  ClickRow, Empty, Fade, Heatmap, Panel, ProviderMark, Skel, SkelRows,
  money, providerName, useStaged, type Toast,
} from './ui'

type ScreenProps = {
  persona: 'member' | 'manager' | 'admin'
  replay: number
  toast: Toast
  go: (screen: string) => void
}

/* ── Get started ──────────────────────────────────────
   Cards are generated from what is NOT connected, never hardcoded, so the row
   empties itself as somebody finishes onboarding rather than nagging forever.

   Order is deliberate. Lark comes first because it is how Divo reaches you at
   all; a person with everything else connected and no Lark has an agent that
   cannot start a conversation with them. */
const CARD_ORDER: Provider[] = ['lark', 'google_workspace', 'zoho', 'canva', 'airtable', 'aitable']

const PITCH: Record<Provider, string> = {
  lark: 'Link Lark so Divo can reach you in chat, and so messages from you resolve to this account.',
  google_workspace: 'Mail, Drive, Calendar and Sheets — the widest set of things Divo can do on your behalf.',
  zoho: 'Books and CRM, so Divo can read invoices, bills and customer records for you.',
  canva: 'Let Divo open and build on your Canva designs instead of describing them back to you.',
  airtable: 'Give Divo your bases so it can look things up and keep records current.',
  aitable: 'Connect AITable with a key so Divo can read and update your tables.',
}

const DISMISSED_KEY = 'divo.home.dismissed'

/** Cards the reader has closed. Kept locally — nothing on the backend stores this. */
function useDismissed() {
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      const raw = window.localStorage.getItem(DISMISSED_KEY)
      return raw ? (JSON.parse(raw) as string[]) : []
    } catch {
      return []
    }
  })
  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      if (prev.includes(id)) return prev
      const next = [...prev, id]
      try { window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)) } catch { /* private mode */ }
      return next
    })
  }, [])
  return { dismissed, dismiss }
}

type StartCard = {
  id: string
  mark: string
  title: string
  body: string
  cta: string
  featured?: boolean
  onClick: () => void
}

/** Scrolls the carousel by one card, and knows when it has run out of them. */
function useCarousel(count: number) {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [edge, setEdge] = useState<{ start: boolean; end: boolean }>({ start: true, end: true })

  const measure = useCallback(() => {
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setEdge({ start: el.scrollLeft <= 1, end: el.scrollLeft >= max - 1 })
  }, [el])

  useEffect(() => { measure() }, [measure, count])

  const page = (dir: -1 | 1) => {
    if (!el) return
    // One card plus its gap, read off the DOM rather than hardcoded, so the
    // arrows keep landing on a card edge if the card width ever changes.
    const card = el.firstElementChild as HTMLElement | null
    const step = card ? card.offsetWidth + 14 : el.clientWidth
    el.scrollBy({ left: dir * step, behavior: 'smooth' })
  }

  return { setEl, edge, measure, page }
}

export function WorkspaceHome({ persona, replay, toast, go }: ScreenProps) {
  const [r1, r2, r3] = useStaged([260, 520, 800], replay)
  const { session } = useAdminAuth()
  const { awaitingMe, requestedByMe, loading: approvalsLoading } = useApprovals()
  const { usage, loading: usageLoading } = useMyUsage(30)
  const { runs, loading: runsLoading } = useMyRuns(6)
  const { byProvider, loading: connectionsLoading } = useConnections()
  const { dismissed, dismiss } = useDismissed()

  // First name only. "Welcome back, Ananya Mehta" is a form letter; the
  // surname adds nothing the person does not already know about themselves.
  const viewer = (session?.name ?? session?.email ?? 'there').split(/[\s@]/)[0]
  const runChange = changePct(usage.runs, usage.previousRuns)

  const connected = CONNECTABLE
    .map((provider) => ({ provider, status: byProvider.get(provider) }))
    .filter((entry) => entry.status?.connected)

  const cards = useMemo<StartCard[]>(() => {
    const unconnected = CARD_ORDER.filter((p) => CONNECTABLE.includes(p) && !byProvider.get(p)?.connected)
    const list: StartCard[] = []

    // The featured card. Retires itself once there is nothing left to set up,
    // so a settled workspace does not open on a welcome mat every morning.
    if (unconnected.length > 0) {
      list.push({
        id: 'welcome',
        mark: '👋',
        title: `Welcome, ${viewer}!`,
        body: 'Divo works through the accounts you connect to it. Start here and see exactly what it may do on your behalf.',
        cta: 'What Divo can do',
        featured: true,
        onClick: () => go('access'),
      })
    }

    for (const provider of unconnected) {
      list.push({
        id: `connect:${provider}`,
        mark: providerName(provider).slice(0, 1),
        title: `Connect ${providerName(provider)}`,
        body: PITCH[provider],
        cta: `Connect ${providerName(provider)}`,
        onClick: () => go('connections'),
      })
    }

    // Only for somebody who can actually invite. Offering it to a member sends
    // them to a page that will refuse them.
    if (persona === 'admin') {
      list.push({
        id: 'invite',
        mark: '+',
        title: 'Invite teammates',
        body: 'Bring your team in so Divo works across the company rather than only for you.',
        cta: 'Invite teammates',
        onClick: () => go('co-people'),
      })
    }

    return list.filter((c) => !dismissed.includes(c.id))
  }, [byProvider, dismissed, go, persona, viewer])

  const carousel = useCarousel(cards.length)

  const attention = [
    ...awaitingMe.map((a) => {
      const expiry = expiryLabel(a.expiresAt)
      return {
        tone: 'act' as const,
        title: a.description?.summary ?? `${a.toolId} · ${a.action}`,
        body: a.description?.detail ?? '',
        meta: [`${a.requestedByName} · ${ago(a.requestedAt)}`, expiry ? `Expires ${expiry.text}` : 'No deadline'],
        cta: 'Review',
        onClick: () => go('approvals'),
      }
    }),
    ...requestedByMe
      .filter((a) => expiryLabel(a.expiresAt)?.expired && a.status === 'pending')
      .map((a) => ({
        tone: 'warn' as const,
        title: 'One of your requests expired unanswered',
        body: `${a.description?.summary ?? a.toolId} was never approved, so Divo stopped and did nothing.`,
        meta: [ago(a.requestedAt)],
        cta: 'Ask again',
        // Nothing happens when this is pressed, so it must not arrive as a
        // green tick — the button's whole answer is that it cannot help.
        onClick: () => toast('Ask in Lark or raise it with your manager — Divo cannot re-open an expired request.', 'error'),
      })),
  ]

  return (
    <div className="ws-home">
      <Composer />

      {cards.length > 0 ? (
        <section className="ws-band">
          <div className="ws-band-hd">
            <div>
              <h2>Get started</h2>
              <p>Divo can only act through the accounts you connect to it</p>
            </div>
            <div className="ws-band-act">
              <button
                type="button" className="ws-band-nav" aria-label="Previous"
                disabled={carousel.edge.start} onClick={() => carousel.page(-1)}
              >
                <ChevronLeft size={15} />
              </button>
              <button
                type="button" className="ws-band-nav" aria-label="Next"
                disabled={carousel.edge.end} onClick={() => carousel.page(1)}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>

          {!r1 || connectionsLoading ? (
            <div className="ws-gs">
              {[0, 1, 2].map((i) => (
                <div className="ws-gs-card" key={i}>
                  <Skel w={30} h={30} />
                  <div style={{ height: 12 }} />
                  <Skel w="62%" h={13} />
                  <div style={{ height: 9 }} />
                  <Skel w="100%" h={40} />
                  <div style={{ height: 14 }} />
                  <Skel w="100%" h={34} />
                </div>
              ))}
            </div>
          ) : (
            <div className="ws-gs" ref={carousel.setEl} onScroll={carousel.measure}>
              {cards.map((card) => (
                <article className="ws-gs-card" data-featured={card.featured ? 'true' : undefined} key={card.id}>
                  <button
                    type="button" className="ws-gs-x" aria-label={`Dismiss ${card.title}`}
                    onClick={() => dismiss(card.id)}
                  >
                    <X size={13} />
                  </button>
                  <span className="ws-gs-mark" aria-hidden>{card.mark}</span>
                  <h3>{card.title}</h3>
                  <p>{card.body}</p>
                  <button
                    type="button"
                    className={`btn wide ${card.featured ? 'accent' : 'primary'}`}
                    onClick={card.onClick}
                  >
                    {card.cta}
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      <section className="ws-band">
        <Panel
          title="Needs you"
          description={attention.length ? `${attention.length} item${attention.length > 1 ? 's' : ''} waiting` : undefined}
        >
          {!r1 || approvalsLoading ? <SkelRows n={2} icon={false} /> : attention.length === 0 ? (
            <Empty icon={Check} title="Nothing is waiting" body="Approvals and blocked work will show up here." />
          ) : (
            <Fade>
              <div className="ws-attn">
                {attention.map((a, i) => (
                  <div className="ws-attn-item" data-tone={a.tone} key={i}>
                    <span className="ws-attn-bar" />
                    <div className="ws-attn-main">
                      <b>{a.title}</b>
                      <p>{a.body}</p>
                      <div className="ws-attn-meta">{a.meta.map((m) => <span key={m}>{m}</span>)}</div>
                    </div>
                    <button type="button" className="btn" onClick={a.onClick}>{a.cta}</button>
                  </div>
                ))}
              </div>
            </Fade>
          )}
        </Panel>
      </section>

      <section className="ws-band">
        <div className="ws-band-hd">
          <div>
            <h2>Recent work</h2>
            <p>What Divo has been doing for you</p>
          </div>
          <div className="ws-band-act">
            <button type="button" className="btn" onClick={() => go('usage')}>All activity</button>
          </div>
        </div>
        <Panel source="myRuns">
          {!r3 || runsLoading ? <SkelRows n={4} icon={false} /> : runs.length === 0 ? (
            <Empty icon={Activity} title="Nothing yet" body="Runs appear here once you ask Divo to do something." />
          ) : (
            <Fade><RunList runs={runs} /></Fade>
          )}
        </Panel>
      </section>

      <section className="ws-band">
        <div className="ws-cols">
          <Panel
            title="Your last 30 days"
            source="myUsage"
            aside={<button type="button" className="btn" onClick={() => go('usage')}>Details</button>}
          >
            <div className="ws-panel-body">
              {!r2 || usageLoading ? (
                <>
                  <div style={{ display: 'flex', gap: 40 }}>
                    <div><Skel w={60} h={9} /><div style={{ height: 10 }} /><Skel w={90} h={26} /></div>
                    <div><Skel w={60} h={9} /><div style={{ height: 10 }} /><Skel w={90} h={26} /></div>
                  </div>
                  <div style={{ height: 20 }} />
                  <Skel w="100%" h={46} />
                </>
              ) : (
                <Fade>
                  <div style={{ display: 'flex', gap: 44, flexWrap: 'wrap' }}>
                    <div>
                      <div className="ws-lbl">Tasks run</div>
                      <div className="ws-num" style={{ marginTop: 8 }}>{usage.runs}</div>
                      <div className="ws-sub" style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 5 }}>
                        {runChange >= 0 ? <ArrowUpRight size={13} style={{ color: 'var(--cur-success)' }} /> : null}
                        {runChange >= 0 ? '+' : '−'}{Math.abs(runChange)}% vs the month before
                      </div>
                    </div>
                    <div>
                      <div className="ws-lbl">Cost</div>
                      <div className="ws-num" style={{ marginTop: 8, color: 'var(--cur-primary)' }}>{money(usage.spendUsd)}</div>
                      <div className="ws-sub" style={{ marginTop: 5 }}>{money(usage.spendTodayUsd)} today</div>
                    </div>
                  </div>
                  <div style={{ marginTop: 22 }}><Heatmap data={usage.series.map((p) => ({ date: p.date, value: p.spendUsd }))} /></div>
                </Fade>
              )}
            </div>
          </Panel>

          <Panel title="Connected" aside={<button type="button" className="btn" onClick={() => go('connections')}>Manage</button>}>
            {!r2 || connectionsLoading ? <SkelRows n={3} /> : connected.length === 0 ? (
              <Empty icon={Link2} title="Nothing connected yet" body="Divo can only act through accounts you connect." />
            ) : (
              <Fade>
                <div className="ws-rows">
                  {connected.map(({ provider, status }) => {
                    const first = status!.connections[0]
                    return (
                      <div className="ws-row" key={provider}>
                        <ProviderMark provider={provider} />
                        <div className="ws-row-main">
                          <b>{providerName(provider)}</b>
                          <p>{first?.ownerType === 'company' ? 'Shared by your company' : first?.accountEmail ?? first?.label}</p>
                        </div>
                        <span className="badge b-ok"><span className="dot" />On</span>
                      </div>
                    )
                  })}
                  {CONNECTABLE.length - connected.length > 0 ? (
                    <ClickRow onOpen={() => go('connections')}>
                      <span className="ws-ic"><Plus size={14} /></span>
                      <div className="ws-row-main">
                        <b className="muted" style={{ fontWeight: 400 }}>
                          {CONNECTABLE.length - connected.length} more you can connect
                        </b>
                      </div>
                    </ClickRow>
                  ) : null}
                </div>
              </Fade>
            )}
          </Panel>
        </div>
      </section>
    </div>
  )
}

/**
 * The composer, as a preview of itself.
 *
 * Presentation only, on purpose (see the file header) — and now it says so in
 * the one place somebody is looking.
 *
 * It used to invite you in and then take it back: the box carried
 * "Ask Divo to do something… (@ for an app, / for a skill)", advertising two
 * affordances that do nothing, and a banner underneath explained that none of
 * it works yet. Two elements, overlapping, and the contradiction was between
 * them rather than in either — so the box read as broken and the banner read as
 * an apology for it.
 *
 * The status now lives in the control. The banner is gone, and nothing was lost
 * with it: its "Connect an app" button was the fourth route to the same page on
 * this screen, after the quick action, the Connected panel's Manage, and the
 * "more you can connect" row.
 *
 * Not a textarea any more. A box that takes a caret, accepts characters and
 * drops them is a worse lie than a placeholder — and to a screen reader it was
 * a textbox that does nothing. This is text that looks like a composer, which
 * is exactly what it is.
 */
function Composer() {
  return (
    <div className="ws-comp" data-preview="true">
      <p className="ws-comp-soon">
        <b>Chat is coming to the web.</b> Today Divo answers in Lark and on the
        desktop — everything you connect here works in both.
      </p>
      <div className="ws-comp-foot">
        {/* Kept, disabled: these two are real settings that will travel with
            every message, so they show what is coming rather than decorating. */}
        <button type="button" className="ws-comp-chip" disabled title="Chosen by your admin — see Settings">
          <Sparkles size={13} /> Divo · default
        </button>
        <button type="button" className="ws-comp-chip" disabled title="Set on the Approvals page">
          <Lock size={13} /> Ask me first
        </button>
        <span className="ws-comp-sp" />
        {/* Where send will be. A dead send button on a box that cannot be typed
            in is the same contradiction one size smaller — this states the
            reason there is no button instead of dimming one. */}
        <span className="ws-comp-pill"><MessageSquare size={12} /> Soon</span>
      </div>
    </div>
  )
}

function RunList({ runs }: { runs: MyRun[] }) {
  return (
    <div className="ws-rows">
      {runs.map((r) => {
        const duration = durationLabel(r.durationMs)
        return (
          <div className="ws-row" key={r.id}>
            <div className="ws-row-main">
              <b>
                {r.summary ?? r.entrypoint}
                {r.status === 'running' && r.channel === 'lark' ? (
                  <span className="ws-note" title="Lark runs are never closed by the backend — status and duration are unreliable for this channel.">
                    status unknown
                  </span>
                ) : null}
              </b>
              <p>
                {ago(r.startedAt)} · {r.channel === 'lark' ? 'Lark' : 'Desktop'}
                {duration ? ` · ${duration}` : ''}
                {r.errorMessage ? ` · ${r.errorMessage}` : ''}
              </p>
            </div>
            <div className="ws-row-act">
              {/* Zero means nothing was attributed to this run, not that it was
                  free — so it reads as a dash rather than an exact $0.00. */}
              <span className="ws-sub">{r.costUsd > 0 ? money(r.costUsd) : '—'}</span>
              {r.status === 'failed' ? <span className="badge b-err"><span className="dot" />Failed</span> : null}
              {r.status === 'completed' ? <span className="badge b-ok"><span className="dot" />Done</span> : null}
              {r.status === 'running' ? <span className="badge b-run"><span className="dot" />Running</span> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
