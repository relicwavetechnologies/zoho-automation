/**
 * "You" scope — what an individual employee sees, whatever their role.
 *
 * The organising idea: this is a trust and self-service surface, not an admin
 * console shrunk down. An employee comes here because something is blocked,
 * because they want to know what Divo can see, or to take access back.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  Activity, ArrowUpRight, Ban, BookOpen, Brain, Building2, Check, CircleAlert, Clock,
  ChevronRight, Eye, Gauge, Globe, Link2, Lock, MessageSquare, Plus, RotateCw, Search, ShieldCheck,
  Sparkles, Trash2, TriangleAlert, Users, X,
} from 'lucide-react'
import {
  CONNECTORS, MEMORIES, SKILLS, toolById,
  type Memory, type Persona, type Provider,
} from './fixtures'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { useTheme } from '@/lib/use-theme'
import {
  CONNECTABLE, CONNECTION_ACTIONS, LABELLED, samePolicy, scopeLabel, setActionPolicy, sharedGrants,
  useConnectionManage, useConnections,
  type AccessLevel, type ConnectionAction, type ConnectionApprovalMode, type ConnectionGovernance,
  type ConnectionGovernancePolicy, type ConnectionGrant, type GranteeType, type LiveConnection,
  type ManageCandidates,
} from './data/use-connections'
import {
  useShopifyCompanyStatus, useShopifyConnect, type ShopifyCompanyConnection, type ShopifyCompanyStatus,
} from './data/use-company-connections'
import { ago, expiryLabel, useApprovals } from './data/use-approvals'
import {
  useZohoSelfClientConnect,
  ZOHO_DATA_CENTRES,
  type ZohoSelfClientAccess,
} from './data/use-zoho-self-client'
import {
  changePct, durationLabel, useMyModelOptions, useMyRuns, useMyTools, useMyUsage, type MyRun,
} from './data/use-my-activity'
import {
  Bar, ClickRow, Confirm, DataNote, Drawer, Empty, Fade, PageHeader, Panel,
  Prompt, ProviderMark, Seg, Skel, SkelRows, Spark, Switch, compact, listPhrase, money,
  providerName, useStaged,
} from './ui'
import type { Toast } from './ui'

const initialsOf = (name: string | null, email: string) =>
  (name ?? email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('')

const COMPANY_ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Super admin', COMPANY_ADMIN: 'Company admin', MEMBER: 'Member',
}

type ScreenProps = { persona: Persona; replay: number; toast: Toast; go: (screen: string) => void }

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
    // A "this skill cannot run for you" card belongs here, but it was built from
    // fixtures — it asserted a fact about the reader's own permissions that
    // nothing had read. A wrong claim about your own access is worse than none.
    ...requestedByMe
      .filter((a) => expiryLabel(a.expiresAt)?.expired && a.status === 'pending')
      .map((a) => ({
        tone: 'warn' as const,
        title: 'One of your requests expired unanswered',
        body: `${a.description?.summary ?? a.toolId} was never approved, so Divo stopped and did nothing.`,
        meta: [ago(a.requestedAt)],
        cta: 'Ask again',
        // Nothing happened when they pressed this, so it must not arrive as a
        // green tick — the button's whole answer is that it cannot help.
        onClick: () => toast('Ask in Lark or raise it with your manager — Divo cannot re-open an expired request.', 'error'),
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
  // Which account's drawer is open — the provider alone is no longer enough
  // now that a provider can hold several.
  const [open, setOpen] = useState<{ provider: Provider; connectionId?: string } | null>(null)
  // Which provider is waiting on a name before its sign-in window opens.
  const [naming, setNaming] = useState<Provider | null>(null)
  const [shopifyOpen, setShopifyOpen] = useState(false)
  const [zohoOpen, setZohoOpen] = useState(false)
  const { byProvider, loading, unreachable, connecting, connect, disconnect, refresh } = useConnections()
  const shopifyStatus = useShopifyCompanyStatus()
  const { session } = useAdminAuth()
  // Whoever "admin connects this" refers to. The backend already decides this
  // for itself — `/zoho/authorize-url` answers 403 to anyone else — so this
  // only governs whether the button is worth offering.
  const isCompanyAdmin = session?.role === 'COMPANY_ADMIN' || session?.role === 'SUPER_ADMIN'

  /**
   * Adding an account, with a name where a name is worth having.
   *
   * Canva and Airtable hold several connections per company and their accounts
   * carry no address to tell them apart, so a second one is otherwise "Airtable"
   * next to "Airtable". Google labels itself with the Google address and Lark
   * holds one, so asking there would be a question with no answer worth giving.
   */
  const startConnect = (provider: Provider, existing: number) => {
    // Zoho takes a detour: it can be connected two different ways, and which
    // one you want is not something the button can infer.
    if (provider === 'zoho') setZohoOpen(true)
    else if (LABELLED.includes(provider) && existing > 0) setNaming(provider)
    else void connect(provider)
  }

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

        {/* Said once, at the top, instead of under every provider. When each
            row carried its own "Could not read this connection", a backend
            restart looked like six broken integrations — and the one thing a
            person could actually do about it, wait and retry, was nowhere on
            the page. */}
        {unreachable ? (
          <div className="ws-ceiling">
            <TriangleAlert size={14} />
            <div style={{ flex: 1 }}>
              <b>Divo could not be reached just now.</b>{' '}
              Nothing here has changed — this is the connection to Divo, not your connected accounts.
              {byProvider.size > 0 ? ' What you can see below is the last thing it told us.' : ''}
            </div>
            <button type="button" className="btn" onClick={() => void refresh()}>Try again</button>
          </div>
        ) : null}

        <Panel title="Your connections" source="connections">
          {!ready ? <SkelRows n={4} /> : (
            <Fade>
              <div className="ws-conns">
                {CONNECTORS.map((def) => {
                  const status = byProvider.get(def.provider)
                  const accounts = status?.connections ?? []
                  /*
                   * Two different questions, and one flag was answering both.
                   *
                   * `memberCanConnect` says whether an ordinary member may
                   * connect this for themselves. A provider connected once for
                   * the whole company answers no — but it is still connectable,
                   * by an admin, and reading the flag as "nobody may add one
                   * here" left an admin looking at Zoho with no way to add an
                   * account to the very thing they administer.
                   */
                  const canAdd = def.memberCanConnect || isCompanyAdmin
                  // Counted rather than derived from `accounts.length`: the
                  // header's job is to say how many of these actually work, and
                  // "2 accounts" over one live and one revoked is the sentence
                  // this whole change exists to stop printing.
                  const dead = accounts.filter((c) => c.reconnectRequired === true).length

                  /*
                   * Provider is a group, accounts are its rows.
                   *
                   * A provider can hold several accounts — Google keys one per
                   * Google user id — and the first attempt at this rendered a
                   * full-width "Add another X account" row after every single
                   * provider. Five of those in a flat list drowned the accounts
                   * they belonged to. The add action belongs to the provider,
                   * so it sits in the provider's own header, once.
                   */
                  return (
                    <div className="ws-conn-group" key={def.provider}>
                      <div className="ws-conn-h">
                        <ProviderMark provider={def.provider} />
                        <div className="ws-conn-h-main">
                          <b>{def.name}</b>
                          <p>
                            {status?.error
                              ? status.error
                              : accounts.length === 0
                                ? def.blurb
                                : dead === accounts.length
                                  ? `Not connected — ${dead === 1 ? 'this account needs' : `all ${dead} accounts need`} reconnecting`
                                  : `${accounts.length} account${accounts.length === 1 ? '' : 's'}${dead > 0 ? ` · ${dead} needs reconnecting` : ''}`}
                          </p>
                        </div>
                        {canAdd ? (
                          <button
                            type="button"
                            className="btn"
                            disabled={connecting !== null}
                            onClick={() => startConnect(def.provider, accounts.length)}
                          >
                            {connecting === def.provider
                              ? 'Waiting…'
                              : accounts.length === 0 ? 'Connect' : <><Plus size={13} />Add account</>}
                          </button>
                        ) : (
                          /* Shown whether or not accounts already exist. It used
                             to appear only on an empty provider, so a member
                             looking at one that already had accounts got no
                             button and no reason — a dead end that read as a
                             missing feature rather than a deliberate rule. */
                          <span className="ws-tag"><Lock size={11} />Admin connects this</span>
                        )}
                      </div>

                      {accounts.length > 0 ? (
                        <div className="ws-conn-accounts">
                          {accounts.map((conn) => (
                            <ClickRow
                              key={conn.connectionId}
                              onOpen={() => setOpen({ provider: def.provider, connectionId: conn.connectionId })}
                            >
                              <div className="ws-row-main">
                                <b>
                                  {conn.accountEmail ?? conn.label}
                                  {conn.ownerType === 'company' ? <span className="ws-tag">Company</span> : null}
                                </b>
                                <p>
                                  {conn.reconnectRequired === true
                                    ? `${def.name} ended this authorisation. Nothing can run on it until you sign in again.`
                                    : `Last used ${since(conn.lastUsedAt)}`}
                                </p>
                              </div>
                              <div className="ws-row-act">
                                {conn.reconnectRequired === true ? (
                                  <span className="badge b-err"><span className="dot" />Reconnect</span>
                                ) : null}
                                <span className="ws-sub">Manage</span>
                                <ChevronRight size={14} className="muted" />
                              </div>
                            </ClickRow>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
                <ShopifyConnectionGroup status={shopifyStatus} onOpen={() => setShopifyOpen(true)} />
              </div>
            </Fade>
          )}
        </Panel>

        <Panel title="Health">
          <div className="ws-panel-body">
            <div className="ws-ceiling">
              <TriangleAlert size={14} />
              <div>
                <b>A connection is marked "Reconnect" the first time the provider refuses it — not before.</b>{' '}
                Google and Shopify say outright when they have ended an authorisation, and Divo writes that down the
                moment it hears it, so the account above stops claiming to work. The other providers give no such
                answer yet: theirs stay listed as working until something run against them fails.
              </div>
            </div>
          </div>
          <div className="ws-panel-foot"><DataNote source="reconnect" /> Live for Google and Shopify</div>
        </Panel>

        <Panel>
          <div className="ws-rows">
            <ClickRow onOpen={() => go('connect-flow')}>
              <span className="ws-ic"><MessageSquare size={14} /></span>
              <div className="ws-row-main">
                <b>Connecting from a Lark chat</b>
                <p>
                  What a member sees when Divo asks for an account mid-conversation, and where they land once
                  Google hands them back.
                </p>
              </div>
              <button type="button" className="btn">See the flow</button>
            </ClickRow>
          </div>
        </Panel>
      </div>

      {naming ? (
        <Prompt
          title={`Name this ${providerName(naming)} account`}
          description={`You already have one. A name is how you and Divo tell them apart afterwards — "Marketing", "Client work". Leave it blank to let Divo name it.`}
          label="Name"
          placeholder="Marketing"
          confirm="Continue to sign-in"
          optional
          onClose={() => setNaming(null)}
          onConfirm={(label) => { void connect(naming, label ? { label } : undefined) }}
        />
      ) : null}

      {open ? (
        <ConnectionDrawer
          provider={open.provider}
          connection={byProvider.get(open.provider)?.connections.find((c) => c.connectionId === open.connectionId)}
          onClose={() => setOpen(null)}
          onConnect={() => { void connect(open.provider) }}
          // Same authorize hop as a first connection. The backend keys a Google
          // connection by Google account, so re-approving the same one updates
          // it in place rather than making a second row.
          onReconnect={() => { void connect(open.provider) }}
          onDisconnect={async (connectionId) => {
            await disconnect(open.provider, connectionId)
            toast(`${providerName(open.provider)} disconnected`)
            setOpen(null)
          }}
          toast={toast}
        />
      ) : null}

      {shopifyOpen ? (
        <ShopifyConnectDialog
          toast={toast}
          onClose={() => setShopifyOpen(false)}
          onConnected={shopifyStatus.refresh}
        />
      ) : null}

      {zohoOpen ? (
        <ZohoConnectDialog
          toast={toast}
          onClose={() => setZohoOpen(false)}
          onOAuth={() => { setZohoOpen(false); void connect('zoho') }}
          onConnected={refresh}
        />
      ) : null}
    </>
  )
}

function ShopifyConnectionGroup({ status, onOpen }: {
  status: {
    status: ShopifyCompanyStatus | null
    loading: boolean
    failed: boolean
  }
  onOpen: () => void
}) {
  const accounts = status.status?.connections ?? []
  const canManage = status.status?.canManage === true
  const dead = accounts.filter((c) => c.reconnectRequired === true).length
  return (
    <div className="ws-conn-group">
      <div className="ws-conn-h">
        <span className="ws-ic" aria-hidden>
          <span style={{ fontSize: 12, fontWeight: 600 }}>S</span>
        </span>
        <div className="ws-conn-h-main">
          <b>Shopify</b>
          <p>
            {status.loading
              ? 'Loading Shopify stores…'
              : status.failed
                ? 'Could not read Shopify connections.'
                : accounts.length === 0
                  ? 'Company-owned store access. Save Dev Dashboard credentials once; Divo keeps tokens refreshed.'
                  : `${accounts.length} store${accounts.length === 1 ? '' : 's'}${dead > 0 ? ` · ${dead} needs reconnecting` : ''}`}
          </p>
        </div>
        {canManage ? (
          <button type="button" className="btn" onClick={onOpen}>
            {accounts.length === 0 ? 'Connect' : <><Plus size={13} />Add store</>}
          </button>
        ) : accounts.length === 0 ? (
          <span className="ws-tag"><Lock size={11} />Admin connects this</span>
        ) : null}
      </div>

      {accounts.length > 0 ? (
        <div className="ws-conn-accounts">
          {accounts.map((conn) => (
            <div className="ws-row" key={conn.connectionId}>
              <div className="ws-row-main">
                <b>
                  {shopifyConnectionLabel(conn)}
                  <span className="ws-tag">Company</span>
                </b>
                <p>
                  {conn.reconnectRequired === true
                    ? 'Shopify ended this authorisation. Nothing can run on it until an admin connects it again.'
                    : `Last used ${since(conn.lastUsedAt)}`}
                </p>
              </div>
              <div className="ws-row-act">
                {conn.reconnectRequired === true ? (
                  <span className="badge b-err"><span className="dot" />Reconnect</span>
                ) : null}
                {canManage ? <span className="ws-sub">Managed by admins</span> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function shopifyConnectionLabel(connection: ShopifyCompanyConnection): string {
  return connection.accountName ?? connection.label
}

function normalizeShopDomainInput(value: string): string | null {
  const domain = value.trim().toLowerCase()
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(domain) ? domain : null
}

function ShopifyConnectDialog({ toast, onClose, onConnected }: {
  toast: Toast
  onClose: () => void
  onConnected: () => void | Promise<void>
}) {
  const shopify = useShopifyConnect()
  const [shopDomain, setShopDomain] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [label, setLabel] = useState('')

  const finish = async () => {
    const normalized = normalizeShopDomainInput(shopDomain)
    if (!normalized) {
      toast('Use the permanent .myshopify.com store domain', 'error')
      return
    }
    if (!clientId.trim() || !clientSecret.trim()) {
      toast('Enter the Shopify client ID and secret', 'error')
      return
    }
    try {
      const result = await shopify.connect({
        shopDomain: normalized,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
      })
      await onConnected()
      toast(`Shopify connected: ${result.shopName || result.shopDomain}`)
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save Shopify connection', 'error')
    }
  }

  return (
    <>
      <div className="ws-scrim" onClick={onClose} />
      <div className="ws-modal-wrap">
        <div className="ws-modal" role="dialog" aria-label="Connect Shopify">
          <div className="ws-modal-h">
            <h2>Connect Shopify</h2>
            <p>Verify a store with Dev Dashboard credentials. Divo keeps the Admin API token refreshed server-side.</p>
          </div>
          <div className="ws-modal-b">
            <div className="ws-lbl">Shopify store domain</div>
            <input
              className="input"
              autoFocus
              value={shopDomain}
              maxLength={255}
              placeholder="your-store.myshopify.com"
              onChange={(e) => setShopDomain(e.target.value)}
              style={{ width: '100%', marginTop: 8 }}
            />
            <div className="ws-lbl" style={{ marginTop: 18 }}>Client ID</div>
            <input
              className="input"
              value={clientId}
              maxLength={255}
              placeholder="Shopify app client ID"
              onChange={(e) => setClientId(e.target.value)}
              style={{ width: '100%', marginTop: 8 }}
            />
            <div className="ws-lbl" style={{ marginTop: 18 }}>Client secret</div>
            <input
              className="input"
              type="password"
              value={clientSecret}
              maxLength={4000}
              placeholder="Shopify app client secret"
              onChange={(e) => setClientSecret(e.target.value)}
              style={{ width: '100%', marginTop: 8 }}
            />
            <div className="ws-lbl" style={{ marginTop: 18 }}>Connection name</div>
            <input
              className="input"
              value={label}
              maxLength={255}
              placeholder="Optional"
              onChange={(e) => setLabel(e.target.value)}
              style={{ width: '100%', marginTop: 8 }}
            />
            <p className="ws-sentence-note">
              Credentials go straight to the backend. Stored tokens and secrets are encrypted and never shown here.
            </p>
          </div>
          <div className="ws-modal-f">
            <button type="button" className="btn" onClick={onClose} disabled={shopify.saving}>Cancel</button>
            <button type="button" className="btn primary" disabled={shopify.saving || !shopDomain.trim() || !clientId.trim() || !clientSecret.trim()} onClick={() => void finish()}>
              {shopify.saving ? 'Checking…' : 'Verify and save'}
            </button>
          </div>
        </div>
      </div>
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

/* ── Operating rules ──────────────────────────────────── */

/**
 * The six actions, named for whoever owns the account rather than for the API.
 *
 * "execute" is the backend's word for running something the tool exposes — a
 * script, an automation — and nobody connecting a Canva account thinks of it
 * that way.
 */
const ACTION_COPY: Record<ConnectionAction, { label: string; detail: string }> = {
  read: { label: 'Looking things up', detail: 'Reading mail, files, records — anything it only needs to see.' },
  create: { label: 'Making something new', detail: 'A new document, record, event or design.' },
  update: { label: 'Changing something', detail: 'Editing something that already exists.' },
  delete: { label: 'Deleting something', detail: 'Removing something for good.' },
  send: { label: 'Sending something out', detail: 'Mail, messages — anything that leaves the account.' },
  execute: { label: 'Running something', detail: 'Scripts and automations the account can trigger.' },
}

/**
 * Who Divo waits for, before it does the thing.
 *
 * The backend's `connection_owner` is a role, not a person, so the label has to
 * follow who is reading it: the same rule reads "me" to the person who
 * connected the account and "whoever connected it" to an admin looking at
 * somebody else's.
 */
const approverOptions = (isOwner: boolean): { value: ConnectionApprovalMode; label: string }[] => [
  { value: 'connection_owner', label: isOwner ? 'Me' : 'Whoever connected it' },
  { value: 'company_admin', label: 'A company admin' },
]

/**
 * Rules that apply to everybody using this connection — including the people
 * it has been shared with.
 *
 * This is not access. Access is the section below; this is what Divo has to
 * stop and ask about once somebody has it. The two were the same control on
 * every version of this screen before, and conflating them is how you end up
 * with an approval rule that quietly grants somebody a tool.
 *
 * Rate caps are enforced by the backend but not edited here. Six numbers per
 * action, per connection, buried the one control anybody actually reaches for.
 */
function OperatingRules({ governance, isOwner, saving, onSave }: {
  governance: ConnectionGovernance
  isOwner: boolean
  saving: boolean
  onSave: (policy: ConnectionGovernancePolicy) => Promise<void>
}) {
  const [draft, setDraft] = useState<ConnectionGovernancePolicy>(governance.managerPolicy)

  // The saved policy is the source of truth. Re-seeding on it means a save, or
  // somebody else's save arriving on a refetch, resets the draft rather than
  // leaving edits floating over a policy that has moved underneath them.
  useEffect(() => { setDraft(governance.managerPolicy) }, [governance.managerPolicy])

  const dirty = !samePolicy(draft, governance.managerPolicy)
  const overridden = governance.adminOverride !== null

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 26 }}>
        <span className="ws-lbl">What Divo must ask about</span>
        {overridden ? <span className="ws-prov" data-src="company_default">Company rules apply</span> : null}
      </div>

      {overridden ? (
        <div className="ws-ceiling" style={{ marginTop: 10 }}>
          <ShieldCheck size={14} />
          <div>
            A company admin has set their own rules for this connection, and those win. What you set here
            stays saved and takes over again if they drop theirs.
          </div>
        </div>
      ) : null}

      <p className="ws-sentence-note" style={{ marginTop: 10 }}>
        These apply to everyone using this connection, you included. They never give anybody access —
        that is the next section.
      </p>

      <div className="ws-rows" style={{ marginTop: 8 }}>
        {CONNECTION_ACTIONS.map((action) => {
          const policy = draft.actions[action] ?? { mode: 'inherit' as const }
          const enforced = policy.mode === 'enforced'
          return (
            <div className="ws-row" style={{ paddingLeft: 0, paddingRight: 0, alignItems: 'flex-start' }} key={action}>
              <div className="ws-row-main">
                <b style={{ fontWeight: 400 }}>{ACTION_COPY[action].label}</b>
                <p>{ACTION_COPY[action].detail}</p>
                {enforced ? (
                  <div style={{ marginTop: 10 }}>
                    <Seg
                      value={policy.approval ?? 'connection_owner'}
                      onChange={(v) => setDraft((d) => setActionPolicy(d, action, { approval: v }))}
                      options={approverOptions(isOwner)}
                    />
                  </div>
                ) : null}
              </div>
              <div className="ws-row-act">
                <Seg
                  value={policy.mode}
                  onChange={(mode) => setDraft((d) => setActionPolicy(d, action, { mode }))}
                  options={[
                    { value: 'inherit', label: 'Just do it' },
                    { value: 'enforced', label: 'Ask first' },
                  ]}
                />
              </div>
            </div>
          )
        })}
      </div>

      {dirty ? (
        <div className="ws-diff" style={{ marginTop: 14 }}>
          <div className="ws-diff-h">Rules changed, not saved yet</div>
          <div className="ws-diff-f">
            <button
              type="button"
              className="btn"
              disabled={saving}
              onClick={() => setDraft(governance.managerPolicy)}
            >
              Discard
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={saving}
              onClick={() => void onSave(draft)}
            >
              {saving ? 'Saving…' : 'Save rules'}
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}

/**
 * Everybody who can act through this account, in one list.
 *
 * The owner is a row rather than a footnote: they are the person with the most
 * access and the one somebody scanning this list is trying to place. Grants to
 * a department, a role or the whole company sit alongside, because "Finance"
 * having access is exactly as important as one named person having it — and
 * more easily forgotten.
 */
function AccessList({ owner, grants, busy, onRevoke }: {
  owner: { id: string; email: string; name: string | null } | null
  grants: ConnectionGrant[]
  busy: boolean
  onRevoke: (grant: ConnectionGrant) => Promise<void>
}) {
  const { session } = useAdminAuth()
  const GRANTEE_ICON: Record<GranteeType, typeof Users> = {
    user: Users, department: Building2, role: ShieldCheck, company: Globe,
  }

  return (
    <div className="ws-rows" style={{ marginTop: 8 }}>
      {owner ? (
        <div className="ws-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
          <span className="ws-ic" data-tone="ok"><Users size={14} /></span>
          <div className="ws-row-main">
            <b>
              {owner.id === session?.userId ? 'You' : owner.name ?? owner.email}
              <span className="ws-tag">Owner</span>
            </b>
            <p>Connected the account. Full access, and cannot be revoked without disconnecting it.</p>
          </div>
        </div>
      ) : null}

      {grants.map((grant) => {
        const Icon = GRANTEE_ICON[grant.granteeType]
        return (
          <div className="ws-row" style={{ paddingLeft: 0, paddingRight: 0 }} key={grant.id}>
            <span className="ws-ic"><Icon size={14} /></span>
            <div className="ws-row-main">
              <b>{grant.granteeLabel}</b>
              <p>
                {grant.granteeDetail ?? GRANTEE_NOUN[grant.granteeType]} · {grant.access.replace(/_/g, ' ')}
                {grant.grantedBy
                  ? ` · shared by ${grant.grantedBy.id === session?.userId ? 'you' : grant.grantedBy.name ?? grant.grantedBy.email}`
                  : ''}
              </p>
            </div>
            <button
              type="button"
              className="btn"
              disabled={busy}
              title={`Stop ${grant.granteeLabel} acting through this connection`}
              onClick={() => void onRevoke(grant)}
            >
              <Trash2 size={14} />Revoke
            </button>
          </div>
        )
      })}
    </div>
  )
}

const GRANTEE_NOUN: Record<GranteeType, string> = {
  user: 'One person', department: 'Everyone in this team', role: 'Everyone with this role', company: 'Everyone in the company',
}

/**
 * Granting somebody else the use of your connection.
 *
 * Four kinds of grantee, because that is what the backend stores: a person, a
 * department, a role, or the whole company. They are genuinely different
 * decisions — "Ananya" is a person leaving next month, "Finance" is whoever is
 * in Finance at the time — so the type is picked first and the search is scoped
 * to it rather than mixing all four into one list.
 *
 * The access levels come from the route, never from a constant here. Zoho
 * collapses to read-only when its own scopes are read-only, and offering
 * "Read/write" in that case would be a choice the backend then refuses.
 */
function GrantAccess({ candidates, accessLevels, busy, onGrant }: {
  candidates: ManageCandidates
  accessLevels: AccessLevel[]
  busy: boolean
  onGrant: (type: GranteeType, id: string, access: string, label: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<GranteeType>('user')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null)
  const [access, setAccess] = useState(accessLevels[0]?.value ?? 'read_only')

  const options = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (label: string, detail?: string) =>
      !q || label.toLowerCase().includes(q) || (detail ?? '').toLowerCase().includes(q)
    if (type === 'user') {
      return candidates.users
        .filter((u) => match(u.name ?? u.email, u.email))
        .map((u) => ({ id: u.id, label: u.name ?? u.email, detail: u.email }))
    }
    if (type === 'department') {
      return candidates.departments.filter((d) => match(d.name)).map((d) => ({ id: d.id, label: d.name, detail: d.slug }))
    }
    if (type === 'role') {
      return candidates.roles
        .filter((r) => match(r.name, r.department))
        .map((r) => ({ id: r.id, label: r.name, detail: r.department ?? 'Company role' }))
    }
    // The company is a single target, so there is nothing to search.
    return candidates.company ? [{ id: candidates.company.id, label: candidates.company.name, detail: 'Everyone' }] : []
  }, [type, query, candidates])

  if (!open) {
    return (
      <div style={{ marginTop: 14 }}>
        <button type="button" className="ws-linkish" onClick={() => setOpen(true)}>
          <Plus size={13} />Share with someone
        </button>
      </div>
    )
  }

  return (
    <div className="ws-panel" style={{ marginTop: 14 }}>
      <div className="ws-panel-body">
        <div className="ws-lbl">Share with</div>
        <div style={{ marginTop: 8 }}>
          <Seg
            value={type}
            onChange={(v) => { setType(v as GranteeType); setPicked(null); setQuery('') }}
            options={[
              { value: 'user', label: 'A person' },
              { value: 'department', label: 'A team' },
              { value: 'role', label: 'A role' },
              { value: 'company', label: 'Everyone' },
            ]}
          />
        </div>

        {type !== 'company' ? (
          <div className="search" style={{ marginTop: 12 }}>
            <Search size={14} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search`} />
          </div>
        ) : null}

        <div className="ws-rows" style={{ marginTop: 8, maxHeight: 210, overflowY: 'auto' }}>
          {options.length === 0 ? (
            <div className="ws-panel-body ws-sub">Nothing matches.</div>
          ) : options.map((o) => (
            <ClickRow
              key={o.id}
              style={{ paddingLeft: 0, paddingRight: 0 }}
              onOpen={() => setPicked({ id: o.id, label: o.label })}
            >
              <div className="ws-row-main"><b>{o.label}</b><p>{o.detail}</p></div>
              {picked?.id === o.id ? <Check size={14} /> : null}
            </ClickRow>
          ))}
        </div>

        <div className="ws-lbl" style={{ marginTop: 18 }}>They may</div>
        <div style={{ marginTop: 8 }}>
          <Seg
            value={access}
            onChange={setAccess}
            options={accessLevels.map((a) => ({ value: a.value, label: a.label }))}
          />
        </div>
        <p className="ws-sentence-note">
          {accessLevels.find((a) => a.value === access)?.description}
        </p>

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={() => { setOpen(false); setPicked(null) }}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!picked || busy}
            onClick={async () => {
              if (!picked) return
              await onGrant(type, picked.id, access, picked.label)
              setOpen(false); setPicked(null); setQuery('')
            }}
          >
            {busy ? 'Sharing…' : 'Share'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConnectionDrawer({ provider, connection, onClose, onConnect, onReconnect, onDisconnect, toast }: {
  provider: Provider
  connection?: LiveConnection
  onClose: () => void
  onConnect: () => void
  onReconnect: () => void
  onDisconnect: (connectionId: string) => Promise<void>
  toast: Toast
}) {
  const { session } = useAdminAuth()
  const def = CONNECTORS.find((c) => c.provider === provider)!
  const [confirming, setConfirming] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const manage = useConnectionManage(provider, connection?.connectionId)
  const owner = manage.data?.connection.ownerUser ?? null
  // Connecting an account also writes a grant to whoever connected it, which
  // is bookkeeping rather than access — ownership already gives them admin. It
  // showed the owner twice, the second time with a Revoke button that would
  // have taken away nothing.
  const grants = sharedGrants(manage.data?.grants ?? [], owner?.id)
  // Whether the reader is the person who connected the account, which changes
  // how the approval rules read — "me" rather than "whoever connected it".
  const isOwner = owner !== null && owner.id === session?.userId
  const scopes = manage.data?.connection.scopes ?? connection?.scopes ?? []

  return (
    <>
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
            {/* The count only appears once the grants have actually been read.
                While that read is in flight, or refused, `grants` is empty for
                reasons that have nothing to do with how many shares exist —
                and "revokes the 0 shares you granted" is a promise about
                somebody's access made from no evidence. */}
            Disconnecting removes Divo's access immediately{' '}
            {manage.data
              ? <>and <b>revokes the {grants.length} share{grants.length === 1 ? '' : 's'} you granted</b>. </>
              : <>and revokes <b>every share you granted</b>. </>}
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
          {/* One gate for everything the manage route feeds: the rules, the
              access list and the sharing editor. A 403 here is a real answer —
              only the owner or a company admin may read it — and rendering an
              empty rules panel to somebody who simply may not see it would
              read as "no rules are set". */}
          {manage.loading ? <SkelRows n={3} icon={false} /> : manage.refused ? (
            <div className="ws-ceiling" style={{ marginTop: 22 }}>
              <Lock size={14} />
              <div>Only whoever connected this account, or a company admin, can see and change how it is used.</div>
            </div>
          ) : manage.error ? (
            <div className="ws-ceiling" style={{ marginTop: 22 }}>
              <TriangleAlert size={14} />
              <div>{manage.error}</div>
            </div>
          ) : manage.data ? (
            <>
              <OperatingRules
                governance={manage.data.governance}
                isOwner={isOwner}
                saving={manage.saving}
                onSave={async (policy) => {
                  try { await manage.saveGovernance(policy); toast('Rules saved') }
                  catch { toast('Could not save those rules', 'error') }
                }}
              />

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 26 }}>
                <span className="ws-lbl">Who can use it</span>
                {manage.saving ? <span className="ws-sub">Saving…</span> : null}
              </div>

              {/* Sharing is a real editor, not a read-out. The routes to grant
                  and revoke have always existed and the desktop has always used
                  them; this screen listed the grants and offered no way to
                  change them, so the only way to share your own connection was
                  to open the desktop app. */}
              {grants.length === 0 ? (
                <div className="ws-private" style={{ marginTop: 10 }}>
                  <ShieldCheck size={15} />
                  <div>
                    {isOwner || !owner
                      ? 'Only you. Nobody else in your company can act through this connection.'
                      : `Only ${owner.name ?? owner.email}. Nobody else can act through this connection.`}
                  </div>
                </div>
              ) : (
                <AccessList
                  owner={owner}
                  grants={grants}
                  busy={manage.saving}
                  onRevoke={async (grant) => {
                    try { await manage.revoke(grant.id); toast(`${grant.granteeLabel} can no longer use it`) }
                    catch { toast('Could not revoke that access', 'error') }
                  }}
                />
              )}

              <GrantAccess
                candidates={manage.data.candidates}
                accessLevels={manage.data.accessLevels}
                busy={manage.saving}
                onGrant={async (type, id, access, label) => {
                  try { await manage.grant(type, id, access); toast(`${label} can now use it`) }
                  catch { toast('Could not share this connection', 'error') }
                }}
              />
            </>
          ) : null}

          {/* The scopes the account actually granted, rather than the static
              copy above. The two can disagree — an older connection carries
              whatever was asked for when it was made — and the granted list is
              the one that decides what Divo can really reach. */}
          {scopes.length ? (
            <>
              <div className="ws-lbl" style={{ marginTop: 26 }}>What this account granted</div>
              <div className="ws-perms" style={{ marginTop: 8 }}>
                {scopes.map((scope) => (
                  <span className="ws-perm" key={scope} title={scope}>{scopeLabel(scope)}</span>
                ))}
              </div>
              <p className="ws-sentence-note">
                Straight from the sign-in. Reconnect below to widen or narrow it.
              </p>
            </>
          ) : null}

          <div className="ws-lbl" style={{ marginTop: 26 }}>Details</div>
          <div style={{ marginTop: 6 }}>
            <div className="kv"><span className="k">Connected</span><span className="v">{onDate(connection.connectedAt)}</span></div>
            <div className="kv"><span className="k">Last used</span><span className="v">{since(connection.lastUsedAt)}</span></div>
            <div className="kv">
              <span className="k">Owned by</span>
              <span className="v">
                {connection.ownerType === 'company'
                  ? 'The company'
                  : owner && !isOwner ? owner.name ?? owner.email : 'You'}
              </span>
            </div>
            <div className="kv"><span className="k">Sign-in method</span><span className="v">{def.auth}</span></div>
          </div>

          {/* Reconnect is not repair — nothing here can tell a stale token from
              a live one. It is how you change what was granted, which is the
              only reason to sign in again to an account that already works. */}
          {def.memberCanConnect ? (
            <div className="ws-rows" style={{ marginTop: 20 }}>
              <div className="ws-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
                <div className="ws-row-main">
                  <b>Sign in again</b>
                  <p>
                    To change what Divo may reach, or after revoking access at {def.name}.
                    Pick the same account — a different one is added alongside rather than replacing this.
                  </p>
                </div>
                <button type="button" className="btn" onClick={() => setReconnecting(true)}>
                  <RotateCw size={14} />Reconnect
                </button>
              </div>
            </div>
          ) : null}
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

    {reconnecting ? (
      <Confirm
        title={`Sign in to ${def.name} again?`}
        body={`A ${def.name} window opens. Choose ${connection?.accountEmail ?? 'the same account'} — whatever you approve replaces what Divo may reach through it. Choosing a different account adds that one instead, and leaves this connection alone.`}
        confirm="Open sign-in"
        onClose={() => setReconnecting(false)}
        onConfirm={() => { onReconnect() }}
      />
    ) : null}
    </>
  )
}

/* ══ Access ════════════════════════════════════════════
   The member's read-only view of their own permissions — with the one thing
   every RBAC UI omits: why. And a request path, because "I can't do X" is
   the reason most people open this page at all. */
/**
 * What Divo may do for the signed-in person.
 *
 * Read from the tool inventory, which reports per tool the actions this person
 * can *actually* use, and where each grant came from — global (their company
 * role) or a named department. That provenance is the answer to "why can I do
 * this", which is the only question this screen exists to settle.
 */
export function YouAccess({ replay }: ScreenProps) {
  const { session } = useAdminAuth()
  const [r1, r2] = useStaged([280, 560], replay)
  const { inventory, loading, failed, refresh } = useMyTools()

  const usable = inventory.filter((entry) => entry.allowedActions.length > 0)
  const can = usable.flatMap((entry) =>
    entry.allowedActions.map((a) => entry.actionLabels[a] ?? `${a} ${entry.tool.name}`))
  // Worth naming: a tool this person holds no action on at all, which is the
  // shape of "why did Divo say it could not do that".
  const withheld = inventory.filter((entry) => entry.allowedActions.length === 0 && entry.configurable)
  const needsConnection = inventory.filter((entry) => entry.readiness === 'connection_required')

  const departmentGrants = usable.filter((e) => e.origins.some((o) => o.kind === 'department'))
  const departmentNames = Array.from(new Set(
    departmentGrants.flatMap((e) => e.origins.filter((o) => o.kind === 'department').map((o) => o.departmentName!)),
  ))

  return (
    <>
      <PageHeader
        eyebrow="Your workspace"
        title="What Divo can do for you"
        description="Your access comes from your company role and from the departments you are in. Where something is missing, ask whoever leads that team."
      />
      <div className="ws-stack">
        <Panel source="permissions">
          <div className="ws-panel-body">
            {!r1 || loading ? (
              <>
                <Skel w="92%" h={15} /><div style={{ height: 12 }} />
                <Skel w="78%" h={15} /><div style={{ height: 12 }} />
                <Skel w="46%" h={15} />
              </>
            ) : failed ? (
              // Every sentence below is derived from the inventory, so with no
              // inventory they would all say the same wrong thing: that this
              // person holds nothing and belongs to no department. The route
              // answers every signed-in member, so this is never a permission
              // problem — it is something to retry.
              <Empty
                icon={TriangleAlert}
                title="Could not read your access"
                body="This is a broken request, not a restriction — nothing about what you can do has changed."
                action={<button type="button" className="btn" onClick={refresh}>Try again</button>}
              />
            ) : (
              <Fade>
                {can.length ? (
                  <p className="ws-sentence">Divo can <b>{listPhrase(can, 6)}</b> on your behalf.</p>
                ) : (
                  <p className="ws-sentence">Divo cannot do anything on your behalf yet.</p>
                )}
                {withheld.length ? (
                  <p className="ws-sentence" style={{ marginTop: 12 }}>
                    <span className="neg">
                      It cannot use {listPhrase(withheld.map((e) => e.tool.name), 4)}.
                    </span>
                  </p>
                ) : null}
                <p className="ws-sentence-note">
                  {departmentNames.length
                    ? <>Most of this comes from your role in <b>{listPhrase(departmentNames, 3)}</b>, so it changes if your role does.</>
                    : <>You are in no department, so everything here comes from your company role alone.</>}
                  {session?.role === 'MEMBER' ? '' : ' Being an admin does not by itself grant tools — those still come from a department.'}
                </p>
              </Fade>
            )}
          </div>
        </Panel>

        {needsConnection.length ? (
          <Panel title="Waiting on a connection" description="Granted to you, but Divo has nothing to act through">
            {!r2 ? <SkelRows n={2} icon={false} /> : (
              <Fade>
                <div className="ws-rows">
                  {needsConnection.map((entry) => (
                    <div className="ws-row" key={entry.tool.toolId}>
                      <span className="ws-ic" data-tone="warn"><Ban size={14} /></span>
                      <div className="ws-row-main">
                        <b>{entry.tool.name}</b>
                        <p>
                          You have permission, but no account is connected — so every step that needs it stops.
                          Connect it from <b>Connected apps</b>.
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </Fade>
            )}
          </Panel>
        ) : null}

        <Panel
          title="Full detail"
          description="Every tool and action, and where each one came from"
          source="permissions"
        >
          <div className="ws-panel-body">
            {!r2 || loading ? <SkelRows n={5} icon={false} /> : failed ? (
              <Empty
                icon={TriangleAlert}
                title="Could not read your tools"
                body="The list is unavailable right now. This says nothing about what you hold."
                action={<button type="button" className="btn" onClick={refresh}>Try again</button>}
              />
            ) : inventory.length === 0 ? (
              <Empty title="Nothing is configured for you" body="Divo has no tools it may use on your behalf." />
            ) : (
              <Fade>
                <div className="ws-rows">
                  {inventory.map((entry) => (
                    <div className="ws-row" key={entry.tool.toolId} style={{ alignItems: 'flex-start' }}>
                      <div className="ws-row-main">
                        <b>
                          {entry.tool.name}
                          {entry.readiness === 'connection_required'
                            ? <span className="ws-prov" data-src="department_user_override">Needs a connection</span>
                            : null}
                        </b>
                        <p>
                          {entry.allowedActions.length
                            ? entry.allowedActions.map((a) => entry.actionLabels[a] ?? a).join(' · ')
                            : 'Nothing — no role you hold grants this'}
                        </p>
                        {entry.origins.length ? (
                          <div className="ws-attn-meta" style={{ marginTop: 7 }}>
                            {entry.origins.map((o, i) => (
                              <span key={i}>
                                {o.kind === 'department' ? `via ${o.departmentName}` : o.kind === 'global' ? 'via your company role' : o.kind}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </Fade>
            )}
          </div>
          <div className="ws-panel-foot">
            A tool with no actions is not hidden — knowing Divo *could* do something if you were granted it is
            usually why someone asks.
          </div>
        </Panel>
      </div>
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
                    // The row is a fixture and there is no route to delete a
                    // memory, so "Forgotten" was a claim about Divo that
                    // nothing backed. It hides the sample row and says so.
                    onClick={() => { setForgotten((f) => [...f, m.id]); toast('Hidden here only — nothing was deleted, because this panel is sample data', 'error') }}
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
export function YouSettings({ persona, replay }: ScreenProps) {
  const [r1] = useStaged([260], replay)
  const { session } = useAdminAuth()
  const { allowedModels, loading: modelsLoading } = useMyModelOptions()
  // The one real theme in the app — the same hook the topbar toggle uses, and
  // the same stored value. This panel used to hold its own `useState`, so it
  // always opened on "System" whatever was actually set, and picking one
  // toasted a change that never left the component.
  const { theme, setTheme } = useTheme()

  /*
   * The model list is read-only, and that is not a shortcut.
   *
   * No route stores a member's model preference — the proxy resolves it from
   * the grant on every call. The panel used to render each model as a clickable
   * row that toasted "Switched to Pro", which persisted nothing, survived
   * nothing, and left no model marked as current. Stating what they are allowed
   * to use, and who decides, is the whole truth available here.
   */

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
                    <div className="pic">{initialsOf(session?.name ?? null, session?.email ?? '')}</div>
                    <div>
                      <h1 style={{ fontSize: 20 }}>{session?.name ?? session?.email ?? '—'}</h1>
                      <div className="sub">{session?.email}</div>
                    </div>
                  </div>
                  <div className="kv">
                    <span className="k">Role</span>
                    <span className="v">{COMPANY_ROLE_LABEL[session?.role ?? ''] ?? session?.role ?? '—'}</span>
                  </div>
                  <div className="kv"><span className="k">Company</span><span className="v">{session?.companyName ?? '—'}</span></div>
                  {/* Departments decide what Divo may do; the company role alone
                      grants nothing, which is the part people get wrong. */}
                  <div className="kv">
                    <span className="k">{(session?.departments.length ?? 0) === 1 ? 'Department' : 'Departments'}</span>
                    <span className="v">
                      {session?.departments.length
                        ? session.departments.map((d) => `${d.name} · ${d.roleName}`).join(', ')
                        : 'None'}
                    </span>
                  </div>
                </Fade>
              )}
            </div>
            <div className="ws-panel-foot">
              <CircleAlert size={13} />
              One account across the web, Lark and the desktop — change it and it changes everywhere
            </div>
          </Panel>

          <Panel title="Model" description="Which model Divo uses when it works for you" source="profile">
            <div className="ws-panel-body">
              {modelsLoading ? <SkelRows n={2} icon={false} /> : allowedModels.length === 0 ? (
                // Reached both when every model is switched off and when the
                // read failed, and the hook cannot currently tell them apart —
                // so the sentence stops short of blaming an admin.
                <Empty title="No model is listed for you" body="Divo will fall back to its default until this says otherwise." />
              ) : (
                <div className="ws-rows">
                  {/* Only what the proxy will actually accept for this person.
                      Showing a model it refuses would turn a settings screen
                      into a way to break your own next task. */}
                  {allowedModels.map((m) => (
                    <div className="ws-row" style={{ paddingLeft: 0, paddingRight: 0 }} key={m.id}>
                      <span className="ws-ic" data-tone="ok"><Check size={14} /></span>
                      <div className="ws-row-main"><b>{m.label}</b><p>{m.id}{m.vision ? ' · reads images' : ''}</p></div>
                    </div>
                  ))}
                </div>
              )}
              <p className="ws-sub" style={{ marginTop: 14, lineHeight: 1.5 }}>
                Your admin decides which models you may use, and Divo picks the best one you are allowed for
                each task — there is nothing to choose here.
              </p>
            </div>
          </Panel>
        </div>

        <Panel title="Appearance">
          <div className="ws-panel-body">
            <div className="ws-lbl">Theme</div>
            <div style={{ marginTop: 10 }}>
              {/* No toast: the whole window changing colour is the confirmation,
                  and it is a better one than a message saying it happened. */}
              <Seg
                value={theme}
                onChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}
                options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' }]}
              />
            </div>
            {/* A "Notify me when work needs me" switch sat here. Nothing was
                behind it — no preference was stored and no notification is sent
                from anywhere — so it was a switch whose only effect was to look
                like it had one. It comes back when there is something to turn
                on. Approvals already reach people in Lark. */}
          </div>
        </Panel>
      </div>
    </>
  )
}

/**
 * Connecting Zoho, both ways.
 *
 * OAuth is the ordinary route and the only one that can be given write access
 * by Zoho itself. Self Client exists for the case where an admin cannot run a
 * consent screen — a service account, a Zoho org that will not grant one — and
 * hands over credentials instead.
 *
 * Ported from the desktop app, which had this and the web did not. Anyone
 * administering Zoho from a browser was simply told to go and use the desktop.
 */
function ZohoConnectDialog({ toast, onClose, onOAuth, onConnected }: {
  toast: Toast
  onClose: () => void
  onOAuth: () => void
  onConnected: () => Promise<void>
}) {
  const zoho = useZohoSelfClientConnect()
  const [mode, setMode] = useState<'choose' | 'self_client'>('choose')
  const [label, setLabel] = useState('')
  const [dataCentre, setDataCentre] = useState<string>(ZOHO_DATA_CENTRES[0].value)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [grantToken, setGrantToken] = useState('')
  const [access, setAccess] = useState<ZohoSelfClientAccess>('read_only')

  const finish = async () => {
    if (!clientId.trim() || !clientSecret.trim() || !grantToken.trim()) {
      toast('Enter the client ID, client secret, and grant token', 'error')
      return
    }
    try {
      const result = await zoho.connect({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        grantToken: grantToken.trim(),
        accountsBaseUrl: dataCentre,
        access,
        ...(label.trim() ? { label: label.trim() } : {}),
      })
      await onConnected()
      toast(`Zoho connected: ${result.label}`)
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not connect Zoho', 'error')
    }
  }

  return (
    <>
      <div className="ws-scrim" onClick={onClose} />
      <div className="ws-modal-wrap">
        <div className="ws-modal" role="dialog" aria-label="Connect Zoho">
          <div className="ws-modal-h">
            <h2>Connect Zoho</h2>
            <p>
              {mode === 'choose'
                ? 'Sign in with Zoho, or hand over Self Client credentials if a consent screen is not available to you.'
                : 'Register a Self Client in the Zoho API console, then generate a grant and paste it here before it expires.'}
            </p>
          </div>

          {mode === 'choose' ? (
            <div className="ws-modal-b">
              <div className="ws-choice">
                <div className="ws-lbl">Sign in with Zoho</div>
                <p className="ws-sentence-note" style={{ marginTop: 6 }}>
                  Zoho asks you to approve the access. This is the only route Zoho will grant write access through,
                  so it is the one to use if Divo should create or edit records.
                </p>
                <button type="button" className="btn primary" style={{ marginTop: 12 }} onClick={onOAuth}>
                  Continue with Zoho
                </button>
              </div>
              <div className="ws-choice" style={{ marginTop: 20 }}>
                <div className="ws-lbl">Self Client credentials</div>
                <p className="ws-sentence-note" style={{ marginTop: 6 }}>
                  Paste a client ID, client secret, and a fresh short-lived grant. Divo exchanges the grant for a
                  refresh token, encrypts it, and keeps the connection alive from there — you never paste that part.
                </p>
                <button type="button" className="btn" style={{ marginTop: 12 }} onClick={() => setMode('self_client')}>
                  Enter credentials
                </button>
              </div>
            </div>
          ) : (
            <div className="ws-modal-b">
              <div className="ws-lbl">Data centre</div>
              <select
                className="input"
                value={dataCentre}
                onChange={(e) => setDataCentre(e.target.value)}
                style={{ width: '100%', marginTop: 8 }}
              >
                {ZOHO_DATA_CENTRES.map((dc) => <option key={dc.value} value={dc.value}>{dc.label}</option>)}
              </select>

              <div className="ws-lbl" style={{ marginTop: 18 }}>Client ID</div>
              <input
                className="input"
                autoFocus
                value={clientId}
                maxLength={255}
                placeholder="Zoho Self Client ID"
                onChange={(e) => setClientId(e.target.value)}
                style={{ width: '100%', marginTop: 8 }}
              />

              <div className="ws-lbl" style={{ marginTop: 18 }}>Client secret</div>
              <input
                className="input"
                type="password"
                value={clientSecret}
                maxLength={512}
                placeholder="Zoho Self Client secret"
                onChange={(e) => setClientSecret(e.target.value)}
                style={{ width: '100%', marginTop: 8 }}
              />

              <div className="ws-lbl" style={{ marginTop: 18 }}>Short-lived grant token</div>
              <input
                className="input"
                type="password"
                value={grantToken}
                maxLength={4096}
                placeholder="Generated in the Zoho API console"
                onChange={(e) => setGrantToken(e.target.value)}
                style={{ width: '100%', marginTop: 8 }}
              />

              <div className="ws-lbl" style={{ marginTop: 18 }}>What this connection may do</div>
              <select
                className="input"
                value={access}
                onChange={(e) => setAccess(e.target.value as ZohoSelfClientAccess)}
                style={{ width: '100%', marginTop: 8 }}
              >
                <option value="read_only">Read only</option>
                <option value="read_write">Read and write</option>
              </select>

              <div className="ws-lbl" style={{ marginTop: 18 }}>Connection name</div>
              <input
                className="input"
                value={label}
                maxLength={120}
                placeholder="Optional"
                onChange={(e) => setLabel(e.target.value)}
                style={{ width: '100%', marginTop: 8 }}
              />

              <p className="ws-sentence-note">
                {access === 'read_write'
                  ? 'Divo will let this connection create and edit records. The grant still bounds it — Zoho refuses a write the scopes never covered.'
                  : 'Divo will only read through this connection. Choose read and write if it should create or edit records.'}
                {' '}Credentials go straight to the backend, encrypted, and are never shown here again.
              </p>
            </div>
          )}

          <div className="ws-modal-f">
            {mode === 'self_client' ? (
              <button type="button" className="btn" onClick={() => setMode('choose')} disabled={zoho.saving}>Back</button>
            ) : null}
            <button type="button" className="btn" onClick={onClose} disabled={zoho.saving}>Cancel</button>
            {mode === 'self_client' ? (
              <button
                type="button"
                className="btn primary"
                disabled={zoho.saving || !clientId.trim() || !clientSecret.trim() || !grantToken.trim()}
                onClick={() => void finish()}
              >
                {zoho.saving ? 'Connecting…' : 'Connect'}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </>
  )
}
