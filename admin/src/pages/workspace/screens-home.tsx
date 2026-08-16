/**
 * Home — the composer-first landing.
 *
 * The page is ordered by what a person can do about each thing: what is waiting
 * on them, what they could start, how the work has been going, and what it ran
 * on. Nothing decorative sits above something actionable.
 *
 * **Every band here disappears when it is empty.** A card reading "Nothing is
 * waiting" is a row of pixels charging rent to say nothing — the reader learns
 * the same thing, faster, from its absence. That rule is why `ActionTiles`,
 * `TaskBand` and the charts all return `null` rather than an empty state, and
 * why the page is short on a quiet morning and long on a busy one.
 *
 * **A chart has to earn its half of the row.** The usage card used to hold
 * *Tasks run · Cost · Busiest day* — the page's summary, buried inside a chart —
 * and repeat three more figures under its own calendar. Those figures are the
 * `Performance` row now, and the calendar went with them rather than staying on
 * as a title, a grid and a legend with eleven of sixteen columns empty.
 *
 * The two charts that remain are read as a pair, so they draw into the same box
 * (`CHART_BOX` in `charts.tsx`) rather than each at its own proportions — a
 * cluster at 2:1 beside a field at 3:1 looks like one of them went wrong,
 * whatever either says on its own.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Activity, ArrowUpRight, ChevronLeft, ChevronRight, CircleAlert, Link2, Lock,
  MessageSquare, Plus, Send, Sparkles, X,
} from 'lucide-react'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { Composer as ChatComposer } from './chat/composer'
import { DropVeil, useAttachments, useDropGuard, useFileDrop } from './chat/attach.view'
import { stageHandoff } from './chat/handoff'
import { useChatModelChoice } from './chat/model-choice'
import '@/styles/beautiful.css'
import { ago, expiryLabel, useApprovals } from './data/use-approvals'
import {
  useMyRuns, useMyUsage, changePct, durationLabel, runTitle,
  dayLabel, summarizeSpend, USAGE_DAYS, USAGE_WEEKS,
} from './data/use-my-activity'
import { useConnections, CONNECTABLE } from './data/use-connections'
import { dueLabel, useMyTasks, type OpenTask } from './data/use-my-tasks'
import { DotField, HexShare, hueAt } from './charts'
import type { MyRun } from './data/use-my-activity'
import type { Provider } from './fixtures'
import {
  ClickRow, Empty, Fade, Panel, ProviderMark, Skel, SkelRows,
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
const RUN_CHANNEL_LABEL: Record<string, string> = { lark: 'Lark', desktop: 'Desktop', web: 'Web', api: 'API' }

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
  /** A node, because a provider card carries that app's real mark. */
  mark: ReactNode
  /** True when `mark` brings its own tile, so the wrapper stops drawing one. */
  markPlain?: boolean
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
  const { usage, loading: usageLoading } = useMyUsage(USAGE_DAYS)
  const { runs, loading: runsLoading } = useMyRuns(6)
  const { byProvider, loading: connectionsLoading } = useConnections()
  const { tasks, reachable: tasksReachable } = useMyTasks(5)
  const { dismissed, dismiss } = useDismissed()

  /* The composer's draft lives here rather than inside it, because a task in
     the band below has to be able to put a sentence into it. Starting a task
     seeds the box instead of submitting: the person gets to see what Divo is
     about to be asked and change it, which is the difference between a
     suggestion and a button that runs something on their behalf. */
  const [draft, setDraft] = useState('')
  /* Scrolled to by ref rather than `window.scrollTo`, because whether the
     window or some ancestor is the scrolling element is the shell's business
     and has changed before. Asking the node to bring itself into view is right
     either way. */
  const composerRef = useRef<HTMLDivElement>(null)

  // First name only. "Welcome back, Ananya Mehta" is a form letter; the
  // surname adds nothing the person does not already know about themselves.
  const viewer = (session?.name ?? session?.email ?? 'there').split(/[\s@]/)[0]
  const runChange = changePct(usage.runs, usage.previousRuns)
  const spend = useMemo(() => summarizeSpend(usage.series), [usage.series])

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
        // The app's own mark, not the first letter of its name. A row of cards
        // reading C / A / A asked somebody to tell Canva from Airtable from
        // AITable by initial, which is the one thing an icon is for.
        // 22 used to mean a 22px logo in a tile CSS pinned at 34. `size` is the
        // tile now, and the onboarding card wants the same one the lists use.
        mark: <ProviderMark provider={provider} size={34} />,
        markPlain: true,
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
      {/*
        The only page in the app with no heading of its own.
        Every other screen gets one from `PageHeader`; this one opens straight
        into the composer, which is right on screen and wrong underneath — a
        document whose outline starts at h2 gives a screen reader nothing to
        announce the page by, and leaves five sibling panels with no parent.
        Named, not shown: the composer is a better greeting than a title bar.
      */}
      <h1 className="ws-a11y-title">Your workspace</h1>
      <Composer go={go} value={draft} onChange={setDraft} slotRef={composerRef} />

      <ActionTiles
        attention={attention.length}
        running={runs.filter((run) => run.status === 'running').length}
        loading={!r1 || approvalsLoading}
        go={go}
      />

      <TaskBand
        tasks={tasks}
        reachable={tasksReachable}
        onStart={(task) => {
          setDraft(taskPrompt(task))
          // The composer is above a band the reader has scrolled down to;
          // seeding a box they cannot see reads as the button having done
          // nothing at all.
          composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }}
      />

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
                  <span className="ws-gs-mark" data-plain={card.markPlain ? 'true' : undefined} aria-hidden>
                    {card.mark}
                  </span>
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

      {/* Only what is genuinely waiting. The tiles above already say how many
          and offer the way in, so a settled workspace shows neither. */}
      {attention.length > 0 && !approvalsLoading ? (
        <section className="ws-band">
          <Panel
            title="Needs you"
            description={`${attention.length} item${attention.length > 1 ? 's' : ''} waiting`}
          >
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
          </Panel>
        </section>
      ) : null}

      {/* ── Performance ──────────────────────────────────
          The figures that used to be buried inside the usage card. They are the
          page's summary, so they sit above the charts that explain them rather
          than inside one of them. */}
      <section className="ws-band">
        <div className="ws-band-hd">
          <div>
            <h2>Performance</h2>
            <p>Your last {USAGE_WEEKS} weeks</p>
          </div>
          <div className="ws-band-act">
            <button type="button" className="btn" onClick={() => go('usage')}>View full report</button>
          </div>
        </div>
        <Panel source="myUsage">
          {!r2 || usageLoading ? <SkelRows n={2} icon={false} /> : (
            <Fade>
              <div className="ws-metrics">
                <div className="ws-metric">
                  <div className="k">Tasks run</div>
                  <div className="v">
                    {usage.runs}
                    {usage.previousRuns > 0 ? (
                      /* Tone is stated, never read off the sign. More runs is
                         not automatically good and fewer is not automatically
                         bad — this one is neutral on purpose. */
                      <span className="ws-delta">
                        <ArrowUpRight size={12} />
                        {runChange >= 0 ? '+' : '−'}{Math.abs(runChange)}%
                      </span>
                    ) : null}
                  </div>
                  <div className="s">vs the {USAGE_WEEKS} weeks before</div>
                </div>
                <div className="ws-metric">
                  <div className="k">Cost</div>
                  <div className="v">{money(usage.spendUsd)}</div>
                  <div className="s">{money(usage.spendTodayUsd)} today</div>
                </div>
                <div className="ws-metric">
                  <div className="k">Busiest day</div>
                  <div className="v">{spend.busiest ? money(spend.busiest.value) : '—'}</div>
                  <div className="s">{spend.busiest ? dayLabel(spend.busiest.date) : 'Nothing yet'}</div>
                </div>
                <div className="ws-metric">
                  <div className="k">Days used</div>
                  <div className="v">{spend.activeDays}</div>
                  <div className="s">
                    of {usage.days || USAGE_DAYS}
                    {spend.activeDays ? ` · ${money(spend.perActiveDay)} on a day you used it` : ''}
                  </div>
                </div>
              </div>
            </Fade>
          )}
        </Panel>
      </section>

      <SpendBands
        usage={usage}
        loading={!r2 || usageLoading}
        spendLabel={spend.last ? dayLabel(spend.last) : null}
      />

      {/*
        Two lists, side by side, closing the page.

        They were a full-width run list stacked on a half-width pair, which made
        the bottom of this page taller than the half that has the answers in it.
        Both are short lists of the same shape, so they belong in the same row —
        and the calendar that used to take the other half is gone rather than
        slimmed: its headline figures are the `Performance` row and its
        footnotes are the fourth tile there, which left a card holding a title,
        a grid and a legend, eleven of whose sixteen columns are empty. "How has
        spend moved" is the dot field above; "which days" still has room on
        `/settings/usage` and the profile, where nothing competes for it.
      */}
      <section className="ws-band">
        <div className="ws-cols">
          <Panel
            title="Recent work"
            description="What Divo has been doing for you"
            source="myRuns"
            aside={<button type="button" className="btn" onClick={() => go('usage')}>All activity</button>}
          >
            {!r3 || runsLoading ? <SkelRows n={4} icon={false} /> : runs.length === 0 ? (
              <Empty icon={Activity} title="Nothing yet" body="Runs appear here once you ask Divo to do something." />
            ) : (
              <Fade><RunList runs={runs} /></Fade>
            )}
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
                      {/* The app tile, not the old glyph box — this row sits
                          under real marks and a 32px square beside 34px tiles
                          is a misalignment you see before you read it. */}
                      <span className="ws-app"><Plus size={15} /></span>
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
 * The composer — the first thing on the page, and now a working one.
 *
 * It is the SAME component `/chat` uses, not a look-alike. Home is where you
 * start a run and `/chat` is where you watch it, so the box you type into had
 * better not change shape between the two — otherwise the handoff reads as
 * navigating to a different product rather than the same sentence continuing.
 *
 * The prompt is staged in session storage and the route changes to `/chat`,
 * which picks it up and starts the run immediately. Typing here and landing on
 * an empty composer would make the handoff feel like a page change rather than
 * a continuation of the thing you just asked for.
 */
