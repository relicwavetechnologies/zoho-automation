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
 * `UpNext` and the charts all return `null` rather than an empty state, and
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
  Activity, ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight,
  Link2, Plus, X,
} from 'lucide-react'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { BrandMark } from '@/components/admin/brand-mark'
import { Composer as ChatComposer } from './chat/composer'
import { DropVeil, useAttachments, useDropGuard, useFileDrop } from './chat/attach.view'
import { stageHandoff } from './chat/handoff'
import { useChatModelChoice } from './chat/model-choice'
import '@/styles/beautiful.css'
import { useDecisions } from './data/use-decisions'
import { ago, answerAt, expiryLabel } from './decisions/decision'
import {
  useMyRuns, useMyUsage, changePct, durationLabel, runTitle,
  dayLabel, summarizeSpend, USAGE_DAYS, USAGE_WEEKS,
} from './data/use-my-activity'
import { useConnections, CONNECTABLE } from './data/use-connections'
import { useMyTasks, type OpenTask } from './data/use-my-tasks'
import { UpNext } from './home/upnext.view'
import { appChips, withReference, type AppChip } from './home/apps'
import { Made } from './home/made.view'
import { ArtifactWorkspace } from './artifacts/panel'
import { showSavedArtifact } from './artifacts/open'
import { DotField, HexShare, hueAt } from './charts'
import type { MyRun } from './data/use-my-activity'
import type { Provider } from './fixtures'
import {
  ClickRow, Empty, Fade, Panel, ProviderMark, Skel, SkelRows,
  money, providerName, type Toast,
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

/*
 * There is no staged reveal here any more.
 *
 * The page used to hold `useStaged([260, 520, 800])` and gate every band on
 * `!rN || somethingLoading` — a mock-era device that lit the regions up in
 * reading order. Against real queries it only ever added delay: a band whose
 * data had already arrived sat as a skeleton until its timer fired, and one
 * whose query was slow ignored the timer anyway. Every band now shows its own
 * shape for exactly as long as its own read takes.
 */
export function WorkspaceHome({ persona, go, toast }: ScreenProps) {
  const { session, token } = useAdminAuth()
  const { awaitingMe, loading: approvalsLoading } = useDecisions()
  const { usage, loading: usageLoading } = useMyUsage(USAGE_DAYS)
  const { runs, loading: runsLoading } = useMyRuns(6)
  const { byProvider, loading: connectionsLoading } = useConnections()
  /* Twelve for a band that shows six. `UpNext` orders by urgency and then
     cuts, so the read has to be wider than the band or the cut happens first
     and the late task is the one that never arrived. */
  const { tasks, reachable: tasksReachable, loading: tasksLoading } = useMyTasks(12)
  const { dismissed, dismiss } = useDismissed()

  /* The composer's draft lives here rather than inside it, because a task in
     the band below has to be able to put a sentence into it. Starting a task
     seeds the box instead of submitting: the person gets to see what Divo is
     about to be asked and change it, which is the difference between a
     suggestion and a button that runs something on their behalf. */
  const [draft, setDraft] = useState('')
  const { scroller, hero, drop } = useHeroScroll()

  // First name only. "Welcome back, Ananya Mehta" is a form letter; the
  // surname adds nothing the person does not already know about themselves.
  const viewer = (session?.name ?? session?.email ?? 'there').split(/[\s@]/)[0]
  const runChange = changePct(usage.runs, usage.previousRuns)
  const spend = useMemo(() => summarizeSpend(usage.series), [usage.series])

  const connected = CONNECTABLE
    .map((provider) => ({ provider, status: byProvider.get(provider) }))
    .filter((entry) => entry.status?.connected)

  /* The same list the Connected panel draws, opened into the apps behind each
     connection — one row that says what Divo can reach, under the box you ask
     it in. See `home/apps.ts` for why a connection is not a chip. */
  const apps = appChips(connected.map((entry) => entry.provider))

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
    ...awaitingMe.map((decision) => {
      const expiry = expiryLabel(decision.expiresAt)
      const at = answerAt(decision)
      return {
        tone: 'act' as const,
        title: decision.title,
        body: decision.detail ?? '',
        meta: [
          `${decision.source} · ${ago(decision.requestedAt)}`,
          expiry ? `Expires ${expiry.text}` : 'No deadline',
          // Said on the card rather than behind a button, because for a
          // decision with no thread there is no button to put it behind.
          ...(at ? [] : ['Answer this on the Lark card']),
        ],
        // No CTA when there is nowhere to go. A "Review" that lands on Home is
        // worse than none: it reads as a broken feature rather than as a
        // decision that lives somewhere else.
        ...(at ? { cta: 'Open the chat', onClick: () => go(at) } : {}),
      }
    }),
    /* An expired request of your own used to get a card here. It cannot any
       more, and deliberately: the decision module drops anything past its
       deadline before this surface sees it, so the branch could only ever
       produce an empty list — which would read as "nothing of yours has ever
       lapsed". A card that cannot appear is worse than no card. */
  ]

  return (
    /* The same split the chat uses, around the dashboard this time.
       A document belongs to the person rather than to the conversation that
       produced it, so "read it" has to mean the same thing on both pages — and
       the panel's state is module-level, so one opened here is still open after
       walking into a chat. */
    <ArtifactWorkspace>
    <div className="ws-scroller" ref={scroller}>
      {/*
        The composer rides in a bar that is sticky from the very first pixel,
        and is pushed down into the middle of the first screen while nobody has
        scrolled. One element the whole way: the alternative — a big one on the
        landing and a small one that appears at the top afterwards — is two
        composers, and the moment they swap is the moment a half-typed sentence
        is somewhere the reader was not looking.
      */}
      <div className="ws-stage" style={{ ['--chrome' as string]: 1 - hero }}>
        {/* Greeting, box and invitation move as one. They used to be pinned to
            the top, the middle and the bottom edge of the landing, which read
            as three unrelated things on a tall screen rather than as one place
            to start. The two either side are positioned off the box, so the
            group stays composed at every size the box passes through. */}
        <div
          className="ws-stage-in"
          style={{
            transform: `translateY(${(drop * hero).toFixed(1)}px)`,
            width: `${620 + 100 * hero}px`,
          }}
        >
          <div className="ws-hero-greet" style={{ opacity: Math.max(0, hero * 2 - 1) }}>
            <p className="ws-hero-hi">Good {partOfDay()}, {viewer}</p>
            <p className="ws-hero-ask">What should Divo work on?</p>
          </div>

          <Composer
            go={go}
            value={draft}
            onChange={setDraft}
            hero={hero}
            apps={apps}
            appsLoading={connectionsLoading}
          />

          {/* Gone rather than transparent once it has faded: a control at zero
              opacity is still in the tab order, so a keyboard reader would land
              on an invisible button offering to scroll somewhere they already
              are. */}
          {hero > 0.7 && (
            <button
              type="button"
              className="ws-hero-more"
              style={{ opacity: Math.max(0, hero * 3 - 2.1) }}
              /* A control rather than a caption. Somebody who reads it and
                 clicks has said what they want, and a label that does nothing
                 when pressed is a worse answer than no label at all. */
              onClick={() => scroller.current?.scrollTo({
                top: scroller.current.clientHeight - HERO_BAR,
                behavior: 'smooth',
              })}
            >
              Your dashboard
              <ChevronDown size={14} />
            </button>
          )}
        </div>
      </div>

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

        {/* The landing is empty on purpose — everything on it is drawn by the
            stage above, which floats over this. What this section is, is the
            one screenful of room that makes it a landing at all. */}
        <div className="ws-hero" aria-hidden="true" />

        <ActionTiles
        attention={attention.length}
        running={runs.filter((run) => run.status === 'running').length}
        loading={approvalsLoading}
        go={go}
      />

      <UpNext
        tasks={tasks}
        approvals={awaitingMe}
        reachable={tasksReachable}
        /* Both reads, not either: the band merges tasks with approvals, so
           filling in as the first one lands would rank a list against half its
           input and then reorder it under the reader. */
        loading={tasksLoading || approvalsLoading}
        /* Seeds the bar that is already on screen. It used to scroll the
           composer into view, which was right when the composer sat a few
           rows above; now it is stuck to the top of every screenful, and
           scrolling to something already in front of somebody moves the page
           under them for no reason. */
        onStartTask={(task) => setDraft(taskPrompt(task))}
        /* The thread that asked, when there is one. A decision raised in
           Lark or by a run nobody was watching carries no thread, so the row
           says where to answer it instead of moving the reader nowhere. */
        onOpenApproval={(approval) => {
          const at = answerAt(approval)
          if (at) go(at)
          else toast('This one was asked on Lark — answer it on the card there', 'error')
        }}
      />

      {/* Under what is waiting, above what could be set up: the documents are
          finished work, so they come after the things that are not. */}
      <Made onOpen={(item) => { void showSavedArtifact(item, token) }} />

      {/*
        Nothing at all until the connections are known, unlike the two bands
        above, which hold their shape.

        Those are lists of what exists; this is a list of what does NOT. While
        the read is out `byProvider` is empty, which reads as "you have
        connected nothing" — so the optimistic version of this band is six
        onboarding cards shown to somebody who finished onboarding months ago,
        and it takes a whole screenful to say it before vanishing. A band whose
        content is an assumption should wait for the answer.
      */}
      {!connectionsLoading && cards.length > 0 ? (
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

          {/* No skeleton here any more: the band itself waits for the read, so
              a placeholder inside it could only ever draw after the answer had
              arrived. */}
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
                    {a.cta ? (
                      <button type="button" className="btn" onClick={a.onClick}>{a.cta}</button>
                    ) : null}
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
          {usageLoading ? <MetricsSkeleton /> : (
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
        loading={usageLoading}
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
            {runsLoading ? <SkelRows n={4} icon={false} /> : runs.length === 0 ? (
              <Empty icon={Activity} title="Nothing yet" body="Runs appear here once you ask Divo to do something." />
            ) : (
              <Fade><RunList runs={runs} /></Fade>
            )}
          </Panel>

          <Panel title="Connected" aside={<button type="button" className="btn" onClick={() => go('connections')}>Manage</button>}>
            {connectionsLoading ? <SkelRows n={3} /> : connected.length === 0 ? (
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
    </div>
    </ArtifactWorkspace>
  )
}

/**
 * The Performance row, empty.
 *
 * It used to load as two `SkelRows` — an icon tile, two lines and a button,
 * three times over — and resolve into four bordered columns of figures. Two
 * unrelated shapes in the same box is the reflow a skeleton is supposed to
 * prevent, so this is the metrics grid itself with the figures missing: same
 * columns, same dividers, same three line heights.
 */
function MetricsSkeleton() {
  return (
    <div className="ws-metrics" aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <div className="ws-metric" key={i}>
          {/* Bar heights are the line boxes they stand in for — an 11px label,
              a 20px figure, a 12px note — because these divs have no text to
              give the tile its height while the read is out. */}
          <div className="k"><Skel w={i % 2 ? 62 : 74} h={12} /></div>
          <div className="v"><Skel w={i === 0 ? 46 : 70} h={24} /></div>
          <div className="s"><Skel w={`${58 + ((i * 11) % 24)}%`} h={14} /></div>
        </div>
      ))}
    </div>
  )
}

/**
 * "morning", "afternoon", "evening".
 *
 * The reader's own clock, never the server's — a greeting is the one thing on
 * this page that has to agree with the window they are sitting next to.
 */
function partOfDay(now = new Date()): string {
  const hour = now.getHours()
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
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
/**
 * How far out of the landing the reader has scrolled, as one number.
 *
 * 1 is the composer at full size in the middle of an empty first screen; 0 is
 * the compact bar at the top with the dashboard under it. Everything that moves
 * — the composer's own geometry, the greeting, the scroll hint, the bar's
 * background — is a function of this and nothing else, so nothing can get out
 * of step with anything else.
 *
 * Read straight off the scroller on a frame rather than kept in React state: it
 * changes on every scroll event, and a `setState` per frame would re-render the
 * whole dashboard underneath to move one element by a pixel. What React holds
 * is only the rounded value the composer needs, which settles in a handful of
 * steps and then stops.
 */
function useHeroScroll(): {
  scroller: React.RefObject<HTMLDivElement>
  hero: number
  /** How far the composer is pushed down to sit in the middle of the landing. */
  drop: number
} {
  const scroller = useRef<HTMLDivElement>(null)
  const [hero, setHero] = useState(1)
  const [drop, setDrop] = useState(0)

  useEffect(() => {
    const node = scroller.current
    if (!node) return
    let queued = false

    const frame = () => {
      queued = false
      /* Measured here rather than read during render: a component that reads
         layout while rendering gets whatever the previous pass left behind,
         and on the first pass gets nothing at all. */
      setDrop(Math.max(0, (node.clientHeight - HERO_BAR) * 0.44))
      /* The travel is one screenful minus the bar the composer ends up as —
         the same distance the hero section occupies, so the transformation
         finishes exactly as the dashboard reaches the top. */
      const travel = Math.max(1, node.clientHeight - HERO_BAR)
      const t = Math.min(1, Math.max(0, node.scrollTop / travel))
      const eased = t * t * (3 - 2 * t)
      /* Quantised to 24 steps. Smooth enough that no frame is missing, coarse
         enough that a scroll costs a couple of dozen renders rather than one
         per pixel. */
      const next = Math.round((1 - eased) * 24) / 24
      setHero((current) => (current === next ? current : next))
    }

    const onScroll = () => {
      if (queued) return
      queued = true
      requestAnimationFrame(frame)
    }

    node.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', frame)
    frame()
    return () => {
      node.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', frame)
    }
  }, [])

  return { scroller, hero, drop }
}

/** The height the composer settles into once it has finished compressing. */
const HERO_BAR = 96

function Composer({ go, value: prompt, onChange: setPrompt, slotRef, hero, apps, appsLoading }: {
  go: (screen: string) => void
  value: string
  onChange: (next: string) => void
  slotRef?: React.Ref<HTMLDivElement>
  /** 1 on the landing, 0 once it has compressed into the bar. See `Composer`. */
  hero?: number
  /** The apps Divo can reach for this person. See `home/apps.ts`. */
  apps: readonly AppChip[]
  appsLoading: boolean
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
        {...(hero !== undefined ? { hero } : {})}
        {/* The tray exists only on the landing, and only while there is
            something to put in it: a person with nothing connected gets the box
            on its own rather than an empty strip under it. The placeholders
            hold the row open while the connections are being read, so the
            composer does not change height under somebody's hands. */
        ...(hero !== undefined && (appsLoading || apps.length > 0) ? {
          actions: appsLoading
            ? [0, 1, 2, 3, 4].map((i) => (
              <span key={i} className="ws-app-chip" data-ghost="true" aria-hidden />
            ))
            : apps.map((app) => (
              <button
                key={app.key}
                type="button"
                className="ws-app-chip"
                /* The name is the button's label rather than its contents. A
                   screen reader announces it, a pointer gets it as a tooltip,
                   and the tray stays a glance instead of a menu. */
                title={app.label}
                aria-label={`Ask about ${app.label}`}
                /* Focus follows for free: the chip sits inside the composer,
                   whose click handler puts the caret back in the field. */
                onClick={() => setPrompt(withReference(prompt, app))}
              >
                <BrandMark brand={app.key} size={17} />
              </button>
            )),
        } : {})}
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
  /*
   * No "Waiting on you" tile.
   *
   * It counted the decisions the "Up next" band directly below it already
   * lists by name, and its "Review" opened the approvals page — which is gone,
   * because a decision is now answered in the thread that asked it. A tile with
   * a number and no destination is worse than no tile: the band underneath can
   * say the same thing and take you somewhere.
   */
  const tiles = [
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


  /*
   * Two panels, not two grey slabs.
   *
   * The pair used to load as bare 200px blocks and resolve into titled panels
   * with a 176px chart and a legend under it — taller, and bordered, so the
   * whole bottom half of the page stepped down as the read landed. The chrome
   * is known before the numbers are, so it is drawn: only the chart and its
   * legend are missing.
   */
  if (loading) {
    return (
      <section className="ws-band" aria-busy="true">
        <div className="ws-cols">
          <Panel title="Where your spend went" source="myUsage">
            <div className="ws-panel-body">
              <Skel w="100%" h={176} block />
              <div style={{ height: 14 }} />
              <Skel w="72%" h={11} />
              <div style={{ height: 9 }} />
              <Skel w="54%" h={11} />
            </div>
          </Panel>
          <Panel title="Spend over time" source="myUsage">
            <div className="ws-panel-body"><Skel w="100%" h={176} block /></div>
          </Panel>
        </div>
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
