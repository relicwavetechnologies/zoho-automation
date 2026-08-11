/**
 * Mail — what Divo watches for in Gmail, and what it did about it.
 *
 * This is a work screen, not a settings screen, which is why it sits in the
 * app's own nav rather than behind Settings. A mail rule is Divo doing
 * something on your behalf every hour of every day; you come back to it to see
 * whether that is still true, not to configure it once and leave.
 *
 * The page answers four questions, in the order they go wrong, and each of them
 * exactly once:
 *
 *  1. **Can any of this run?** A mailbox whose Gmail watch never registered
 *     takes every rule on it down at once, and no per-rule row can explain
 *     that. `MailboxStrip` is the only place that fact is stated — when it is
 *     healthy it is one quiet line, and when it is not the same line carries
 *     the reason and the button that fixes it. There is no second banner:
 *     saying it twice made the page look like two different faults.
 *  2. **Is it doing anything?** The counts every rule already carries, summed.
 *     Without this the page is a list of promises with no evidence attached,
 *     and "is it working" costs a click per rule.
 *  3. **Which rules do I have?** One list. Paused rules stay in it, dimmed —
 *     hiding them behind a filter meant pausing a rule made it vanish, which
 *     reads as having deleted it.
 *  4. **Is any of it leaving the company?** A forward carries the whole message
 *     unchanged, and these rules are created by asking Divo in a sentence, so a
 *     standing export can exist without anyone having deliberately built one.
 *     Said as one line that *filters* the list rather than as a second panel
 *     that reprinted the same rows three inches above themselves.
 *
 * Every rule is rendered from its own stored conditions rather than from the
 * backend's one-line summary — see `matchClauses`. The summary cannot express
 * an exception or a ceiling, so a rule carrying either was described here as
 * something broader than it is.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { notify } from '@/lib/notify'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Archive, Copy, Inbox, Mail, MailWarning, MoreHorizontal,
  Pause, Pencil, Play, Plus, RefreshCw, ShieldAlert, Tag, TriangleAlert,
} from 'lucide-react'
import {
  leavesOrganisation, matchClauses, rateLimitClause, readAction, readDestination,
  useMailAutomations, useMailboxOptions, useMailDeliveries, useMailRuleDryRun, useMailRuleStatus,
  type MailDelivery, type MailRule, type MailRuleDryRun, type MailRuleState,
  type MailboxHealth, type MailboxResolution,
} from './data/use-mail-automations'
import { useConnections } from './data/use-connections'
import { ago } from './data/use-approvals'
import { GmailMark, LarkMark } from './brand'
import { DetailPage, RailChip, RailEmpty, RailRoute, RailRow, RailSection } from './detail'
import { Confirm, DataNote, Empty, Fade, PageHeader, Panel, RowMenu, Seg, SkelRows, useStaged } from './ui'
import type { Persona } from './fixtures'
import type { Toast } from './ui'

type ScreenProps = { persona: Persona; replay: number; toast: Toast; go: (screen: string) => void }

const CHANGE_DONE: Record<'pause' | 'resume' | 'archive', string> = {
  pause: 'Paused. Nothing will be forwarded until you resume it.',
  resume: 'Resumed. Mail arriving from now on will be acted on.',
  archive: 'Archived. It keeps its place — creating the same rule brings it back.',
}

/** How each state is labelled and toned. `waiting` is healthy, just untriggered. */
const STATE_BADGE: Record<MailRuleState, { label: string; tone: string }> = {
  working: { label: 'Working', tone: 'b-ok' },
  waiting: { label: 'Waiting', tone: '' },
  broken: { label: 'Broken', tone: 'b-err' },
  /* Refused by permission — about this rule. */
  blocked: { label: 'Blocked', tone: 'b-err' },
  /* Fine in itself, but nothing reaches it. Named for the cause rather than
     sharing "Blocked", which reads as a permission problem and is contradicted
     by the refused count of zero sitting beside it. */
  mailbox_down: { label: 'Not running', tone: 'b-err' },
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
  // Where it goes, not where it comes from — every rule on this page watches
  // Gmail, so a Gmail mark on each row would say the one thing they all share.
  if (destination.kind === 'lark' || destination.kind === 'lark_dm') return <LarkMark size={14} />
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

export function MailRules({ replay, toast, go }: ScreenProps) {
  const [r1] = useStaged([320], replay)
  const [scope, setScope] = useState<'live' | 'archived'>('live')
  const [onlyExternal, setOnlyExternal] = useState(false)
  /* Always the full set, filtered here. Two reasons: switching scope is then
     instant rather than a refetch, and an archived rule stays reachable from a
     link without the page having to decide in advance that it wants one. */
  const { rules, mailboxes, loading, error, refresh } = useMailAutomations(true)
  const resolution = useMailboxOptions()
  const navigate = useNavigate()
  void go

  // Two gates: the staged reveal that stops the page snapping in, and the real
  // fetch. Either alone either flashes empty rows or defeats the staging.
  const ready = r1 && !loading
  const settled = ready && !error

  const live = useMemo(() => rules.filter((r) => r.state !== 'archived'), [rules])
  const archived = useMemo(() => rules.filter((r) => r.state === 'archived'), [rules])
  const external = useMemo(() => live.filter(leavesOrganisation), [live])

  const shown = useMemo(() => {
    const base = scope === 'archived' ? archived : live
    return onlyExternal ? base.filter(leavesOrganisation) : base
  }, [scope, archived, live, onlyExternal])

  /* Nothing to build a rule on. The button is withheld rather than left live
     and leading somewhere that only says "connect Google" — a primary action
     that turns out to be a detour is worse than one that is not offered. */
  const canBuild = resolution.status === 'one' || resolution.status === 'choose'

  return (
    <>
      <PageHeader
        eyebrow="Your account"
        title="Mail"
        description="Standing rules that watch your Gmail and pass matching messages on. They run in the background, without asking you each time."
        actions={
          settled && canBuild ? (
            <>
              {archived.length > 0 ? (
                <Seg
                  value={scope}
                  onChange={setScope}
                  options={[
                    { value: 'live', label: `In use${live.length > 0 ? ` · ${live.length}` : ''}` },
                    { value: 'archived', label: `Archived · ${archived.length}` },
                  ]}
                />
              ) : null}
              {/* The other half of this page's question. The rules here promise
                  what Divo will do; Caught is the record of what it did — and it
                  is the only place a message a rule read and *held back* is
                  visible at all, so it must be reachable from both surfaces
                  rather than only from the member shell's nav. */}
              <button type="button" className="btn" onClick={() => navigate('/me/caught')}>
                <Inbox size={14} /> What Divo caught
              </button>
              <button type="button" className="btn primary" onClick={() => navigate('/me/mail/new')}>
                <Plus size={14} /> New rule
              </button>
            </>
          ) : undefined
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

        {/* The mailbox comes first. It used to be a panel at the foot of the
            page, below a box of general notes — so the one thing that can take
            every rule down at once was the last thing anybody read. */}
        {settled && mailboxes.length > 0 ? (
          <div className="ws-mbx">
            {mailboxes.map((mailbox) => (
              <MailboxCard
                key={mailbox.subscriptionId}
                mailbox={mailbox}
                rules={live.filter((r) => r.mailboxEmail === mailbox.mailboxEmail)}
                onReconnected={refresh}
              />
            ))}
          </div>
        ) : null}

        {/* Connecting, or fixing a connection. One component, one wording — the
            new-rule screen shows the same thing rather than a second version of
            it that told somebody with a scope-limited account to connect an
            account they already had. */}
        {settled ? <MailboxSetup resolution={resolution} onDone={refresh} /> : null}

        {/* One line, and it filters rather than reprints. The rules it is about
            are already on this page; a second panel listing them again made the
            same rule appear twice and read as two different problems. */}
        {settled && scope === 'live' && external.length > 0 ? (
          <div className="ws-ceiling">
            <ShieldAlert size={14} />
            <div>
              <b>
                {external.length === 1
                  ? 'One rule sends mail outside your company.'
                  : `${external.length} rules send mail outside your company.`}
              </b>{' '}
              A forward carries the whole message — headers, body and attachments, unchanged — for as
              long as the rule exists.
            </div>
            <button
              type="button"
              className="btn"
              onClick={() => setOnlyExternal((on) => !on)}
            >
              {onlyExternal ? 'Show all rules' : 'Show only these'}
            </button>
          </div>
        ) : null}

        <Panel
          title={scope === 'archived' ? 'Archived rules' : 'Your rules'}
          description={scope === 'archived'
            ? 'These will not fire again. Creating the same rule brings one back rather than making a second.'
            : onlyExternal
              ? 'Filtered to the rules whose mail leaves your company.'
              : undefined}
          source="mailRules"
        >
          {/* `error` is checked before `ready` because a failed load clears
              `loading` and leaves `rules` empty — which rendered "No mail rules
              yet" directly under the banner saying the opposite. */}
          {error ? (
            <Empty
              icon={TriangleAlert}
              title="Your rules could not be loaded"
              body="This is not the same as having none. Reload to try again."
            />
          ) : !ready ? <SkelRows n={3} /> : shown.length === 0 ? (
            <Empty
              icon={Inbox}
              title={!canBuild
                ? 'No rules yet'
                : scope === 'archived'
                  ? 'Nothing archived'
                  : onlyExternal ? 'None of your rules leave the company' : 'No mail rules yet'}
              body={!canBuild
                ? 'Connect the inbox you want watched first — the step above.'
                : scope === 'archived'
                  ? 'Rules you archive keep their place here.'
                  : onlyExternal
                    ? 'Every rule you have keeps mail inside your own domain.'
                    : 'A rule watches your inbox for the mail you describe and passes it on. Divo never rewrites what it forwards.'}
              action={canBuild && scope === 'live' && !onlyExternal ? (
                <button type="button" className="btn primary" onClick={() => navigate('/me/mail/new')}>
                  <Plus size={14} /> New rule
                </button>
              ) : undefined}
            />
          ) : (
            <Fade>
              <div className="ws-rows">
                {shown.map((rule) => (
                  <RuleRow key={rule.ruleId} rule={rule} toast={toast} onChanged={refresh} />
                ))}
              </div>
            </Fade>
          )}
        </Panel>
      </div>
    </>
  )
}

/**
 * One rule, and everything you can do to it without opening it.
 *
 * The row was a `<button>` wrapping the whole thing, which is why there were no
 * per-row actions: a button may not contain another button. Pausing a rule
 * therefore cost a navigation, a click, and a navigation back — for the one
 * action somebody takes in a hurry, because mail is going somewhere it should
 * not be.
 */
function RuleRow({
  rule, toast, onChanged,
}: { rule: MailRule; toast: Toast; onChanged: () => void }) {
  const navigate = useNavigate()
  const status = useMailRuleStatus()
  const [confirming, setConfirming] = useState(false)
  const destination = readDestination(rule.destination, rule.action)
  const line = ruleLine(rule)
  const paused = rule.state === 'paused'
  const archived = rule.state === 'archived'

  const change = async (next: 'pause' | 'resume' | 'archive') => {
    const done = await status.change(rule.ruleId, next)
    // A failed change must not report as a completed one. The server's own
    // sentence knows which of "not yours", "not real" and "nothing polls this
    // mailbox" it was; nothing here can improve on it.
    if (!done) { toast(status.error ?? 'That change could not be saved.', 'error'); return }
    toast(CHANGE_DONE[next])
    onChanged()
  }

  const open = () => navigate(`/me/mail/${rule.ruleId}`)

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="ws-row auto-row ws-rule-row"
        data-off={paused || archived ? 'true' : undefined}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
        }}
      >
        <span className="ws-ic">{ruleIcon(rule)}</span>
        <div className="ws-row-main">
          <b>
            {rule.name}
            {leavesOrganisation(rule)
              ? <span className="ws-tag" data-tone="warn">Leaves the company</span>
              : null}
          </b>
          {/* A rule whose conditions no longer parse says so here rather than
              showing a blank line that reads as "no conditions", i.e. as
              matching everything. */}
          <p>{line ?? 'Divo can no longer read this rule’s conditions.'}</p>
        </div>
        <div className="ws-row-act">
          <span className="ws-rule-when">
            {/* Evidence, not a promise. "Working" and "Waiting" are both healthy
                and look alike; the date is the only thing that separates a rule
                that fired this morning from one that has never fired at all. */}
            {rule.lastDeliveredAt ? `acted ${ago(rule.lastDeliveredAt)}` : 'never fired'}
          </span>
          <span className="ws-sub">{destination.label}</span>
          <StateBadge state={rule.state} />
          <RowMenu
            busy={status.pending !== null}
            items={[
              { label: 'Edit', icon: Pencil, onSelect: () => navigate(`/me/mail/${rule.ruleId}/edit`) },
              {
                label: 'Duplicate',
                icon: Copy,
                onSelect: () => navigate(`/me/mail/new?from=${rule.ruleId}`),
              },
              ...(archived ? [] : [{
                label: paused ? 'Resume' : 'Pause',
                icon: paused ? Play : Pause,
                onSelect: () => { void change(paused ? 'resume' : 'pause') },
              }]),
              ...(archived ? [] : [{
                label: 'Archive',
                icon: Archive,
                danger: true,
                onSelect: () => setConfirming(true),
              }]),
            ]}
          />
        </div>
      </div>

      {confirming ? (
        <Confirm
          title={`Archive “${rule.name}”?`}
          body={
            'It stops immediately and will not fire again. It is not deleted — it keeps its place '
            + 'under Archived, and creating this same rule later brings this one back rather than '
            + 'making a second one beside it.'
          }
          confirm="Archive it"
          onConfirm={() => change('archive')}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </>
  )
}

/**
 * The two failures a member can actually fix, and the only two that get a
 * button.
 *
 * Every other code the health assessment can carry ends in "wait" or "this
 * needs a Divo operator" — and a Reconnect button under those sentences is an
 * instruction to go and fix an account that is working. So the list is the
 * codes whose remedy already says to reconnect, and nothing else.
 */
const RECONNECTABLE = new Set(['connection_unavailable', 'scope_missing'])

function MailboxCard({
  mailbox, rules, onReconnected,
}: { mailbox: MailboxHealth; rules: MailRule[]; onReconnected: () => void }) {
  const { loading, connecting, connect } = useConnections()
  const [failed, setFailed] = useState<string | null>(null)
  const delayed = mailbox.state === 'watch_delayed' || mailbox.state === 'watch_degraded'
  const down = !mailbox.rulesCanFire && mailbox.state !== 'paused'
  const tone = delayed ? 'warn' : mailbox.rulesCanFire ? 'ok' : 'err'
  const fixable = down && Boolean(mailbox.failureCode && RECONNECTABLE.has(mailbox.failureCode))

  /*
   * What this mailbox has actually done, summed from counts its own rules
   * already carry — no new endpoint, and per mailbox rather than per page,
   * which is what the numbers were always about.
   */
  const total = useMemo(() => rules.reduce((sum, rule) => ({
    delivered: sum.delivered + rule.deliveredCount,
    failing: sum.failing + rule.failingCount,
    abandoned: sum.abandoned + rule.abandonedCount,
    blocked: sum.blocked + rule.blockedCount,
  }), { delivered: 0, failing: 0, abandoned: 0, blocked: 0 }), [rules])

  const anyWork = total.delivered + total.failing + total.abandoned + total.blocked > 0

  const onConnect = async () => {
    setFailed(null)
    try {
      // Mail alone — the same six scopes the new-rule flow asks for, not the
      // forty the general Connected apps flow requests. Reconnecting to fix
      // mail should not widen what Divo can reach.
      await connect('google_workspace', { forTools: ['mailAutomations'] })
      // The rules did not change; what changed is whether they can run. So the
      // page is re-read rather than navigated away from.
      onReconnected()
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'The Google window could not be opened.')
    }
  }

  return (
    <div className="ws-mbx-card" data-tone={tone} data-down={down ? 'true' : undefined}>
      <div className="ws-mbx-head">
        <GmailMark size={22} />
        <div className="ws-mbx-id">
          <b>{mailbox.mailboxEmail}</b>
          <p>
            <span className="ws-mbx-state">
              {down ? <MailWarning size={11} /> : <span className="ws-mbx-dot" />}
              {delayed ? 'delayed' : mailbox.rulesCanFire ? 'watching' : 'not watching'}
            </span>
            <span className="ws-mbx-sep">·</span>
            {mailbox.activeRuleCount} rule{mailbox.activeRuleCount === 1 ? '' : 's'}
            {mailbox.lastSignalAt ? (
              <><span className="ws-mbx-sep">·</span>last signal {ago(mailbox.lastSignalAt)}</>
            ) : null}
          </p>
        </div>

        {/* The evidence, on the same object it is evidence about. It had a
            full-width bar of its own holding eight words — the width was
            saying "this is important" about a number that never is. Zeroes
            are dropped rather than printed as three empty columns. */}
        {anyWork ? (
          <dl className="ws-mbx-stats">
            <div><dt>{total.delivered}</dt><dd>passed on</dd></div>
            {total.failing > 0 ? <div><dt>{total.failing}</dt><dd>in flight</dd></div> : null}
            {total.abandoned > 0 ? <div data-tone="err"><dt>{total.abandoned}</dt><dd>gave up</dd></div> : null}
            {/* Matched, then refused — a different conversation from a send
                that broke, so never folded into "gave up". */}
            {total.blocked > 0 ? <div data-tone="err"><dt>{total.blocked}</dt><dd>refused</dd></div> : null}
            <div className="ws-mbx-since"><dd>last 30 days</dd></div>
          </dl>
        ) : rules.length > 0 ? (
          <p className="ws-mbx-quiet">Nothing has matched in 30 days</p>
        ) : null}
      </div>

      {/* The reason lives with the mailbox it is about. With several connected,
          a banner at the top of the page had to name which one anyway — at
          which point it was this card, printed somewhere else. */}
      {down ? (
        <div className="ws-mbx-why">
          <p>
            {mailbox.summary}
            {mailbox.remedy ? ` ${mailbox.remedy}` : ''}
            {' '}Until that is fixed, no rule on this mailbox can fire — however healthy it looks below.
          </p>
          {fixable ? (
            <button
              type="button"
              className="btn primary"
              disabled={loading || connecting === 'google_workspace'}
              onClick={() => { void onConnect() }}
            >
              <RefreshCw size={13} />
              {connecting === 'google_workspace' ? 'Opening Google…' : 'Reconnect Google'}
            </button>
          ) : null}
          {failed ? <p className="ws-sub">{failed}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * No usable account, said three different ways — and the same three words on
 * both screens that need them.
 *
 * "Connect Google" is the wrong instruction for somebody who already has, and
 * who needs to grant Gmail access on the account they have — they would connect
 * a second one, hit the same wall, and have two. It is equally wrong for
 * somebody whose account Google simply logged out: nothing about that account
 * needs changing, it needs signing into.
 *
 * Exported because the new-rule screen hits exactly the same three states, and
 * used to carry its own wording for them. Two copies of a remedy is two chances
 * for one of them to go stale and send somebody somewhere useless.
 */
export function MailboxSetup({
  resolution, onDone,
}: { resolution: MailboxResolution; onDone?: () => void }) {
  const { byProvider, loading, connecting, connect } = useConnections()
  const [failed, setFailed] = useState<string | null>(null)

  if (
    resolution.status !== 'none'
    && resolution.status !== 'insufficient'
    && resolution.status !== 'reconnect'
  ) return null

  const insufficient = resolution.status === 'insufficient'
  const revoked = resolution.status === 'reconnect'
  const accounts = resolution.status === 'none'
    ? ''
    : resolution.options.map((o) => o.accountEmail).join(', ')
  const larkLinked = Boolean(byProvider.get('lark')?.connected)

  const onConnect = async () => {
    setFailed(null)
    try {
      // Asks Google for mail alone — six scopes, not the forty the general
      // Connected apps flow requests, because that is all this page needs.
      await connect('google_workspace', { forTools: ['mailAutomations'] })
      onDone?.()
    } catch (e) {
      setFailed(e instanceof Error ? e.message : 'The connect window could not be opened.')
    }
  }

  return (
    <Panel
      title={revoked
        ? 'Google signed Divo out of your account'
        : insufficient
          ? 'Your Google account cannot be used for mail yet'
          : 'Connect the inbox you want watched'}
      description={revoked
        ? `${accounts} is still listed, but Google has ended the authorisation — a password change, a revoked app, or simply long enough since you last signed in. Your existing rules are untouched and resume the moment you sign in again.`
        : insufficient
          ? `${accounts} is connected, but shared read-only or missing Gmail access. Divo has to read, watch and send with it to run a rule.`
          : 'Two steps, and nothing is watched until the second one. Connecting on its own starts nothing.'}
    >
      <div className="ws-rows">
        <div className="ws-row">
          <span className="ws-ic ws-ic-brand"><GmailMark size={17} /></span>
          <div className="ws-row-main">
            <b>{revoked
              ? 'Sign in to the Gmail account you want watched'
              : insufficient
                ? 'Reconnect it and grant the full Gmail access'
                : 'Connect the Gmail account you want watched'}</b>
            <p>Google will ask for your mail only — not Drive, Calendar or anything else.</p>
          </div>
          <div className="ws-row-act">
            <button
              type="button"
              className="btn primary"
              disabled={loading || connecting === 'google_workspace'}
              onClick={() => { void onConnect() }}
            >
              <GmailMark size={14} />
              {connecting === 'google_workspace'
                ? 'Waiting for Google…'
                : insufficient || revoked ? 'Reconnect Google' : 'Connect Gmail'}
            </button>
          </div>
        </div>

        <div className="ws-row">
          <span className="ws-ic"><Plus size={14} /></span>
          <div className="ws-row-main">
            <b>Build the rule you want</b>
            <p>Pick what to catch and what Divo should do with it. Nothing runs until you turn it on.</p>
          </div>
          <div className="ws-row-act">
            <span className="ws-sub">After the first step</span>
          </div>
        </div>

        {/* Stated here rather than discovered at the destination step. A rule
            that delivers to Lark cannot reach anybody without this, and finding
            that out after building the whole rule is the worst moment to. */}
        {!larkLinked ? (
          <div className="ws-row">
            <span className="ws-ic ws-ic-brand"><LarkMark size={15} /></span>
            <div className="ws-row-main">
              <b>Optional — link Lark to have mail sent to you there</b>
              <p>
                Only needed if you want Divo to message you rather than forward. Signing in with a
                password does not link it.
              </p>
            </div>
          </div>
        ) : null}
      </div>

      {failed ? (
        <div className="ws-panel-foot"><TriangleAlert size={13} /> {failed}</div>
      ) : (
        <div className="ws-panel-foot">
          {/* Google withholds the app name until brand verification passes and
              falls back to the domain. Somebody who is not warned reads that as
              having been sent to the wrong place, and stops. */}
          Google will name our domain rather than “Divo” on its consent screen — brand verification is
          still in progress.
        </div>
      )}
    </Panel>
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
  const { rules, mailboxes, loading, error, refresh } = useMailAutomations(true)
  const rule = rules.find((r) => r.ruleId === ruleId) ?? null
  const status = useMailRuleStatus()
  const [confirming, setConfirming] = useState(false)

  /*
   * A refused change is an answer to a press, so it comes back where the press
   * happened rather than as a panel above a rule whose state did not change.
   * Said once per distinct message — a retry that fails the same way is the
   * same news.
   */
  const spokenStatusError = useRef<string | null>(null)
  useEffect(() => {
    if (!status.error || spokenStatusError.current === status.error) return
    spokenStatusError.current = status.error
    notify.failed('That change was not saved', status.error)
  }, [status.error])

  const onChange = async (change: 'pause' | 'resume' | 'archive') => {
    if (!rule) return
    const done = await status.change(rule.ruleId, change)
    if (!done) return
    toast(CHANGE_DONE[change])
    // Archiving leaves the page describing a rule that is no longer in the
    // active list, so it goes back; the other two stay and re-read, because the
    // point of pausing is to look at what you just stopped.
    if (change === 'archive') navigate('/me/mail')
    else void refresh()
  }

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
  const archived = rule.state === 'archived'

  return (
    <DetailPage
      onBack={() => navigate('/me/mail')}
      title={rule.name}
      badge={<StateBadge state={rule.state} />}
      meta={`Created ${ago(rule.createdAt)}`}
      actions={
        <>
          <button
            type="button"
            className="btn"
            onClick={() => navigate(`/me/mail/${rule.ruleId}/edit`)}
          >
            <Pencil size={14} /> Edit
          </button>
          {/* Duplicating opens the same form seeded from this rule. It is the
              answer to "the same thing but for a different sender", which was
              previously a retype of every condition. */}
          <button
            type="button"
            className="btn"
            onClick={() => navigate(`/me/mail/new?from=${rule.ruleId}`)}
          >
            <Copy size={14} /> Duplicate
          </button>
          {archived ? null : (
            <button
              type="button"
              className="btn"
              disabled={status.pending !== null}
              onClick={() => { void onChange(paused ? 'resume' : 'pause') }}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
              {status.pending === 'pause' ? 'Pausing…'
                : status.pending === 'resume' ? 'Resuming…'
                  : paused ? 'Resume' : 'Pause'}
            </button>
          )}
          {archived ? null : (
            /* Archive, not delete. The rule keeps its place — re-creating the
               identical rule revives this row rather than making a second one
               — so promising a disappearance would be a lie you find out about
               under Archived. */
            <button
              type="button"
              className="btn"
              disabled={status.pending !== null}
              onClick={() => setConfirming(true)}
            >
              <Archive size={14} /> {status.pending === 'archive' ? 'Archiving…' : 'Archive'}
            </button>
          )}
        </>
      }
      rail={<RuleRail rule={rule} mailbox={mailbox} />}
    >
      <DataNote source="mailRules" />

      {confirming ? (
        <Confirm
          title={`Archive “${rule.name}”?`}
          body={
            'It stops immediately and will not fire again. It is not deleted — it keeps its place '
            + 'under Archived, and creating this same rule later brings this one back rather than '
            + 'making a second one beside it.'
          }
          confirm="Archive it"
          onConfirm={() => onChange('archive')}
          onClose={() => setConfirming(false)}
        />
      ) : null}


      {archived ? (
        <div className="ws-ceiling">
          <Archive size={14} />
          <div>
            <b>This rule is archived.</b> It will not fire again. Creating the same rule brings this
            one back rather than making a second — it keeps its place in the meantime.
          </div>
        </div>
      ) : null}

      {paused ? (
        <div className="ws-ceiling">
          <Pause size={14} />
          <div>
            <b>This rule is paused.</b> Mail arriving while it is paused is not held for later —
            resuming it acts on what comes next, not on what it missed.
          </div>
        </div>
      ) : null}

      {rule.invalidReason ? (
        <div className="ws-ceiling">
          <TriangleAlert size={14} />
          <div>
            <b>This rule can no longer run.</b> {rule.invalidReason} It will never fire again in this
            state — edit it, or archive it and build it afresh.
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

  /*
   * A dry run that could not finish printed a quiet line directly under the
   * result, where it read as "nothing matched" — the opposite conclusion from
   * the same grey text.
   */
  const spokenDryError = useRef<string | null>(null)
  useEffect(() => {
    if (!dryRun.error || spokenDryError.current === dryRun.error) return
    spokenDryError.current = dryRun.error
    notify.failed('The dry run could not finish', dryRun.error)
  }, [dryRun.error])

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
  // Narrowed once. `destination.label` still says "one of three people Divo
  // picks", which is the right one-liner for the Status row above; this is the
  // table itself, for the section that shows the whole thing.
  const routed = destination.kind === 'routed' ? destination : null
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
            The rail says which, rather than leaving the strip upstairs as the
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
        <RailRow label="Watches">
          <RailChip tone="plain">
            <span className="ws-chip-brand"><GmailMark size={12} />{rule.mailboxEmail}</span>
          </RailChip>
        </RailRow>
        <RailRow label="Sends to"><RailChip tone="plain">{destination.label}</RailChip></RailRow>
        <RailRow label="Limit">
          <RailChip tone="plain">
            {action.kind === 'organize'
              ? 'None — nothing is sent'
              : ceiling === null ? 'None' : `${ceiling} an hour`}
          </RailChip>
        </RailRow>
      </RailSection>

      {/* The routing table, where a plain rule shows its question. A member
          looking at a rule that sorts their mail has one question — who gets
          what — and this is the only screen that can answer it. */}
      {routed ? (
        <RailSection title="Divo sorts it" defaultOpen>
          {routed.routes.map((route) => (
            <RailRoute key={route.key} when={route.when || '(not described)'}>
              <RailChip tone="plain">{route.destination.label}</RailChip>
            </RailRoute>
          ))}
          <RailRoute when="Anything else">
            <RailChip tone="plain">
              {routed.otherwise
                ? routed.otherwise.label
                : 'Held back and shown to you'}
            </RailChip>
          </RailRoute>
        </RailSection>
      ) : null}

      {/* Only when the rule has one. An empty "Divo reads it" section on every
          other rule would advertise a feature by way of its absence. */}
      {rule.judge ? (
        <RailSection title="Divo reads it" defaultOpen>
          <p className="dt-empty">“{rule.judge.question}”</p>
          <RailRow label="If unanswerable">
            <RailChip tone="plain">
              {rule.judge.onFailure === 'open' ? 'Acts anyway' : 'Holds it back'}
            </RailChip>
          </RailRow>
        </RailSection>
      ) : null}

      <RailSection title="Last 30 days">
        <RailRow label="Delivered"><RailChip tone="plain">{rule.deliveredCount}</RailChip></RailRow>
        <RailRow label="In flight"><RailChip tone="plain">{rule.failingCount}</RailChip></RailRow>
        <RailRow label="Given up on"><RailChip tone="plain">{rule.abandonedCount}</RailChip></RailRow>
        {/* Matched, then refused. This row exists so a refusal stops being
            invisible — the mail was caught and then deliberately not sent. */}
        <RailRow label="Refused"><RailChip tone="plain">{rule.blockedCount}</RailChip></RailRow>
        {/* Read and deliberately passed over. Shown only on a rule that has a
            step, and worded apart from "Refused": on a working rule this is
            usually the largest number here, and reading it as failures would
            make the step look like the thing breaking the rule. */}
        {rule.judge || routed ? (
          <RailRow label="Held back"><RailChip tone="plain">{rule.heldCount}</RailChip></RailRow>
        ) : null}
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
  /* Read by the rule's question and deliberately passed over. Not toned as a
     failure — this is the rule working, and colouring it red teaches members to
     distrust the step that is saving them the most work. */
  held: 'Held back',
}

const DELIVERY_TONE: Record<string, string> = {
  delivered: 'b-ok',
  abandoned: 'b-err',
  blocked: 'b-err',
}