/**
 * The draft is owned by the page, not by this.
 *
 * A task in the band below has to be able to put a sentence into the box, and a
 * composer holding its own text is a composer nothing else can reach.
 */
function Composer({ go, value: prompt, onChange: setPrompt, slotRef }: {
  go: (screen: string) => void
  value: string
  onChange: (next: string) => void
  slotRef?: React.Ref<HTMLDivElement>
}) {
  const attach = useAttachments()
  const modelChoice = useChatModelChoice()
  const { over, dropProps } = useFileDrop(attach.add)
  useDropGuard()

  const submit = () => {
    const trimmed = prompt.trim()
    if (!trimmed || !modelChoice.selection) return
    stageHandoff(trimmed, attach.files, modelChoice.selection)
    go('chat')
  }

  return (
    /* Only the composer's own slot takes a drop here, not the whole page. Home
       is a dashboard of panels rather than one conversation, so a veil across
       all of it would claim a target the panels do not have. */
    <div ref={slotRef} className="bui-scope ws-comp-slot relative" {...dropProps}>
      <DropVeil visible={over} />
      <ChatComposer
        value={prompt}
        onChange={setPrompt}
        onSubmit={submit}
        placeholder="Ask Divo to export, compare, clean up, draft, or investigate…"
        models={modelChoice.models}
        modelSelection={modelChoice.selection}
        onModelChange={modelChoice.selectModel}
        onReasoningEffortChange={modelChoice.selectReasoningEffort}
        modelLoading={modelChoice.loading}
        files={attach.files}
        rejected={attach.rejected}
        onAttach={attach.add}
        onRemoveFile={attach.remove}
      />
    </div>
  )
}

