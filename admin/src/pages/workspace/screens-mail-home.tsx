/**
 * Home — what Divo did with your mail, at a glance.
 *
 * Rules answers *are my rules set up right*. Caught answers *what happened to
 * this message*. Neither answers the question somebody opens the app with,
 * which is **has this been working, and when**. That took reading a feed and
 * counting, so it was never actually asked.
 *
 * Three things, in the order the question is asked: how much came through, when
 * it came through, and the last few so the numbers can be checked against
 * something real.
 *
 * Every figure here is counted from the same rows Caught renders. Nothing is
 * fetched that Caught does not already fetch, and nothing is estimated — a
 * summary that disagrees with the page underneath it is worse than no summary.
 */
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Ban, Check, Clock, Inbox, TriangleAlert } from 'lucide-react'
import { useCaught, useCaughtActivity, useMailAutomations } from './data/use-mail-automations'
import {
  MAIL_LATEST_ROWS, MAIL_SUMMARY_WINDOW_DAYS as WINDOW_DAYS, mailBucketOf, summarizeMail,
} from './data/mail-summary'

/** Said in weeks, because a grid one column per week is read in weeks. */
const WINDOW_WEEKS = WINDOW_DAYS / 7
import { Empty, Fade, Heatmap, PageHeader, Panel, SkelRows, useStaged } from './ui'

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

