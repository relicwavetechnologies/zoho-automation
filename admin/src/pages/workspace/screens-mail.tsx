/**
 * Mail — what Divo watches for in Gmail, and what it did about it.
 *
 * This is a work screen, not a settings screen, which is why it sits in the
 * app's own nav rather than behind Settings. A mail rule is Divo doing
 * something on your behalf every hour of every day; you come back to it to see
 * whether that is still true, not to configure it once and leave.
 *
 * The page is arranged around the two questions that actually go wrong, rather
 * than around the data model.
 *
 * First: why did everything stop? A mailbox whose Gmail watch never registered
 * takes every rule on it down at once, and no per-rule row can explain that.
 * The mailbox line answers it at the top, above the rules that would otherwise
 * be sitting there looking individually fine.
 *
 * Second: is any of this leaving the company? A forward carries the whole
 * message unchanged, and these rules are created by asking Divo in a sentence,
 * so a standing export can exist without anyone having deliberately built one.
 *
 * Every rule is rendered from its own stored conditions rather than from the
 * backend's one-line summary — see `matchClauses`. The summary cannot express
 * an exception or a ceiling, so a rule carrying either was described here as
 * something broader than it is.
 */
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Archive, Check, Inbox, Mail, MailWarning, MessageSquare, Pencil, Plus,
  ShieldAlert, Tag, Trash2, TriangleAlert,
} from 'lucide-react'
import {
  leavesOrganisation, matchClauses, rateLimitClause, readAction, readDestination,
  useMailAutomations, useMailDeliveries, useMailRuleDryRun,
  type MailDelivery, type MailRule, type MailRuleDryRun, type MailRuleState, type MailboxHealth,
} from './data/use-mail-automations'
import { useConnections } from './data/use-connections'
import { ago } from './data/use-approvals'
import { DetailPage, RailChip, RailEmpty, RailRow, RailSection } from './detail'
import { DataNote, Empty, Fade, PageHeader, Panel, Seg, SkelRows, useStaged } from './ui'
import type { Persona } from './fixtures'
import type { Toast } from './ui'

type ScreenProps = { persona: Persona; replay: number; toast: Toast; go: (screen: string) => void }

/**
 * Nothing on these screens can be written yet. `MailOpsService` has create,
 * pause and archive, but the only HTTP surface is read-only — so a rule is
 * still made and changed by asking Divo, and every control that would say
 * otherwise carries this instead of a handler.
 */
const NO_WRITE =
  'Mail rules can only be changed by asking Divo — the web app has no route for this yet.'

/** How each state is labelled and toned. `waiting` is healthy, just untriggered. */
const STATE_BADGE: Record<MailRuleState, { label: string; tone: string }> = {
  working: { label: 'Working', tone: 'b-ok' },
  waiting: { label: 'Waiting', tone: '' },
  broken: { label: 'Broken', tone: 'b-err' },
  blocked: { label: 'Blocked', tone: 'b-err' },
  paused: { label: 'Paused', tone: '' },
  archived: { label: 'Archived', tone: '' },
}

const StateBadge = ({ state }: { state: MailRuleState }) => {
  const badge = STATE_BADGE[state]
  return (
    <span className={`badge ${badge.tone}`}>
      {badge.tone === 'b-ok' ? <span className="dot" /> : null}{badge.label}
    </span>
  )
}

/** The icon says what kind of rule it is before the words do. */
function ruleIcon(rule: MailRule) {
  const destination = readDestination(rule.destination, rule.action)
  if (destination.kind === 'lark') return <MessageSquare size={14} />
  if (destination.kind === 'organize') return <Tag size={14} />
  return <Mail size={14} />
}

/**
 * The rule in one line: its conditions, then its ceiling.
 *
 * Deliberately not `rule.summary`. The backend writes that sentence from the
 * rule's headline fields, so a rule with an exception or a rate limit was
 * described here as the unrestricted version of itself.
 */