/**
 * What is waiting, as counts with a way in.
 *
 * Renders nothing when nothing is waiting. That is the whole point of it: a
 * settled workspace should not carry a card explaining that it is settled, and
 * the reader learns "there is nothing" faster from the row not being there than
 * from a tick and a sentence saying so.
 */
function ActionTiles({ attention, running, loading, go }: {
  attention: number
  running: number
  loading: boolean
  go: (screen: string) => void
}) {
  // Nothing at all while the answer is still unknown, rather than tiles that
  // pop in reading zero and then change under the reader.
  if (loading) return null
  const tiles = [
    attention > 0 && {
      key: 'approvals',
      icon: <CircleAlert size={15} />,
      label: 'Waiting on you',
      value: attention,
      unit: attention === 1 ? 'decision' : 'decisions',
      cta: 'Review',
      onClick: () => go('approvals'),
    },
    running > 0 && {
      key: 'running',
      icon: <Activity size={15} />,
      label: 'Running now',
      value: running,
      unit: running === 1 ? 'task' : 'tasks',
      cta: 'Watch',
      onClick: () => go('usage'),
    },
  ].filter(Boolean) as Array<{
    key: string; icon: ReactNode; label: string; value: number
    unit: string; cta: string; onClick: () => void
  }>

  if (tiles.length === 0) return null

  return (
    <section className="ws-band">
      <Fade>
        <div className="ws-acts">
          {tiles.map((tile) => (
            <div className="ws-act" key={tile.key}>
              <div className="ws-act-h">
                <span className="ws-act-ic" aria-hidden>{tile.icon}</span>
                {tile.label}
              </div>
              <div className="ws-act-b">
                <span className="ws-act-n">{tile.value}</span>
                <span className="ws-act-u">{tile.unit}</span>
                <button type="button" className="btn primary" onClick={tile.onClick}>{tile.cta}</button>
              </div>
            </div>
          ))}
        </div>
      </Fade>
    </section>
  )
}

/**
 * The sentence a task is turned into when somebody starts it.
 *
 * Deliberately an instruction rather than the title alone. "Lark Channel Audit"
 * on its own is a topic and Divo would open by asking what is wanted; naming
 * where it came from and asking for a plan first is what makes the button worth
 * pressing instead of typing.
 */
