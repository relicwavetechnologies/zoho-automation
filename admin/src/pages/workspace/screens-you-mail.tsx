/**
 * "Mail rules" — the You scope's view of what Divo is watching for in Gmail.
 *
 * The screen is arranged around the two questions that actually go wrong,
 * rather than around the data model. First: is any of this leaving the
 * company? A forward carries the whole message unchanged, and these rules are
 * created by asking Divo in a sentence, so a standing export can exist without
 * anyone having deliberately built one — that goes at the top, always, before
 * the rules themselves.
 *
 * Second: why did everything stop? A mailbox whose Gmail watch never
 * registered takes every rule on it down at once, and no per-rule row can
 * explain that. The mailbox banner answers it in one line, above the list the
 * rules would otherwise be sitting in looking individually fine.
 */
import { useMemo, useState } from 'react'
import { Clock, Inbox, Mail, MailWarning, ShieldAlert, TriangleAlert } from 'lucide-react'
import {
  leavesOrganisation, matchClauses, readDestination,
  useMailAutomations, useMailDeliveries,
  type MailRule, type MailRuleState, type MailboxHealth,
} from './data/use-mail-automations'
import {
  Drawer, Empty, Fade, PageHeader, Panel, Seg, SkelRows, useStaged,
} from './ui'
import type { Persona } from './fixtures'
import type { Toast } from './ui'

type ScreenProps = { persona: Persona; replay: number; toast: Toast; go: (screen: string) => void }

/** How each state is labelled and toned. `waiting` is healthy, just untriggered. */
const STATE_BADGE: Record<MailRuleState, { label: string; tone: string }> = {
  working: { label: 'Working', tone: 'b-ok' },
  waiting: { label: 'Waiting', tone: '' },
  broken: { label: 'Broken', tone: 'b-err' },
  blocked: { label: 'Blocked', tone: 'b-err' },
  paused: { label: 'Paused', tone: '' },
  archived: { label: 'Archived', tone: '' },
}

