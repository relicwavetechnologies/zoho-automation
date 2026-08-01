/**
 * "You" scope — what an individual employee sees, whatever their role.
 *
 * The organising idea: this is a trust and self-service surface, not an admin
 * console shrunk down. An employee comes here because something is blocked,
 * because they want to know what Divo can see, or to take access back.
 */
import { useMemo, useState } from 'react'
import {
  Activity, ArrowUpRight, Ban, BookOpen, Brain, Check, CircleAlert, Clock, ExternalLink,
  Eye, Gauge, Link2, Lock, MessageSquare, Plus, ShieldCheck, Sparkles, Trash2, TriangleAlert, X,
} from 'lucide-react'
import {
  CONNECTORS, MEMORIES, PEOPLE, SKILLS, TOOLS, personById, resolveGrants, toolById,
  type Memory, type Persona, type Provider,
} from './fixtures'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { CONNECTABLE, useConnectionGrants, useConnections, type LiveConnection } from './data/use-connections'
import { ago, expiryLabel, useApprovals } from './data/use-approvals'
import { changePct, durationLabel, useMyRuns, useMyUsage, type MyRun } from './data/use-my-activity'
import {
  Bar, ChangePreview, DataNote, Drawer, Empty, Fade, Matrix, PageHeader, Panel, Provenance,
  ProviderMark, Seg, Skel, SkelRows, Spark, Switch, compact, listPhrase, money,
  permissionSentence, providerName, useStaged,
} from './ui'

type ScreenProps = { persona: Persona; replay: number; toast: (m: string) => void; go: (screen: string) => void }

/* ══ Home ══════════════════════════════════════════════
   Deliberately NOT four KPI tiles. The first thing on the page is the small
   set of items that actually want a human; the numbers come after, once,
   with a comparison rather than a bare count. */
export function YouHome({ persona, replay, toast, go }: ScreenProps) {
  const [r1, r2, r3] = useStaged([260, 520, 800], replay)
  const { session } = useAdminAuth()
  const { awaitingMe, requestedByMe, loading: approvalsLoading } = useApprovals()
  const { usage, loading: usageLoading } = useMyUsage(30)
  const { runs, loading: runsLoading } = useMyRuns(4)
  const { byProvider, loading: connectionsLoading } = useConnections()
  // First name only. A dashboard greeting reading "Welcome back, Ananya Mehta"
  // is a form letter; the surname adds nothing the person does not know.
  const viewer = (session?.name ?? session?.email ?? 'there').split(/[\s@]/)[0]
  const brokenSkill = SKILLS.find((s) => s.blockedBy)
  const runChange = changePct(usage.runs, usage.previousRuns)
  const connected = CONNECTABLE
    .map((provider) => ({ provider, status: byProvider.get(provider) }))
    .filter((entry) => entry.status?.connected)
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
    ...(brokenSkill
      ? [{
          tone: 'warn' as const,
          title: `"${brokenSkill.name}" cannot run for you`,
          body: `It needs ${toolById(brokenSkill.blockedBy!)?.name}, which your role does not grant. Divo hides skills you cannot complete rather than failing halfway.`,
          meta: ['Shared by ' + brokenSkill.owner],
          cta: 'See why',
          onClick: () => go('access'),
        }]
      : []),
    ...requestedByMe
      .filter((a) => expiryLabel(a.expiresAt)?.expired && a.status === 'pending')
      .map((a) => ({
        tone: 'warn' as const,
        title: 'One of your requests expired unanswered',
        body: `${a.description?.summary ?? a.toolId} was never approved, so Divo stopped and did nothing.`,
        meta: [ago(a.requestedAt)],
        cta: 'Ask again',
        onClick: () => toast('Ask in Lark or raise it with your manager — Divo cannot re-open an expired request.'),
      })),
  ]

  return (
    <>
      <PageHeader
        title={`Welcome back, ${viewer}`}
        description="Everything Divo can do for you, what it can see, and what it has spent — in one place."
      />
      <div className="ws-stack">
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
                  <div style={{ marginTop: 22 }}><Spark data={usage.series.map((p) => p.spendUsd)} /></div>
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
                    <div className="ws-row click" onClick={() => go('connections')}>
                      <span className="ws-ic"><Plus size={14} /></span>
                      <div className="ws-row-main">
                        <b className="muted" style={{ fontWeight: 400 }}>
                          {CONNECTABLE.length - connected.length} more you can connect
                        </b>
                      </div>
                    </div>
                  ) : null}
                </div>
              </Fade>
            )}
          </Panel>
        </div>

        <Panel title="Recent activity" source="myRuns" aside={<button type="button" className="btn" onClick={() => go('usage')}>All activity</button>}>
          {!r3 || runsLoading ? <SkelRows n={4} icon={false} /> : runs.length === 0 ? (
            <Empty icon={Activity} title="Nothing yet" body="Runs appear here once you ask Divo to do something." />
          ) : (
            <Fade><RunList runs={runs} /></Fade>
          )}
        </Panel>
      </div>
    </>
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