function taskPrompt(task: OpenTask): string {
  const due = task.dueDate ? ` It is due ${task.dueDate}.` : ''
  return `Help me with my Lark task "${task.title}".${due} `
    + 'Start by telling me what you understand it to involve and what you would do first.'
}

/**
 * The Lark tasks still assigned to this person.
 *
 * Read-only on purpose. Ticking one off from here would mean this page holds a
 * credential that can change somebody's Lark, which is a different permission
 * conversation from showing them a list — so the route behind it asks for read
 * access only and the only control is one that hands the work to Divo.
 */
function TaskBand({ tasks, reachable, onStart }: {
  tasks: readonly OpenTask[]
  reachable: boolean
  onStart: (task: OpenTask) => void
}) {
  /* Nothing when there is nothing, and nothing when Divo cannot see. Somebody
     with no Lark account linked is not missing a feature they asked for, and an
     offer to connect belongs on the Connected panel that already makes it. */
  if (!reachable || tasks.length === 0) return null

  return (
    <section className="ws-band">
      <div className="ws-band-hd">
        <div>
          <h2>Your open tasks</h2>
          <p>Assigned to you in Lark — start one and Divo picks it up</p>
        </div>
      </div>
      <Panel>
        <Fade>
          <div className="ws-rows">
            {tasks.map((task) => {
              const due = dueLabel(task)
              return (
                <div className="ws-row" key={task.taskId}>
                  <div className="ws-row-main">
                    <b>{task.title}</b>
                    {due ? (
                      <p className={task.overdue ? 'ws-task-late' : undefined}>{due}</p>
                    ) : null}
                  </div>
                  <div className="ws-row-act">
                    <button type="button" className="btn" onClick={() => onStart(task)}>Start</button>
                  </div>
                </div>
              )
            })}
          </div>
        </Fade>
      </Panel>
    </section>
  )
}

/**
 * Where the money went, and how it moved.
 *
 * Two charts rather than one because they answer different questions and a
 * reader asks both: a total is made of something, and it got here somehow.
 * Neither renders without data, so a workspace nobody has spent anything in
 * shows neither instead of two empty axes.
 */
function SpendBands({ usage, loading, spendLabel }: {
  usage: { byModel: { modelId: string; costUsd: number }[]; series: { date: string; spendUsd: number }[] }
  loading: boolean
  spendLabel: string | null
}) {
  const slices = useMemo(
    () => [...usage.byModel]
      // A cent, not a fraction of one. A row reading "0% · $0.00" is a model
      // that was billed four thousandths of a dollar, and listing it says
      // nothing except that the list has one more line than it needs.
      .filter((row) => row.costUsd >= 0.01)
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 8)
      .map((row, index) => ({ label: row.modelId, value: row.costUsd, color: hueAt(index) })),
    [usage.byModel],
  )
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  const points = usage.series.map((point) => ({ date: point.date, value: point.spendUsd }))


  if (loading) {
    return (
      <section className="ws-band">
        <div className="ws-cols"><Skel w="100%" h={200} block /><Skel w="100%" h={200} block /></div>
      </section>
    )
  }
  if (slices.length === 0 && points.length === 0) return null

  return (
    <section className="ws-band">
      <div className="ws-cols">
        {slices.length > 0 ? (
          <Panel title="Where your spend went" source="myUsage">
            <div className="ws-panel-body">
              <Fade>
                <HexShare slices={slices} />
                <div className="ws-share">
                  {slices.map((slice) => (
                    <div className="ws-share-r" key={slice.label}>
                      <i className="ws-share-d" style={{ background: slice.color }} />
                      <span className="ws-share-n">{slice.label}</span>
                      <span className="ws-share-p">
                        {total > 0 ? Math.round((slice.value / total) * 100) : 0}%
                      </span>
                      <span className="ws-share-v">{money(slice.value)}</span>
                    </div>
                  ))}
                </div>
              </Fade>
            </div>
          </Panel>
        ) : null}

        {points.length > 0 ? (
          <Panel
            title="Spend over time"
            source="myUsage"
            {...(spendLabel ? { description: `Last run ${spendLabel.toLowerCase()}` } : {})}
          >
            <div className="ws-panel-body">
              <Fade><DotField points={points} format={(n) => money(n)} /></Fade>
            </div>
          </Panel>
        ) : null}
      </div>
    </section>
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
                {runTitle(r)}
                {r.status === 'running' && r.channel === 'lark' ? (
                  <span className="ws-note" title="Lark runs are never closed by the backend — status and duration are unreliable for this channel.">
                    status unknown
                  </span>
                ) : null}
              </b>
              <p>
                {ago(r.startedAt)} · {RUN_CHANNEL_LABEL[r.channel] ?? r.channel}
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