function ruleLine(rule: MailRule): string | null {
  const clauses = matchClauses(rule.match)
  if (clauses.length === 0) return null
  const ceiling = rateLimitClause(rule.action)
  return ceiling ? `${clauses.join(' · ')} · ${ceiling}` : clauses.join(' · ')
}

/* ══ List ══════════════════════════════════════════════ */

export function MailRules({ replay, go }: ScreenProps) {
  const [r1] = useStaged([320], replay)
  const [scope, setScope] = useState<'active' | 'all'>('active')
  const { rules, mailboxes, anyMailboxBroken, loading, error } = useMailAutomations(scope === 'all')
  const navigate = useNavigate()
  void go

  // Two gates: the staged reveal that stops the page snapping in, and the real
  // fetch. Either alone either flashes empty rows or defeats the staging.
  const ready = r1 && !loading
  const leaving = useMemo(() => rules.filter(leavesOrganisation), [rules])
  const settled = ready && !error

  return (
    <>
      <PageHeader
        eyebrow="Your account"
        title="Mail"
        description="Standing rules that watch your Gmail and pass matching messages on. They run in the background, without asking you each time."
        actions={
          <>
            <Seg
              value={scope}
              onChange={setScope}
              options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]}
            />
            <button type="button" className="btn primary" onClick={() => navigate('/me/mail/new')}>
              <Plus size={14} /> New rule
            </button>
          </>
        }
      />

      <div className="ws-stack">
        {error ? (
          <div className="ws-ceiling">
            <TriangleAlert size={14} />
            <div><b>{error}</b> Nothing here has been read from Divo, so treat this page as blank rather than as "no rules".</div>
          </div>
        ) : null}

        {/* Everything below is gated on `!error` as well as `ready`. A failed
            reload leaves the previous response in state, so without this a
            stale mailbox line and a stale list of externally-forwarding rules
            render directly beneath a banner saying nothing was read. */}
        {settled && anyMailboxBroken ? <MailboxBanner mailboxes={mailboxes} /> : null}

        {/* The mailbox comes first now. It used to be a panel at the foot of the
            page, below a box of general notes — so the one thing that can take
            every rule down at once was the last thing anybody read. */}
        {settled && mailboxes.length > 0 ? <MailboxStrip mailboxes={mailboxes} /> : null}

        {/* Nothing is being watched yet. Until this, the page answered that with
            an empty list and the sentence "ask Divo" — which leaves out the step
            that has to happen first and the button that does it, on a different
            screen the member has no reason to have found. */}
        {settled && mailboxes.length === 0 ? <GettingStarted /> : null}

        {settled && leaving.length > 0 ? (
          <Panel
            title="Mail leaving your company"
            description="A forward sends the whole message — headers, body and attachments, unchanged."
          >
            <div className="ws-rows">
              {leaving.map((rule) => {
                const destination = readDestination(rule.destination, rule.action)
                return (
                  <div className="ws-row" key={rule.ruleId}>
                    <span className="ws-ic"><ShieldAlert size={14} /></span>
                    <div className="ws-row-main">
                      <b>{rule.name}</b>
                      <p>{rule.mailboxEmail} → {destination.label}</p>
                    </div>
                    <div className="ws-row-act">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => navigate(`/me/mail/${rule.ruleId}`)}
                      >
                        Review
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </Panel>
        ) : null}

        <Panel title={scope === 'all' ? 'All rules' : 'Active rules'} source="mailRules">
          {/* `error` is checked before `ready` because a failed load clears
              `loading` and leaves `rules` empty — which rendered "No mail rules
              yet" directly under the banner saying the opposite. */}
          {error ? (
            <Empty
              icon={TriangleAlert}
              title="Your rules could not be loaded"
              body="This is not the same as having none. Reload to try again."
            />
          ) : !ready ? <SkelRows n={3} /> : rules.length === 0 ? (
            <Empty
              icon={Inbox}
              title={scope === 'all' ? 'No mail rules yet' : 'No active mail rules'}
              body={scope === 'all'
                ? 'A rule watches your inbox for the mail you describe and passes it on.'
                : 'Switch to All to see paused and archived rules.'}
              action={scope === 'all' ? (
                <button type="button" className="btn primary" onClick={() => navigate('/me/mail/new')}>
                  <Plus size={14} /> New rule
                </button>
              ) : undefined}
            />
          ) : (
            <Fade>
              <div className="ws-rows">
                {rules.map((rule) => {
                  const destination = readDestination(rule.destination, rule.action)
                  const line = ruleLine(rule)
                  return (
                    <button
                      type="button"
                      className="ws-row auto-row"
                      key={rule.ruleId}
                      onClick={() => navigate(`/me/mail/${rule.ruleId}`)}
                    >
                      <span className="ws-ic">{ruleIcon(rule)}</span>
                      <div className="ws-row-main">
                        <b>
                          {rule.name}
                          {leavesOrganisation(rule)
                            ? <span className="ws-tag" data-tone="warn">Leaves the company</span>
                            : null}
                        </b>
                        {/* A rule whose conditions no longer parse says so here
                            rather than showing a blank line that reads as "no
                            conditions", i.e. as matching everything. */}
                        <p>{line ?? 'Divo can no longer read this rule’s conditions.'}</p>
                      </div>
                      <div className="ws-row-act">
                        <span className="ws-sub">{destination.label}</span>
                        <StateBadge state={rule.state} />
                      </div>
                    </button>
                  )
                })}
              </div>
            </Fade>
          )}
        </Panel>
      </div>
    </>
  )
}

/**
 * The mailbox, in one line rather than a panel.
 *
 * Three outcomes, not two. "Watching" and "Not watching" hid the case that
 * happens most: the instant notification stops but the hourly check keeps
 * delivering. Calling that "Not watching" would send someone reconnecting an
 * account that works; calling it "Watching" would leave them puzzled about
 * mail arriving an hour late.
 */
function MailboxStrip({ mailboxes }: { mailboxes: MailboxHealth[] }) {
  return (
    <div className="ws-mbx">
      {mailboxes.map((mailbox) => {
        const delayed = mailbox.state === 'watch_delayed' || mailbox.state === 'watch_degraded'
        const tone = delayed ? 'warn' : mailbox.rulesCanFire ? 'ok' : 'err'
        return (
          <div className="ws-mbx-row" data-tone={tone} key={mailbox.subscriptionId}>
            <span className="ws-mbx-dot" />
            <b>{mailbox.mailboxEmail}</b>
            <span className="ws-mbx-state">
              {delayed ? 'delayed' : mailbox.rulesCanFire ? 'watching' : 'not watching'}
            </span>
            <span className="ws-mbx-sep">·</span>
            <span className="ws-sub">
              {mailbox.activeRuleCount} active rule{mailbox.activeRuleCount === 1 ? '' : 's'}
            </span>
            {mailbox.lastSignalAt ? (
              <span className="ws-mbx-when">last signal {ago(mailbox.lastSignalAt)}</span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The two steps that have to happen before this page can ever show anything.
 *
 * A member can arrive here wanting one thing — forward this sender to that
 * address — and the empty state used to tell them to ask Divo, which fails
 * until Gmail is connected, on a screen they were never sent to. Both steps are
 * stated here, in order, with the first one actionable where they stand.
 *
 * Connecting from here asks Google only for mail. The general Connected apps
 * screen still means "all of Google" because that is what it says; this button
 * means what this page is about, and the consent screen says so too.
 */
function GettingStarted() {
  const { byProvider, loading, connecting, connect } = useConnections()
  const [failed, setFailed] = useState<string | null>(null)
  const google = byProvider.get('google_workspace')
  const connected = Boolean(google?.connected)

  const onConnect = async () => {
    setFailed(null)
    try {
      await connect('google_workspace', { forTools: ['mailAutomations'] })
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'The connect window could not be opened.')
    }
  }

  return (
    <Panel
      title="Setting up your first mail rule"
      description="Two steps. Divo watches your Gmail and passes matching messages on — it never rewrites them."
    >
      <div className="ws-rows">
        <div className="ws-row">
          <span className="ws-ic">{connected ? <Check size={14} /> : <Mail size={14} />}</span>
          <div className="ws-row-main">
            <b>Connect the Gmail account you want watched</b>
            <p>
              {connected
                ? `Connected as ${google?.connections[0]?.accountEmail ?? 'your Google account'}. Divo can read this inbox and send on its behalf.`
                : 'Google will ask for your mail only — not Drive, Calendar or anything else.'}
            </p>
          </div>
          <div className="ws-row-act">
            {connected ? (
              <span className="badge b-ok"><span className="dot" />Connected</span>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={loading || connecting === 'google_workspace'}
                onClick={() => { void onConnect() }}
              >
                {connecting === 'google_workspace' ? 'Waiting for Google…' : 'Connect Gmail'}
              </button>
            )}
          </div>
        </div>

        <div className="ws-row">
          <span className="ws-ic"><MessageSquare size={14} /></span>
          <div className="ws-row-main">
            <b>Describe the rule you want</b>
            <p>
              Say something like <i>&ldquo;forward anything from billing@acme.com to me on Lark&rdquo;</i>.
              You will see exactly what Divo understood before anything is turned on.
            </p>
          </div>
        </div>
      </div>

      {failed ? (
        <div className="ws-panel-foot"><TriangleAlert size={13} /> {failed}</div>
      ) : (
        <div className="ws-panel-foot">
          {/* Google withholds the app name until brand verification passes and
              falls back to the domain. Somebody who is not warned reads that as
              having been sent to the wrong place, and stops. */}
          Google will name our domain rather than “Divo” on its consent screen — brand verification is
          still in progress. Nothing is watched until a rule exists; connecting on its own starts nothing.
        </div>
      )}
    </Panel>
  )
}

/**
 * The one line that explains a total stop.
 *
 * Named for the failing mailbox rather than written generically: with one
 * connected mailbox the address is the reassurance that this is about them, and
 * with several it is the only way to know which one to go and fix.
 */
function MailboxBanner({ mailboxes }: { mailboxes: MailboxHealth[] }) {
  const broken = mailboxes.filter((m) => !m.rulesCanFire && m.state !== 'paused')
  if (broken.length === 0) return null
  return (
    <div className="ws-ceiling">
      <MailWarning size={14} />
      <div>
        <b>
          {broken.length === 1
            ? `Divo is not watching ${broken[0]!.mailboxEmail}.`
            : `Divo is not watching ${broken.length} of your mailboxes.`}
        </b>{' '}
        {broken.length === 1
          ? `${broken[0]!.summary}${broken[0]!.remedy ? ` ${broken[0]!.remedy}` : ''} Until that is fixed, no rule on this mailbox can fire — however healthy it looks below.`
          : 'Until that is fixed, no rule on those mailboxes can fire — however healthy they look below.'}
      </div>
    </div>
  )
}

/* ══ Detail ════════════════════════════════════════════ */

/**
 * One rule, on the inspector-rail layout.
 *
 * It was a drawer while the page was read-only, which was the right size for
 * a summary and the wrong one for what the page has to carry now: the rule as
 * a sentence, the evidence that it works, and everything it did. The rail
 * takes the properties so the body can be about the mail.
 *
 * Loaded with `includeInactive` so a paused or archived rule opens from a link
 * rather than 404ing — those are exactly the rules somebody follows a link to.
 */
export function MailRuleDetail({ toast }: ScreenProps) {
  const { ruleId } = useParams()
  const navigate = useNavigate()
  const { rules, mailboxes, loading, error } = useMailAutomations(true)
  const rule = rules.find((r) => r.ruleId === ruleId) ?? null
  void toast

  if (loading) return <div className="page"><SkelRows n={4} /></div>

  if (error || !rule) {
    return (
      <div className="page">
        <Empty
          icon={error ? TriangleAlert : Inbox}
          title={error ? 'This rule could not be loaded' : 'No such rule'}
          body={error
            ? 'This is not the same as it having been deleted. Reload to try again.'
            : 'It may have been deleted, or the link may be out of date.'}
          action={
            <button type="button" className="btn" onClick={() => navigate('/me/mail')}>All mail rules</button>
          }
        />
      </div>
    )
  }

  const destination = readDestination(rule.destination, rule.action)
  const clauses = matchClauses(rule.match)
  const ceiling = rateLimitClause(rule.action)
  const mailbox = mailboxes.find((m) => m.mailboxEmail === rule.mailboxEmail) ?? null
  const paused = rule.state === 'paused'

  return (
    <DetailPage
      onBack={() => navigate('/me/mail')}
      title={rule.name}
      badge={<StateBadge state={rule.state} />}
      meta={`Created ${ago(rule.createdAt)}`}
      actions={
        <>
          <button type="button" className="btn" disabled title={NO_WRITE}>
            <Pencil size={14} /> Edit
          </button>
          <button type="button" className="btn" disabled title={NO_WRITE}>
            <Archive size={14} /> {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="btn" disabled title={NO_WRITE}>
            <Trash2 size={14} /> Delete
          </button>
        </>
      }
      rail={<RuleRail rule={rule} mailbox={mailbox} />}
    >
      <DataNote source="mailRules" />

      {rule.invalidReason ? (
        <div className="ws-ceiling">
          <TriangleAlert size={14} />
          <div>
            <b>This rule can no longer run.</b> {rule.invalidReason} It will never fire again in this
            state — ask Divo to delete it and create it afresh.
          </div>
        </div>
      ) : null}

      {leavesOrganisation(rule) ? (
        <div className="ws-ceiling">
          <ShieldAlert size={14} />
          <div>
            <b>Matching mail leaves your company.</b> Every message this rule matches is forwarded to{' '}
            {destination.label} in full — body and attachments included.
          </div>
        </div>
      ) : null}

      {/* Same clause list the row above rendered, and the same one the create
          flow reads back before anything is turned on. One function, so what
          somebody approved is literally what they come back and read. */}
      <section className="dt-block">
        <h2>When mail arrives that is</h2>
        <p className="dt-sub">
          Every condition has to hold. There is no “or” between them.
        </p>
        {clauses.length === 0 ? (
          <div className="dt-prose dt-prose-empty">
            Divo can no longer read this rule’s conditions, so there is nothing to show — and nothing
            it can act on either.
          </div>
        ) : (
          <ul className="dt-clauses">
            {clauses.map((clause) => <li key={clause}>{clause}</li>)}
          </ul>
        )}
      </section>

      <section className="dt-block">
        <h2>Divo will</h2>
        <div className="dt-prose">
          {destination.kind === 'organize'
            ? `Leave it where it is, ${destination.label}.`
            : destination.kind === 'unknown'
              ? 'Send it somewhere this rule can no longer describe.'
              : `Forward the whole message, unchanged, to ${destination.label}.`}
          {ceiling ? ` ${ceiling[0]!.toUpperCase()}${ceiling.slice(1)}.` : ''}
        </div>
      </section>

      <DryRun rule={rule} />
      <Activity rule={rule} />
    </DetailPage>
  )
}

/**
 * The question a waiting rule cannot answer about itself.
 *
 * A rule is written in a sentence and then sits there, and "Waiting" is the
 * same badge whether it was described correctly or not. This replays it over
 * mail Divo has already recorded and sends nothing.
 */
function DryRun({ rule }: { rule: MailRule }) {
  const dryRun = useMailRuleDryRun()

  return (
    <section className="dt-block">
      <h2>Would it have caught anything?</h2>
      <p className="dt-sub">
        Checks this rule against mail Divo has already seen for this mailbox. Nothing is sent.
      </p>

      <div className="dt-act">
        <button
          type="button"
          className="btn"
          disabled={dryRun.running}
          onClick={() => { void dryRun.run(rule.ruleId) }}
        >
          {dryRun.running ? 'Checking…' : dryRun.result ? 'Check again' : 'Check this rule'}
        </button>
      </div>

      {dryRun.error ? <p className="dt-sub">{dryRun.error}</p> : null}

      {dryRun.result && !dryRun.result.valid ? (
        <div className="ws-ceiling">
          <TriangleAlert size={14} />
          <div><b>This rule cannot be read.</b> {dryRun.result.invalidReason}</div>
        </div>
      ) : null}

      {dryRun.result?.valid ? <DryRunResult result={dryRun.result} /> : null}
    </section>
  )
}

/**
 * What the replay found, with its three qualifications kept apart.
 *
 * Rolling them into one number would be the easier read and the wrong one: a
 * match older than the rule will never be delivered, and a message whose body
 * retention has taken cannot be judged at all. Counting either as a match
 * promises mail that is not coming; counting either as a miss sends somebody
 * rewriting a rule that was right.
 */
function DryRunResult({ result }: { result: MailRuleDryRun }) {
  const considered = result.consideredCount ?? 0
  const matched = result.matchedCount ?? 0
  const predating = result.predatingCount ?? 0
  const unreadable = result.bodyUnavailableCount ?? 0
  const live = (result.matched ?? []).filter((hit) => !hit.predatesRule)

  return (
    <div className="dt-dry">
      <p className="dt-sub">
        {considered === 0
          ? 'There is no stored mail for this mailbox to check against yet.'
          : <>Read {considered} message{considered === 1 ? '' : 's'}, and {matched === 0 ? 'none matched' : <b>{matched} matched</b>}.</>}
      </p>

      {predating > 0 ? (
        <p className="dt-sub">
          {predating} of those arrived before this rule started, so it would not have acted on them.
        </p>
      ) : null}

      {unreadable > 0 ? (
        <p className="dt-sub">
          {unreadable} could not be judged — this rule reads the message body, and those bodies have
          since been discarded. They are neither a match nor a miss.
        </p>
      ) : null}

      {live.length > 0 ? (
        <div className="ws-rows dt-hits">
          {live.map((hit) => (
            <div className="ws-row" key={hit.eventId}>
              <span className="ws-ic"><Mail size={14} /></span>
              <div className="ws-row-main">
                <b>{hit.subject ?? 'Message without a subject'}</b>
                <p>{hit.from ?? 'Unknown sender'} · {ago(hit.occurredAt)}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Every message this rule acted on, most recent first. */
function Activity({ rule }: { rule: MailRule }) {
  const { deliveries, loading } = useMailDeliveries(rule.ruleId)

  return (
    <section className="dt-block">
      <h2>What it acted on</h2>
      <p className="dt-sub">The last 25 messages this rule matched, and what became of each.</p>

      {loading ? <SkelRows n={3} icon={false} /> : deliveries.length === 0 ? (
        <div className="dt-prose dt-prose-empty">
          Nothing yet. Either no mail has matched, or the mailbox is not being watched.
        </div>
      ) : (
        <div className="ws-rows dt-hits">
          {deliveries.map((delivery) => <DeliveryRow key={delivery.deliveryId} delivery={delivery} />)}
        </div>
      )}
    </section>
  )
}

function DeliveryRow({ delivery }: { delivery: MailDelivery }) {
  return (
    <div className="ws-row">
      <span className="ws-ic"><Mail size={14} /></span>
      <div className="ws-row-main">
        <b>{delivery.subject ?? 'Message without a subject'}</b>
        <p>
          {delivery.from ?? 'Unknown sender'} · {ago(delivery.firstAttemptAt)}
          {delivery.attempts > 1 ? ` · ${delivery.attempts} attempts` : ''}
          {delivery.lastError ? ` · ${delivery.lastError}` : ''}
        </p>
      </div>
      <div className="ws-row-act">
        {/* A send whose outcome was never established. Gmail does not reliably
            keep a client-supplied Message-ID, so a blind retry risks a
            duplicate — the worker asks whether the staged draft survived, and
            this tag stands only while that question is genuinely open. */}
        {delivery.ambiguous
          ? <span className="ws-tag" data-tone="warn" title="The send was made but could not be confirmed.">Unconfirmed</span>
          : null}
        <span className={`badge ${DELIVERY_TONE[delivery.status] ?? ''}`}>
          {DELIVERY_LABEL[delivery.status] ?? delivery.status}
        </span>
      </div>
    </div>
  )
}

function RuleRail({ rule, mailbox }: { rule: MailRule; mailbox: MailboxHealth | null }) {
  const destination = readDestination(rule.destination, rule.action)
  const action = readAction(rule.action)
  const ceiling = action.kind === 'forward' || action.kind === 'deliver'
    ? action.rateLimitPerHour
    : null

  return (
    <>
      <RailSection title="Status">
        <RailRow label="State"><RailChip>{STATE_BADGE[rule.state].label}</RailChip></RailRow>
        <RailRow label="Last delivery">
          <RailChip tone="plain">{rule.lastDeliveredAt ? ago(rule.lastDeliveredAt) : 'Never'}</RailChip>
        </RailRow>
        {/* A rule can look perfect and still be dead because its mailbox is.
            The rail says which, rather than leaving the banner upstairs as the
            only place that knows. */}
        <RailRow label="Mailbox">
          <RailChip tone={mailbox?.rulesCanFire === false ? undefined : 'plain'}>
            {mailbox === null
              ? 'Unknown'
              : mailbox.rulesCanFire ? 'Being watched' : 'Not being watched'}
          </RailChip>
        </RailRow>
      </RailSection>

      <RailSection title="Where">
        <RailRow label="Watches"><RailChip tone="plain">{rule.mailboxEmail}</RailChip></RailRow>
        <RailRow label="Sends to"><RailChip tone="plain">{destination.label}</RailChip></RailRow>
        <RailRow label="Limit">
          <RailChip tone="plain">
            {action.kind === 'organize'
              ? 'None — nothing is sent'
              : ceiling === null ? 'None' : `${ceiling} an hour`}
          </RailChip>
        </RailRow>
      </RailSection>

      <RailSection title="Last 30 days">
        <RailRow label="Delivered"><RailChip tone="plain">{rule.deliveredCount}</RailChip></RailRow>
        <RailRow label="In flight"><RailChip tone="plain">{rule.failingCount}</RailChip></RailRow>
        <RailRow label="Given up on"><RailChip tone="plain">{rule.abandonedCount}</RailChip></RailRow>
        {/* Matched, then refused. This row exists so a refusal stops being
            invisible — the mail was caught and then deliberately not sent. */}
        <RailRow label="Refused"><RailChip tone="plain">{rule.blockedCount}</RailChip></RailRow>
      </RailSection>

      <RailSection title="Last failure" defaultOpen={Boolean(rule.lastError)}>
        {rule.lastError ? (
          <p className="dt-empty">
            {rule.lastError}{rule.lastErrorAt ? ` · ${ago(rule.lastErrorAt)}` : ''}
          </p>
        ) : (
          <RailEmpty>Nothing has failed on this rule.</RailEmpty>
        )}
      </RailSection>
    </>
  )
}

const DELIVERY_LABEL: Record<string, string> = {
  delivered: 'Sent',
  pending: 'Waiting',
  sending: 'Sending',
  abandoned: 'Gave up',
  blocked: 'Not allowed',
}

const DELIVERY_TONE: Record<string, string> = {
  delivered: 'b-ok',
  abandoned: 'b-err',
  blocked: 'b-err',
}