/* ══ Connections ═══════════════════════════════════════
   A consent surface, not a settings page. Three questions, answered in this
   order: what will Divo see, who else can use it, how do I take it back. */
export function YouConnections({ replay, toast, go }: ScreenProps) {
  const [r1] = useStaged([320], replay)
  const [open, setOpen] = useState<Provider | null>(null)
  const { byProvider, loading, connecting, connect, disconnect } = useConnections()

  // Two gates, not one. `r1` is the staged reveal that keeps the page from
  // snapping in; `loading` is the real fetch. Showing content when only one has
  // settled would either flash empty rows or defeat the staging entirely.
  const ready = r1 && !loading

  return (
    <>
      <PageHeader
        eyebrow="Your account"
        title="Connected apps"
        description="Divo only ever acts through accounts you connect. Nothing here is shared with your company unless you share it."
      />
      <div className="ws-stack">
        <div className="ws-private">
          <ShieldCheck size={15} />
          <div>
            <b style={{ fontWeight: 500 }}>Your credentials never leave the backend.</b>{' '}
            Your admin can see that a connection exists and how it is used — never the tokens, and never your mail or files.
          </div>
        </div>

        <Panel title="Your connections" source="connections">
          {!ready ? <SkelRows n={4} /> : (
            <Fade>
              <div className="ws-rows">
                {CONNECTORS.map((def) => {
                  const status = byProvider.get(def.provider)
                  const conn = status?.connections[0]
                  const state = conn ? 'connected' : def.memberCanConnect ? 'available' : 'admin'
                  return (
                    <div className="ws-row click" key={def.provider} onClick={() => setOpen(def.provider)}>
                      <ProviderMark provider={def.provider} />
                      <div className="ws-row-main">
                        <b>
                          {def.name}
                          {conn?.ownerType === 'company' ? <span className="ws-tag">Company</span> : null}
                        </b>
                        <p>
                          {status?.error
                            ? status.error
                            : conn
                              ? `${conn.accountEmail ?? conn.label} · last used ${since(conn.lastUsedAt)}`
                              : def.blurb}
                        </p>
                      </div>
                      <div className="ws-row-act">
                        {state === 'connected' ? <span className="badge b-ok"><span className="dot" />Connected</span> : null}
                        {state === 'available' ? (
                          <button
                            type="button"
                            className="btn"
                            disabled={connecting !== null}
                            onClick={(e) => { e.stopPropagation(); void connect(def.provider) }}
                          >
                            {connecting === def.provider ? 'Waiting…' : 'Connect'}
                          </button>
                        ) : null}
                        {state === 'admin' ? <span className="ws-tag"><Lock size={11} />Admin connects this</span> : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            </Fade>
          )}
        </Panel>

        <Panel title="Health">
          <div className="ws-panel-body">
            <div className="ws-ceiling">
              <TriangleAlert size={14} />
              <div>
                <b>Divo cannot currently tell you when a connection has gone stale.</b>{' '}
                Token expiry is stored but never checked, so a dead connection keeps showing as healthy until a task fails.
                A "Reconnect" state needs that check adding first.
              </div>
            </div>
          </div>
          <div className="ws-panel-foot"><DataNote source="reconnect" /> Designed, not yet buildable</div>
        </Panel>

        <Panel>
          <div className="ws-rows">
            <div className="ws-row click" onClick={() => go('connect-flow')}>
              <span className="ws-ic"><MessageSquare size={14} /></span>
              <div className="ws-row-main">
                <b>Connecting from a Lark chat</b>
                <p>
                  What a member sees when Divo asks for an account mid-conversation, and where they land once
                  Google hands them back.
                </p>
              </div>
              <button type="button" className="btn">See the flow</button>
            </div>
          </div>
        </Panel>
      </div>

      {open ? (
        <ConnectionDrawer
          provider={open}
          connection={byProvider.get(open)?.connections[0]}
          onClose={() => setOpen(null)}
          onConnect={() => { void connect(open) }}
          onDisconnect={async (connectionId) => {
            await disconnect(open, connectionId)
            toast(`${providerName(open)} disconnected`)
            setOpen(null)
          }}
          toast={toast}
        />
      ) : null}
    </>
  )
}

/** "4 minutes ago" from an ISO timestamp, or an honest blank. */
function since(iso?: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

const onDate = (iso?: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

function ConnectionDrawer({ provider, connection, onClose, onConnect, onDisconnect, toast }: {
  provider: Provider
  connection?: LiveConnection
  onClose: () => void
  onConnect: () => void
  onDisconnect: (connectionId: string) => Promise<void>
  toast: (m: string) => void
}) {
  const def = CONNECTORS.find((c) => c.provider === provider)!
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const grants = useConnectionGrants(provider, connection?.connectionId)

  return (
    <Drawer
      title={def.name}
      subtitle={connection
        ? `${connection.accountEmail ?? connection.label} · connected ${onDate(connection.connectedAt)}`
        : def.blurb}
      onClose={onClose}
      footer={
        connection ? (
          confirming ? (
            <>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>Keep it</button>
              <button
                type="button"
                className="btn"
                style={{ color: 'var(--cur-error)', borderColor: 'var(--cur-error)' }}
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try { await onDisconnect(connection.connectionId) } finally { setBusy(false) }
                }}
              >
                {busy ? 'Disconnecting…' : 'Yes, disconnect'}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => setConfirming(true)}>Disconnect</button>
              <button type="button" className="btn primary" onClick={onClose}>Done</button>
            </>
          )
        ) : def.memberCanConnect ? (
          <button type="button" className="btn primary" onClick={() => { onConnect(); onClose() }}>
            Connect {def.name}
          </button>
        ) : (
          <button type="button" className="btn" onClick={onClose}>Close</button>
        )
      }
    >
      {confirming ? (
        <div className="ws-ceiling" style={{ marginBottom: 18 }}>
          <TriangleAlert size={14} />
          <div>
            Disconnecting removes Divo's access immediately and{' '}
            <b>revokes the {grants.length} share{grants.length === 1 ? '' : 's'} you granted</b>.
            Anything running against it will stop.
          </div>
        </div>
      ) : null}

      <div className="ws-lbl">What Divo will be able to do</div>
      <div className="ws-consent" style={{ marginTop: 12 }}>
        {def.consent.map((c) => (
          <div className="ws-consent-i" key={c.title}>
            <Eye size={14} />
            <div><b>{c.title}</b><p>{c.detail}</p></div>
          </div>
        ))}
      </div>
      {def.allOrNothing ? (
        <div className="ws-ceiling" style={{ marginTop: 14 }}>
          <TriangleAlert size={14} />
          <div>{def.allOrNothing}</div>
        </div>
      ) : null}

      {connection ? (
        <>
          <div className="ws-lbl" style={{ marginTop: 26 }}>Who else can use it</div>
          {grants.length === 0 ? (
            <div className="ws-private" style={{ marginTop: 12 }}>
              <ShieldCheck size={15} />
              <div>Only you. Nobody else in your company can act through this connection.</div>
            </div>
          ) : (
            <div className="ws-rows" style={{ marginTop: 8 }}>
              {grants.map((grant) => (
                <div className="ws-row" style={{ paddingLeft: 0, paddingRight: 0 }} key={grant.id}>
                  <div className="ws-row-main">
                    <b>{grant.granteeLabel}</b>
                    <p>{grant.granteeDetail ?? grant.granteeType} · {grant.access.replace('_', ' ')}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="ws-lbl" style={{ marginTop: 26 }}>Details</div>
          <div style={{ marginTop: 6 }}>
            <div className="kv"><span className="k">Connected</span><span className="v">{onDate(connection.connectedAt)}</span></div>
            <div className="kv"><span className="k">Last used</span><span className="v">{since(connection.lastUsedAt)}</span></div>
            <div className="kv"><span className="k">Owned by</span><span className="v">{connection.ownerType === 'company' ? 'The company' : 'You'}</span></div>
            <div className="kv"><span className="k">Sign-in method</span><span className="v">{def.auth}</span></div>
          </div>
        </>
      ) : !def.memberCanConnect ? (
        <div className="ws-ceiling" style={{ marginTop: 22 }}>
          <Lock size={14} />
          <div>
            <b>{def.name} is connected once for the whole company.</b>{' '}
            Ask a company admin to set it up, then request access to it from the Access page.
          </div>
        </div>
      ) : null}
    </Drawer>
  )
}

/* ══ Access ════════════════════════════════════════════
   The member's read-only view of their own permissions — with the one thing
   every RBAC UI omits: why. And a request path, because "I can't do X" is
   the reason most people open this page at all. */
export function YouAccess({ replay, toast }: ScreenProps) {
  const [r1, r2] = useStaged([280, 560], replay)
  const me = personById('u_ananya')!
  const grants = resolveGrants(me)
  const { can, cannot } = permissionSentence(me)
  const [requesting, setRequesting] = useState<string | null>(null)

  const blockedSkills = SKILLS.filter((s) => s.blockedBy)

  return (
    <>
      <PageHeader
        eyebrow="Your workspace"
        title="What Divo can do for you"
        description="Your access comes from your role in Finance. Where something is missing, you can ask for it."
      />
      <div className="ws-stack">
        <Panel source="permissions">
          <div className="ws-panel-body">
            {!r1 ? (
              <>
                <Skel w="92%" h={15} /><div style={{ height: 12 }} />
                <Skel w="78%" h={15} /><div style={{ height: 12 }} />
                <Skel w="46%" h={15} />
              </>
            ) : (
              <Fade>
                <p className="ws-sentence">
                  Divo can <b>{listPhrase(can, 6)}</b> on your behalf.
                </p>
                {cannot.length ? (
                  <p className="ws-sentence" style={{ marginTop: 12 }}>
                    <span className="neg">It cannot {listPhrase(cannot, 4)}.</span>
                  </p>
                ) : null}
                <p className="ws-sentence-note">
                  Almost all of this comes from the <b>Member</b> role in Finance, so it changes if your role does.
                  Sending mail as you was granted to you personally by Arjun Shah.
                </p>
              </Fade>
            )}
          </div>
        </Panel>

        {blockedSkills.length ? (
          <Panel title="Blocked for you" description="Shared skills you cannot run yet">
            {!r2 ? <SkelRows n={2} icon={false} /> : (
              <Fade>
                <div className="ws-rows">
                  {blockedSkills.map((s) => {
                    const tool = toolById(s.blockedBy!)
                    return (
                      <div className="ws-row" key={s.id}>
                        <span className="ws-ic" data-tone="warn"><Ban size={14} /></span>
                        <div className="ws-row-main">
                          <b>{s.name}</b>
                          <p>Needs <b style={{ fontWeight: 500 }}>{tool?.name}</b>, which your role does not grant. Shared by {s.owner}.</p>
                        </div>
                        <button type="button" className="btn" onClick={() => setRequesting(s.blockedBy!)}>Request access</button>
                      </div>
                    )
                  })}
                </div>
              </Fade>
            )}
            <div className="ws-panel-foot">
              <DataNote source="accessRequest" />
              No access-request model exists yet — approvals today are per-task, not standing grants
            </div>
          </Panel>
        ) : null}

        <Panel
          title="Full detail"
          description="Every tool and action, and where each one came from"
          source="permissions"
        >
          <div className="ws-panel-body">
            {!r2 ? <SkelRows n={5} icon={false} /> : (
              <Fade><Matrix grants={grants} readOnly tools={TOOLS.filter((t) => !t.adminOnly)} /></Fade>
            )}
          </div>
          <div className="ws-panel-foot">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <span className="ws-cell" data-on="true" style={{ width: 16, height: 16, pointerEvents: 'none' }} /> Allowed
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <span className="ws-cell" data-on="true" data-src="department_user_override" style={{ width: 16, height: 16, pointerEvents: 'none' }} /> Given to you personally
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <span className="ws-cell" data-locked="true" style={{ width: 16, height: 16, pointerEvents: 'none' }} /> Company policy blocks it
            </span>
          </div>
        </Panel>
      </div>

      {requesting ? (
        <Drawer
          title={`Request ${toolById(requesting)?.name}`}
          subtitle="Goes to Arjun Shah, who leads Finance"
          onClose={() => setRequesting(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRequesting(null)}>Cancel</button>
              <button type="button" className="btn primary" onClick={() => { toast('Request sent to Arjun Shah'); setRequesting(null) }}>
                Send request
              </button>
            </>
          }
        >
          <div className="ws-lbl">Why do you need it?</div>
          <textarea
            className="input"
            style={{ width: '100%', height: 96, padding: 11, marginTop: 10, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
            defaultValue="I need to run the Vendor onboarding pack skill, which files the CRM record after collecting documents."
          />
          <div className="ws-ceiling" style={{ marginTop: 16 }}>
            <TriangleAlert size={14} />
            <div>
              <b>This flow is designed, not built.</b> The backend has no access-request table —
              its approvals are tied to a single live task and expire. Making this real is net-new work.
            </div>
          </div>
        </Drawer>
      ) : null}
    </>
  )
}

/* ══ Approvals ═════════════════════════════════════════ */
export function YouApprovals({ replay, toast }: ScreenProps) {
  const [r1] = useStaged([240], replay)
  const [tab, setTab] = useState<'awaiting' | 'mine'>('awaiting')
  const { awaitingMe, requestedByMe, loading, deciding, decide } = useApprovals()
  const list = tab === 'awaiting' ? awaitingMe : requestedByMe
  const ready = r1 && !loading

  const answer = async (id: string, decision: 'approved' | 'rejected') => {
    const outcome = await decide(id, decision)
    // The same row can be resolved from a Lark card, so losing the race is a
    // normal outcome and says so — not a generic failure.
    toast(outcome.ok
      ? decision === 'approved' ? 'Approved — Divo is continuing' : 'Rejected'
      : outcome.message)
  }

  return (
    <>
      <PageHeader
        eyebrow="Decisions"
        title="Approvals"
        description="Divo pauses before anything that leaves your company or changes a record, and waits for a person."
      />
      <div className="filters">
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: 'awaiting', label: `Waiting on you (${awaitingMe.length})` },
            { value: 'mine', label: `Your requests (${requestedByMe.length})` },
          ]}
        />
      </div>
      <Panel source="approvals">
        {!ready ? <SkelRows n={2} icon={false} /> : list.length === 0 ? (
          <Empty icon={Check} title="Nothing here" body="Approvals appear when Divo needs a person to say yes." />
        ) : (
          <Fade>
            <div className="ws-attn">
              {list.map((a) => {
                const expiry = expiryLabel(a.expiresAt)
                const expired = expiry?.expired ?? false
                const pending = a.status === 'pending'
                return (
                  <div className="ws-attn-item" data-tone={expired ? 'warn' : 'act'} key={a.id}>
                    <span className="ws-attn-bar" />
                    <div className="ws-attn-main">
                      <b>{a.description?.summary ?? `${a.toolId} · ${a.action}`}</b>
                      {a.description?.detail ? <p>{a.description.detail}</p> : null}
                      <div className="ws-attn-meta">
                        <span>{toolById(a.toolId)?.name ?? a.toolId} · {a.action}</span>
                        <span>{a.requestedByName} · {ago(a.requestedAt)}</span>
                        {expiry ? (
                          <span style={expired ? { color: 'var(--cur-error)' } : undefined}>
                            <Clock size={11} style={{ marginRight: 4 }} />
                            {expired ? 'Expired' : `Expires ${expiry.text}`}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {tab === 'awaiting' && pending && !expired ? (
                      <div className="ws-row-act">
                        <button
                          type="button"
                          className="btn"
                          disabled={deciding === a.id}
                          onClick={() => void answer(a.id, 'rejected')}
                        >
                          <X size={14} />No
                        </button>
                        <button
                          type="button"
                          className="btn primary"
                          disabled={deciding === a.id}
                          onClick={() => void answer(a.id, 'approved')}
                        >
                          <Check size={14} />Approve
                        </button>
                      </div>
                    ) : (
                      <span className={`badge ${expired || a.status === 'rejected' ? 'b-err' : 'b-ok'}`}>
                        <span className="dot" />{expired ? 'Expired' : a.status}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </Fade>
        )}
      </Panel>
    </>
  )
}

/* ══ Skills ════════════════════════════════════════════ */
export function YouSkills({ replay, toast }: ScreenProps) {
  const [r1] = useStaged([300], replay)
  const [scope, setScope] = useState<'all' | 'Private' | 'Finance' | 'Company'>('all')
  const list = useMemo(() => SKILLS.filter((s) => scope === 'all' || s.scope === scope), [scope])

  return (
    <>
      <PageHeader
        eyebrow="Your workspace"
        title="Skills"
        description="Saved ways of working that Divo can repeat. Yours stay private until you share them."
        actions={<button type="button" className="btn primary" onClick={() => toast('Teach opens in the desktop app')}><Plus size={14} />Teach a skill</button>}
      />
      <div className="filters">
        <Seg
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: 'All' },
            { value: 'Private', label: 'Private' },
            { value: 'Finance', label: 'Finance' },
            { value: 'Company', label: 'Company' },
          ]}
        />
      </div>
      <Panel source="skills">
        {!r1 ? <SkelRows n={4} /> : (
          <Fade>
            <div className="ws-rows">
              {list.map((s) => (
                <div className="ws-row" key={s.id}>
                  <span className="ws-ic" data-tone={s.blockedBy ? 'warn' : undefined}>
                    {s.blockedBy ? <Ban size={14} /> : <Sparkles size={14} />}
                  </span>
                  <div className="ws-row-main">
                    <b>
                      {s.name}
                      <span className="ws-tag">{s.scope}</span>
                    </b>
                    <p>
                      {s.blurb} {s.blockedBy ? <span style={{ color: 'var(--ws-warning)' }}>· Needs {toolById(s.blockedBy)?.name}</span> : null}
                    </p>
                  </div>
                  <div className="ws-row-act">
                    <span className="ws-sub">{s.runs30d} runs</span>
                    <span className="ws-sub">{s.updated}</span>
                  </div>
                </div>
              ))}
            </div>
          </Fade>
        )}
      </Panel>
    </>
  )
}

/* ══ Usage ═════════════════════════════════════════════ */
export function YouUsage({ replay }: ScreenProps) {
  const [r1, r2] = useStaged([300, 620], replay)
  const { usage, loading } = useMyUsage(30)
  const { runs, loading: runsLoading } = useMyRuns(20)
  const ready = r1 && !loading
  const runsReady = r2 && !runsLoading
  const runChange = changePct(usage.runs, usage.previousRuns)

  return (
    <>
      <PageHeader
        eyebrow="Your workspace"
        title="Usage"
        description="What Divo has done for you and what it cost. Cost is priced from real token counts, not estimated."
      />
      <div className="ws-stack">
        <Panel title="Last 30 days" source="myUsage">
          <div className="ws-panel-body">
            {!ready ? (<><Skel w={140} h={30} /><div style={{ height: 22 }} /><Skel w="100%" h={46} /></>) : (
              <Fade>
                <div style={{ display: 'flex', gap: 44, flexWrap: 'wrap' }}>
                  <div>
                    <div className="ws-lbl">Cost</div>
                    <div className="ws-num" style={{ marginTop: 8, color: 'var(--cur-primary)' }}>{money(usage.spendUsd)}</div>
                    <div className="ws-sub" style={{ marginTop: 5 }}>{money(usage.spendTodayUsd)} today</div>
                  </div>
                  <div>
                    <div className="ws-lbl">Tasks</div>
                    <div className="ws-num" style={{ marginTop: 8 }}>{usage.runs}</div>
                    {/* Tone is not inferred from the sign. More runs is not bad
                        news, and guessing gets it backwards half the time. */}
                    <div className="ws-sub" style={{ marginTop: 5 }}>
                      {runChange >= 0 ? '+' : '−'}{Math.abs(runChange)}% on the 30 days before
                    </div>
                  </div>
                  <div>
                    <div className="ws-lbl">Tokens</div>
                    <div className="ws-num" style={{ marginTop: 8 }}>{compact(usage.tokensIn + usage.tokensOut)}</div>
                    <div className="ws-sub" style={{ marginTop: 5 }}>{usage.cacheSavingsPct}% served from cache</div>
                  </div>
                </div>
                <div style={{ marginTop: 24 }}><Spark data={usage.series.map((p) => p.spendUsd)} /></div>
                <div className="ws-sub" style={{ marginTop: 8 }}>Daily cost, last 30 days</div>
              </Fade>
            )}
          </div>
        </Panel>

        <Panel title="By model" source="myUsage">
          <div className="ws-panel-body">
            {!ready ? <SkelRows n={2} icon={false} /> : usage.byModel.length === 0 ? (
              <div className="ws-sub">Nothing recorded in this window yet.</div>
            ) : (
              <Fade>
                {usage.byModel.map((m) => (
                  <div key={m.modelId} style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{m.modelId}</span>
                      <span className="ws-sub">{m.calls} calls · {money(m.costUsd)}</span>
                    </div>
                    <Bar
                      pct={usage.spendUsd > 0 ? (m.costUsd / usage.spendUsd) * 100 : 0}
                      tone={m.modelId.includes('pro') ? 'brand' : undefined}
                    />
                  </div>
                ))}
              </Fade>
            )}
          </div>
        </Panel>

        <Panel title="All activity" source="myRuns">
          {!runsReady ? <SkelRows n={5} icon={false} /> : runs.length === 0 ? (
            <Empty icon={Activity} title="Nothing yet" body="Runs appear here once you ask Divo to do something." />
          ) : <Fade><RunList runs={runs} /></Fade>}
          <div className="ws-panel-foot">
            <CircleAlert size={13} />
            Step-by-step detail is kept for 7 days. Cost history is kept indefinitely.
          </div>
        </Panel>
      </div>
    </>
  )
}

/* ══ Memory ════════════════════════════════════════════ */
export function YouMemory({ replay, toast }: ScreenProps) {
  const [r1] = useStaged([320], replay)
  const [scope, setScope] = useState<'all' | Memory['scope']>('all')
  const [forgotten, setForgotten] = useState<string[]>([])
  const list = MEMORIES.filter((m) => (scope === 'all' || m.scope === scope) && !forgotten.includes(m.id))

  return (
    <>
      <PageHeader
        eyebrow="Your workspace"
        title="What Divo remembers"
        description="Things Divo has learned about how you work. You can forget any of them, and it stops using them immediately."
      />
      <div className="filters">
        <Seg
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: 'All' },
            { value: 'personal', label: 'Just you' },
            { value: 'department', label: 'Finance' },
            { value: 'company', label: 'Company' },
          ]}
        />
      </div>
      <Panel source="memory">
        {!r1 ? <SkelRows n={4} /> : list.length === 0 ? (
          <Empty icon={Brain} title="Nothing remembered here" body="Divo learns from what you correct and confirm." />
        ) : (
          <Fade>
            <div className="ws-rows">
              {list.map((m) => (
                <div className="ws-row" key={m.id}>
                  <span className="ws-ic"><Brain size={14} /></span>
                  <div className="ws-row-main">
                    <b style={{ fontWeight: 400 }}>{m.text}</b>
                    <p>
                      {m.scope === 'personal' ? 'Only you' : m.scope === 'department' ? 'Everyone in Finance' : 'Everyone at Acme'}
                      {' · '}learned {m.learned} · used {m.usedCount} times
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    disabled={m.scope !== 'personal'}
                    title={m.scope !== 'personal' ? 'Shared memories can only be removed by whoever shared them' : undefined}
                    onClick={() => { setForgotten((f) => [...f, m.id]); toast('Forgotten') }}
                  >
                    <Trash2 size={14} />Forget
                  </button>
                </div>
              ))}
            </div>
          </Fade>
        )}
        <div className="ws-panel-foot">
          <DataNote source="memory" />
          Memory endpoints are admin-only today — a member cannot list or delete their own
        </div>
      </Panel>
    </>
  )
}

/* ══ Settings ══════════════════════════════════════════ */
export function YouSettings({ persona, replay, toast }: ScreenProps) {
  const [r1] = useStaged([260], replay)
  const [model, setModel] = useState<'flash' | 'pro'>('flash')
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system')
  const [notify, setNotify] = useState(true)
  const me = persona === 'member' ? personById('u_ananya')! : personById('u_arjun')!

  return (
    <>
      <PageHeader eyebrow="Your account" title="Settings" description="Your profile, the model Divo uses for you, and how this app looks." />
      <div className="ws-cols">
        <div className="ws-stack">
          <Panel title="Profile" source="profile">
            <div className="ws-panel-body">
              {!r1 ? <Skel w="100%" h={120} /> : (
                <Fade>
                  <div className="profile" style={{ marginBottom: 18 }}>
                    <div className="pic">{me.initials}</div>
                    <div>
                      <h1 style={{ fontSize: 20 }}>{me.name}</h1>
                      <div className="sub">{me.email}</div>
                    </div>
                  </div>
                  <div className="kv"><span className="k">Role</span><span className="v">{me.deptRoleName} · Finance</span></div>
                  <div className="kv"><span className="k">Company</span><span className="v">Acme Technologies</span></div>
                  <div className="kv"><span className="k">Joined</span><span className="v">{me.joined}</span></div>
                  <div className="kv"><span className="k">Signed in via</span><span className="v">Lark</span></div>
                </Fade>
              )}
            </div>
            <div className="ws-panel-foot">
              <CircleAlert size={13} />
              Web sign-in does not exist yet — sessions come from Lark or a desktop handoff
            </div>
          </Panel>

          <Panel title="Model" description="Which model Divo uses when it works for you" source="profile">
            <div className="ws-panel-body">
              <div className="ws-rows">
                {[
                  { id: 'flash' as const, name: 'Flash', hint: 'Fast — everyday tasks' },
                  { id: 'pro' as const, name: 'Pro', hint: 'Deeper reasoning — slower and dearer' },
                ].map((m) => (
                  <div
                    className="ws-row click"
                    style={{ paddingLeft: 0, paddingRight: 0 }}
                    key={m.id}
                    onClick={() => { setModel(m.id); toast(`Switched to ${m.name}`) }}
                  >
                    <span className="ws-ic" data-tone={model === m.id ? 'ok' : undefined}>
                      {model === m.id ? <Check size={14} /> : null}
                    </span>
                    <div className="ws-row-main"><b>{m.name}</b><p>{m.hint}</p></div>
                  </div>
                ))}
              </div>
              <p className="ws-sub" style={{ marginTop: 14, lineHeight: 1.5 }}>
                Your admin decides which models you may pick. If only one is allowed, this section is hidden entirely.
              </p>
            </div>
          </Panel>
        </div>

        <Panel title="Appearance">
          <div className="ws-panel-body">
            <div className="ws-lbl">Theme</div>
            <div style={{ marginTop: 10 }}>
              <Seg
                value={theme}
                onChange={(v) => { setTheme(v); toast(`Theme: ${v}`) }}
                options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' }]}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 22 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Notify me when work needs me</div>
                <div className="ws-sub" style={{ marginTop: 3 }}>Approvals and blocked tasks</div>
              </div>
              <Switch on={notify} onToggle={() => setNotify((v) => !v)} label="Notifications" />
            </div>
          </div>
        </Panel>
      </div>
    </>
  )
}