const dayLabel = (iso: string): string => {
  const at = new Date(iso)
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((midnight(new Date()) - midnight(at)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function MailHome() {
  const [r1, r2] = useStaged([220, 460], 0)
  // Two sources on purpose: the calendar and the counts come from the light
  // activity route, which covers the whole window; the rows underneath come
  // from the feed, which carries the subject and rule a row needs.
  const { activity, truncated, loading, error } = useCaughtActivity(WINDOW_DAYS)
  const { caught, loading: feedLoading } = useCaught(MAIL_LATEST_ROWS)
  const { rules, mailboxes } = useMailAutomations()

  const summary = useMemo(() => summarizeMail(activity), [activity])
  const latest = useMemo(() => caught.slice(0, MAIL_LATEST_ROWS), [caught])

  // A rule the member switched off, or retired, is not a rule that is running.
  // Everything else — including a broken one — is live and counted, because a
  // fault is something to fix rather than a reason to under-report the setup.
  const liveRules = rules.filter((rule) => rule.state !== 'paused' && rule.state !== 'archived').length
  // `rulesCanFire` rather than a state name: the hook calls it the only field
  // that matters at a glance, and a degraded watch still delivers.
  const firing = mailboxes.filter((box) => box.rulesCanFire).length

  return (
    <div className="page">
      <PageHeader
        eyebrow="Your mail"
        title="Home"
        description={`What Divo has done with your mail over the last ${WINDOW_WEEKS} weeks.`}
        actions={<Link className="btn" to="/me/caught">See every message</Link>}
      />

      {/*
        Failure is carried, not swallowed. An empty feed and a feed that could
        not be read look identical, and the first one means "Divo has done
        nothing" — the one conclusion this page must never state without
        evidence.
      */}
      {error ? (
        <Panel>
          <Empty icon={TriangleAlert} title="This could not be read" body={error} />
        </Panel>
      ) : null}

      {/*
        Side by side, because neither half fills a page on its own. The summary
        is a 300px calendar and three figures; the feed is six rows. Stacked,
        each one drew a band of empty panel as wide as the screen and pushed the
        other below the fold — so the page read as sparse while answering
        nothing more.
      */}
      <section className="ws-band">
        {/* `stretch` rather than the grid's default `start`: the two cards are
            one answer, and letting the shorter one stop halfway leaves a step
            down the middle of the page. */}
        <div className="ws-cols-even" style={{ alignItems: 'stretch' }}>
        <Panel
          title={`Last ${WINDOW_WEEKS} weeks`}
          // The setup facts belong to the card, not to one figure inside it.
          // Under "Messages caught" they wrapped to two lines and made that
          // column taller than its two neighbours for no reason.
          description={`${liveRules} live ${liveRules === 1 ? 'rule' : 'rules'} · ${firing} mailbox${firing === 1 ? '' : 'es'} watching`}
        >
          <div className="ws-panel-body">
            {!r1 || loading ? <SkelRows n={3} icon={false} /> : (
              <Fade>
                {/* A grid rather than a flex row. Wrapping put "Needs a look"
                    on its own line under two figures, which left a hole beside
                    them and read as a second, more important section. Three
                    equal columns hold the line at half width. */}
                <div className="ws-stat3">
                  <div>
                    <div className="ws-lbl">Messages caught</div>
                    <div className="ws-num" style={{ marginTop: 8 }}>{summary.total}</div>
                    <div className="ws-sub" style={{ marginTop: 5 }}>
                      {summary.total === 0 ? 'None yet' : `across ${summary.activeDays} day${summary.activeDays === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  <div>
                    <div className="ws-lbl">Passed on</div>
                    <div className="ws-num" style={{ marginTop: 8 }}>{summary.counts.passed}</div>
                    <div className="ws-sub" style={{ marginTop: 5 }}>
                      {/* Held is stated next to passed rather than hidden: a rule
                          that reads and declines is working, and the member
                          cannot otherwise tell that apart from a dead rule. */}
                      {summary.counts.held} held after reading
                    </div>
                  </div>
                  <div>
                    <div className="ws-lbl">Needs a look</div>
                    <div
                      className="ws-num"
                      style={{ marginTop: 8, color: summary.counts.failed > 0 ? 'var(--cur-error)' : undefined }}
                    >
                      {summary.counts.failed}
                    </div>
                    <div className="ws-sub" style={{ marginTop: 5 }}>
                      {summary.counts.failed === 0 ? 'Nothing failed' : 'Failed to send'}
                    </div>
                  </div>
                </div>

                {/*
                  The calendar now spans the card. Sixteen weeks is sixteen
                  columns, which fills the width at a legible cell size — the
                  thing thirty days could never do without either stretching
                  into tiles or leaving a column of nothing beside it.
                */}
                <div style={{ marginTop: 22 }}>
                  <Heatmap
                    data={summary.series}
                    format={(n) => `${n} message${n === 1 ? '' : 's'}`}
                  />
                </div>
                <div className="ws-heat-facts">
                  <div>
                    <div className="ws-lbl">Busiest day</div>
                    <div style={{ marginTop: 5 }}>
                      {summary.busiestDay
                        ? `${dayLabel(summary.busiestDay.date)} · ${summary.busiestDay.value} message${summary.busiestDay.value === 1 ? '' : 's'}`
                        : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="ws-lbl">Days with mail</div>
                    <div style={{ marginTop: 5 }}>{summary.activeDays} of {WINDOW_DAYS}</div>
                  </div>
                  <div>
                    <div className="ws-lbl">Last caught</div>
                    <div style={{ marginTop: 5 }}>
                      {summary.lastCaughtAt
                        ? `${dayLabel(summary.lastCaughtAt)} ${timeLabel(summary.lastCaughtAt)}`
                        : '—'}
                    </div>
                  </div>
                </div>
                {/* Said out loud, because a capped calendar is the one chart
                    that lies quietly: the squares it never heard about are
                    drawn exactly like the days that were genuinely silent. */}
                {truncated ? (
                  <div className="ws-sub" style={{ marginTop: 12 }}>
                    This window holds more messages than one request returns, so the earliest days
                    in the calendar may be missing rather than quiet.
                  </div>
                ) : null}
              </Fade>
            )}
          </div>
        </Panel>

        <Panel
          title="Latest"
          description="The most recent messages a rule of yours acted on"
          aside={<Link className="btn" to="/me/caught">Caught</Link>}
        >
          {!r2 || feedLoading ? <SkelRows n={4} /> : latest.length === 0 ? (
            <Empty
              icon={Inbox}
              title="Nothing yet"
              body="When a rule of yours matches a message, it appears here."
            />
          ) : (
            <Fade>
              <div className="ws-rows">
                {latest.map((row) => {
                  const bucket = mailBucketOf(row)
                  const Icon = bucket === 'passed' ? Check
                    : bucket === 'held' ? Ban
                      : bucket === 'failed' ? TriangleAlert : Clock
                  return (
                    <div className="ws-row" key={row.deliveryId}>
                      <span className="ws-ic"><Icon size={14} /></span>
                      <div className="ws-row-main">
                        <b>{row.subject ?? '(no subject)'}</b>
                        <p>
                          {row.ruleName}
                          {row.from ? ` · ${row.from}` : ''}
                          {` · ${dayLabel(row.firstAttemptAt)} ${timeLabel(row.firstAttemptAt)}`}
                        </p>
                      </div>
                      <div className="ws-row-act">
                        {bucket === 'passed' ? <span className="badge b-ok"><span className="dot" />Passed on</span> : null}
                        {bucket === 'held' ? <span className="badge"><span className="dot" />Held</span> : null}
                        {bucket === 'failed' ? <span className="badge b-err"><span className="dot" />Failed</span> : null}
                        {bucket === 'pending' ? <span className="badge b-run"><span className="dot" />Sending</span> : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            </Fade>
          )}
        </Panel>
        </div>
      </section>
    </div>
  )
}