export function YouMailRules({ replay }: ScreenProps) {
  const [r1] = useStaged([320], replay)
  const [scope, setScope] = useState<'active' | 'all'>('active')
  const [open, setOpen] = useState<MailRule | null>(null)
  const { rules, mailboxes, anyMailboxBroken, loading, error } =
    useMailAutomations(scope === 'all')

  // Two gates: the staged reveal that stops the page snapping in, and the real
  // fetch. Either alone either flashes empty rows or defeats the staging.
  const ready = r1 && !loading

  const leaving = useMemo(() => rules.filter(leavesOrganisation), [rules])

  return (
    <>
      <PageHeader
        eyebrow="Your account"
        title="Mail rules"
        description="Standing rules that watch your Gmail inbox and pass matching messages on. They run in the background, without asking you each time."
        actions={
          <Seg
            value={scope}
            onChange={setScope}
            options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]}
          />
        }
      />

      <div className="ws-stack">
        {error ? (
          <div className="ws-ceiling">
            <TriangleAlert size={14} />
            <div><b>{error}</b> Nothing here has been read from Divo, so treat this page as blank rather than as "no rules".</div>
          </div>
        ) : null}

        {ready && anyMailboxBroken ? <MailboxBanner mailboxes={mailboxes} /> : null}

        {ready && leaving.length > 0 ? (
          <Panel
            title="Mail leaving your company"
            description="A forward sends the whole message — headers, body and attachments, unchanged."
          >
            <div className="ws-rows">
              {leaving.map((rule) => {
                const destination = readDestination(rule.destination)
                return (
                  <div className="ws-row" key={rule.ruleId}>
                    <span className="ws-ic"><ShieldAlert size={14} /></span>
                    <div className="ws-row-main">
                      <b>{rule.name}</b>
                      <p>{rule.mailboxEmail} → {destination.label}</p>
                    </div>
                    <div className="ws-row-act">
                      <button type="button" className="btn" onClick={() => setOpen(rule)}>Review</button>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="ws-panel-foot">
              To stop one, ask Divo to pause or delete the rule by name.
            </div>
          </Panel>
        ) : null}

        <Panel title={scope === 'all' ? 'All rules' : 'Active rules'} source="mailRules">
          {!ready ? <SkelRows n={3} /> : rules.length === 0 ? (
            <Empty
              icon={Inbox}
              title={scope === 'all' ? 'No mail rules yet' : 'No active mail rules'}
              body={scope === 'all'
                ? 'Ask Divo something like "forward anything from billing@acme.com to my Lark chat" and the rule will appear here.'
                : 'Switch to All to see paused and archived rules.'}
            />
          ) : (
            <Fade>
              <div className="ws-rows">
                {rules.map((rule) => {
                  const badge = STATE_BADGE[rule.state]
                  const destination = readDestination(rule.destination)
                  return (
                    <div
                      role="button"
                      tabIndex={0}
                      className="ws-row click"
                      key={rule.ruleId}
                      onClick={() => setOpen(rule)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(rule) }
                      }}
                    >
                      <span className="ws-ic"><Mail size={14} /></span>
                      <div className="ws-row-main">
                        <b>
                          {rule.name}
                          {leavesOrganisation(rule) ? <span className="ws-tag" data-tone="warn">Leaves the company</span> : null}
                        </b>
                        <p>{rule.summary}</p>
                      </div>
                      <div className="ws-row-act">
                        <span className="ws-sub">{destination.label}</span>
                        <span className={`badge ${badge.tone}`}>
                          {badge.tone === 'b-ok' ? <span className="dot" /> : null}
                          {badge.label}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </Fade>
          )}
        </Panel>

        {ready && mailboxes.length > 0 ? (
          <Panel title="Mailboxes" description="Rules can only fire while Divo is being told about new mail.">
            <div className="ws-rows">
              {mailboxes.map((mailbox) => (
                <div className="ws-row" key={mailbox.subscriptionId}>
                  <span className="ws-ic"><Inbox size={14} /></span>
                  <div className="ws-row-main">
                    <b>{mailbox.mailboxEmail}</b>
                    <p>{mailbox.summary}{mailbox.remedy ? ` ${mailbox.remedy}` : ''}</p>
                  </div>
                  <div className="ws-row-act">
                    <span className="ws-sub">
                      {mailbox.activeRuleCount} active rule{mailbox.activeRuleCount === 1 ? '' : 's'}
                    </span>
                    {mailboxBadge(mailbox)}
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        ) : null}

        <Panel title="What these rules can and cannot do">
          <div className="ws-panel-body">
            <div className="ws-kv">
              <div><span>Mailboxes</span><b>Gmail only, and only your inbox</b></div>
              <div><span>Matching</span><b>Every condition must hold — plain text, no "or"</b></div>
              <div><span>What is sent</span><b>The whole message, not a summary</b></div>
              <div><span>Counts below</span><b>Last 30 days</b></div>
            </div>
          </div>
        </Panel>
      </div>

      {open ? <RuleDrawer rule={open} onClose={() => setOpen(null)} /> : null}
    </>
  )
}

/**
 * Three outcomes, not two.
 *
 * "Watching" and "Not watching" hid the case that actually happens most: the
 * instant notification stops but the hourly check keeps delivering. Calling
 * that "Not watching" would send someone reconnecting an account that is
 * working, and calling it "Watching" would leave them puzzled about mail
 * arriving an hour late.
 */
function mailboxBadge(mailbox: MailboxHealth) {
  if (mailbox.state === 'watch_delayed' || mailbox.state === 'watch_degraded') {
    return <span className="badge">Delayed</span>
  }
  return mailbox.rulesCanFire
    ? <span className="badge b-ok"><span className="dot" />Watching</span>
    : <span className="badge b-err">Not watching</span>
}

/**
 * The one line that explains a total stop.
 *
 * Named for the failing mailbox rather than written generically: with one
 * connected mailbox the address is the reassurance that this is about them,
 * and with several it is the only way to know which one to go and fix.
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

function RuleDrawer({ rule, onClose }: { rule: MailRule; onClose: () => void }) {
  const { deliveries, loading } = useMailDeliveries(rule.ruleId)
  const destination = readDestination(rule.destination)
  const clauses = matchClauses(rule.match)
  const badge = STATE_BADGE[rule.state]

  return (
    <Drawer title={rule.name} subtitle={`${rule.mailboxEmail} · created ${onDate(rule.createdAt)}`} onClose={onClose}>
      <div className="ws-stack">
        <div className="ws-row" style={{ padding: 0, border: 0 }}>
          <span className={`badge ${badge.tone}`}>
            {badge.tone === 'b-ok' ? <span className="dot" /> : null}{badge.label}
          </span>
          <span className="ws-sub" style={{ flex: 1 }}>{rule.summary}</span>
        </div>

        {rule.invalidReason ? (
          <div className="ws-ceiling">
            <TriangleAlert size={14} />
            <div>
              <b>This rule can no longer run.</b> {rule.invalidReason} It will never fire again in this state —
              ask Divo to delete it and create it afresh.
            </div>
          </div>
        ) : null}

        {leavesOrganisation(rule) ? (
          <div className="ws-ceiling">
            <ShieldAlert size={14} />
            <div>
              <b>Matching mail leaves your company.</b>{' '}
              Every message this rule matches is forwarded to {destination.label} in full — body and attachments included.
            </div>
          </div>
        ) : null}

        <div>
          <div className="ws-lbl">When mail arrives that is</div>
          {clauses.length === 0 ? (
            <p className="ws-sub" style={{ marginTop: 8 }}>
              Divo can no longer read this rule&apos;s conditions.
            </p>
          ) : (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {clauses.map((clause) => (
                <li key={clause} style={{ fontSize: 13, lineHeight: 1.7 }}>{clause}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="ws-kv">
          <div><span>Sends to</span><b>{destination.label}</b></div>
          <div><span>Delivered</span><b>{rule.deliveredCount} in the last 30 days</b></div>
          <div><span>In flight</span><b>{rule.failingCount}</b></div>
          <div><span>Given up on</span><b>{rule.abandonedCount}</b></div>
          <div><span>Last delivery</span><b>{rule.lastDeliveredAt ? onDate(rule.lastDeliveredAt) : 'Never'}</b></div>
        </div>

        {rule.lastError ? (
          <div>
            <div className="ws-lbl">Last failure</div>
            <p className="ws-sub" style={{ marginTop: 6 }}>
              {rule.lastError}{rule.lastErrorAt ? ` · ${onDate(rule.lastErrorAt)}` : ''}
            </p>
          </div>
        ) : null}

        <div>
          <div className="ws-lbl">Recent mail it acted on</div>
          {loading ? <SkelRows n={2} icon={false} /> : deliveries.length === 0 ? (
            <p className="ws-sub" style={{ marginTop: 6 }}>
              Nothing yet. Either no mail has matched, or the mailbox is not being watched.
            </p>
          ) : (
            <div className="ws-rows" style={{ marginTop: 8 }}>
              {deliveries.map((delivery) => (
                <div className="ws-row" key={delivery.deliveryId}>
                  <span className="ws-ic"><Clock size={14} /></span>
                  <div className="ws-row-main">
                    <b>{delivery.subject ?? 'Message without a subject'}</b>
                    <p>
                      {delivery.from ?? 'Unknown sender'} · {onDate(delivery.firstAttemptAt)}
                      {delivery.lastError ? ` · ${delivery.lastError}` : ''}
                    </p>
                  </div>
                  <div className="ws-row-act">
                    {/* Sent but unconfirmed. Retrying could duplicate the mail,
                        so Divo stopped — a person has to decide, and can only
                        do that if the row says so. */}
                    {delivery.ambiguous
                      ? <span className="ws-tag" data-tone="warn">Unconfirmed</span>
                      : null}
                    <span className={`badge ${DELIVERY_TONE[delivery.status] ?? ''}`}>
                      {DELIVERY_LABEL[delivery.status] ?? delivery.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Drawer>
  )
}

const DELIVERY_LABEL: Record<string, string> = {
  delivered: 'Sent',
  pending: 'Waiting',
  sending: 'Sending',
  abandoned: 'Gave up',
}

const DELIVERY_TONE: Record<string, string> = {
  delivered: 'b-ok',
  abandoned: 'b-err',
}

const onDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
