import { useState } from "react"
import { Activity, Ban, CheckCircle2, KeyRound, RotateCw, ShieldCheck, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { compact, usd, useCompanyScope, useSpendMembers } from "@/cursor/use-spend"
import { activeModel, useProxyPolicies, useSaveProxyPolicy, type ProxyPolicy } from "@/cursor/use-proxy-policy"
import { KEY_PROVIDERS, proxyState, useProxyAudit, useProxyMetrics, useProxyModels, useProxyStatus, useRemoveProxyKey, useSaveProxyKey, type AuditDecision, type KeyProvider, type KeyScope } from "@/cursor/use-proxy"

/*
 * Guardrails — model proxy control plane. Fully wired: a key card per provider
 * (encrypted key-store), member controls (block / budget / rate / models),
 * health metrics, and the live audit feed all read/write real backend.
 */
const STATE_META: Record<ReturnType<typeof proxyState>, { label: string; color: string }> = {
  active: { label: "Active", color: "var(--cur-success)" },
  not_configured: { label: "No key", color: "var(--cur-warning, #d08700)" },
  paused: { label: "Paused", color: "var(--cur-warning, #d08700)" },
  disabled: { label: "Disabled", color: "var(--cur-muted-soft)" },
}

export function GuardrailsPage() {
  const { token, session } = useAdminAuth()
  const companyId = useCompanyScope()
  const isSuper = session?.role === "SUPER_ADMIN"

  // One key card at a time. Both keys are stored side by side; this only picks
  // which one is on screen.
  const [provider, setProvider] = useState<KeyProvider>("deepseek")
  const statusQ = useProxyStatus(token, provider, companyId)
  const saveKey = useSaveProxyKey(token, provider, companyId)
  const removeKey = useRemoveProxyKey(token, provider, companyId)
  const status = statusQ.data
  const state = proxyState(status)
  const providerMeta = KEY_PROVIDERS.find((p) => p.id === provider)!

  const modelsQ = useProxyModels(token)
  const models = modelsQ.data

  // Default to the scope this admin is actually allowed to set (platform is super-admin-only).
  const [scope, setScope] = useState<KeyScope>(isSuper ? "platform" : "company")
  const [apiKey, setApiKey] = useState("")

  const submitKey = () => {
    const key = apiKey.trim()
    if (key.length < 20) { toast.error(`Paste a valid ${providerMeta.label} key (sk-…)`); return }
    // Guard against a stale 'platform' scope for non-super-admins (session may load late).
    const keyScope: KeyScope = isSuper ? scope : "company"
    saveKey.mutate({ key, keyScope }, { onSuccess: () => { setApiKey(""); toast.success("Key saved") } })
  }
  const clearKey = () => {
    const effScope: KeyScope = status?.scope ?? (isSuper ? scope : "company")
    removeKey.mutate({ keyScope: effScope }, { onSuccess: () => toast.success("Key removed") })
  }

  const [channel, setChannel] = useState("")
  const metricsQ = useProxyMetrics(token, companyId, channel || undefined)
  const metrics = metricsQ.data

  const [auditFilter, setAuditFilter] = useState<AuditDecision | "all">("all")
  const auditQ = useProxyAudit(token, companyId, { limit: 60, ...(channel ? { channel } : {}), ...(auditFilter === "all" ? {} : { decision: auditFilter }) })

  const membersQ = useSpendMembers(token, 30, companyId)
  const policiesQ = useProxyPolicies(token, companyId)
  const savePolicy = useSaveProxyPolicy(token, companyId)

  const policyByUser = new Map((policiesQ.data ?? []).map((p) => [p.userId, p]))
  // Only safe to mutate once policies have loaded — the effPolicy fallback is a
  // synthetic Flash-only default and would clobber a real (Pro/budget/rate) policy.
  const policiesReady = policiesQ.isSuccess
  const effPolicy = (userId: string): ProxyPolicy =>
    policyByUser.get(userId) ?? { userId, blocked: false, monthlyBudgetUsd: null, rateLimitRpm: null, allowedModels: ["deepseek-v4-flash"], isDefault: true }

  const persist = (userId: string, patch: Partial<Pick<ProxyPolicy, "blocked" | "allowedModels" | "monthlyBudgetUsd" | "rateLimitRpm">>) => {
    if (!policiesReady) { toast.error("Still loading member policies — try again in a moment"); return }
    const cur = effPolicy(userId)
    savePolicy.mutate(
      {
        userId,
        input: {
          blocked: patch.blocked ?? cur.blocked,
          monthlyBudgetUsd: patch.monthlyBudgetUsd !== undefined ? patch.monthlyBudgetUsd : cur.monthlyBudgetUsd,
          rateLimitRpm: patch.rateLimitRpm !== undefined ? patch.rateLimitRpm : cur.rateLimitRpm,
          allowedModels: patch.allowedModels ?? (cur.allowedModels.length ? cur.allowedModels : ["deepseek-v4-flash"]),
        },
      },
      { onSuccess: () => toast.success("Saved") },
    )
  }

  // Inline numeric edit for the budget/rate cells — persists on Enter/blur when
  // changed. Returns true only if a mutation actually fired, so the caller can
  // snap an uncontrolled input back to the canonical value on a no-op/invalid edit.
  const editLimit = (userId: string, field: "monthlyBudgetUsd" | "rateLimitRpm", raw: string, current: number | null): boolean => {
    const trimmed = raw.trim()
    const next = trimmed === "" ? null : Number(trimmed)
    if (next !== null && (!Number.isFinite(next) || next <= 0)) { toast.error("Enter a positive number or clear it"); return false }
    const rounded = next !== null && field === "rateLimitRpm" ? Math.round(next) : next
    if (rounded === current) return false
    persist(userId, { [field]: rounded })
    return true
  }
  const fmtLimit = (v: number | null) => (v != null ? String(v) : "")

  const toggleBlock = (userId: string) => persist(userId, { blocked: !effPolicy(userId).blocked })
  const toggleModel = (userId: string, id: string) => {
    const cur = effPolicy(userId).allowedModels
    const next = cur.includes(id) ? cur.filter((m) => m !== id) : [...cur, id]
    if (next.length === 0) { toast.error("Select at least one model"); return }
    persist(userId, { allowedModels: next })
  }

  const members = membersQ.data?.members ?? []

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="eyebrow">Operations</div>
          <h1 className="display">Guardrails</h1>
          <p>Every model call routes through the backend proxy — hold each provider's key here, cap spend, rate-limit, and block abuse in real time.</p>
        </div>
        <div className="role-pill" title={`Proxy ${STATE_META[state].label}`}>
          <span className="dot" style={{ width: 7, height: 7, borderRadius: "50%", background: STATE_META[state].color }} />
          Proxy <b>{STATE_META[state].label}</b>
        </div>
      </div>

      {/* Provider keys — REAL (encrypted key-store; desktop never holds a key) */}
      <div className="section">
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h3>Provider keys</h3>
            <p>Stored encrypted server-side, one per provider. The desktop never sees them — requests carry only the member token, and the backend attaches the key for whichever model was asked for.</p>
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            {KEY_PROVIDERS.map((p) => (
              <button key={p.id} className="badge" type="button" onClick={() => { setProvider(p.id); setApiKey("") }} title={p.hint}
                style={{ cursor: "pointer", textTransform: "none", ...(p.id === provider ? { color: "var(--cur-primary)", borderColor: "color-mix(in srgb, var(--cur-primary) 45%, transparent)" } : { color: "var(--cur-muted-soft)", opacity: 0.6 }) }}>
                {p.label}
              </button>
            ))}
          </div>
        </header>
        <div style={{ padding: "18px", display: "grid", gap: "16px", gridTemplateColumns: "1.4fr 1fr" }}>
          <div>
            <div className="muted" style={{ fontSize: "12.5px", marginBottom: "10px" }}>{providerMeta.hint}</div>
            <div className="kv">
              <span className="k">Current key</span>
              <span className="v mono">{statusQ.isLoading ? "…" : status?.keyMasked ?? "Not configured"}</span>
            </div>
            {status?.keyError === "unreadable" ? (
              <div style={{ fontSize: "12px", marginTop: "6px", color: "var(--cur-error)" }}>Stored key can’t be decrypted (encryption secret changed or corrupt). Paste the key again to fix — requests are failing with 503 until then.</div>
            ) : status && !status.configured ? (
              <div className="muted" style={{ fontSize: "12px", marginTop: "6px" }}>No {providerMeta.label} key saved. Models served by {providerMeta.label} return 503 until one is added here — there is no server fallback.</div>
            ) : null}
            {status && !status.canEncrypt ? (
              <div style={{ fontSize: "12px", marginTop: "6px", color: "var(--cur-error)" }}>Server encryption key is not configured — set PROXY_KEY_ENCRYPTION_KEY to store keys here.</div>
            ) : null}
            <div style={{ display: "flex", gap: "9px", marginTop: "12px", alignItems: "center" }}>
              <input className="input" style={{ flex: 1 }} placeholder={`Paste ${providerMeta.label} API key (sk-…)`} value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitKey() }} disabled={status ? !status.canEncrypt : false} />
              <button className="btn primary" type="button" onClick={submitKey} disabled={saveKey.isPending || (status ? !status.canEncrypt : false)}>
                {status?.keyLast4 ? <RotateCw size={15} /> : <KeyRound size={15} />} {saveKey.isPending ? "Saving…" : status?.keyLast4 ? "Rotate" : "Save"}
              </button>
              {status?.keyLast4 ? (
                <button className="btn" type="button" onClick={clearKey} disabled={removeKey.isPending} title="Remove key">
                  <Trash2 size={15} />
                </button>
              ) : null}
            </div>
            <div style={{ display: "flex", gap: "9px", marginTop: "12px", alignItems: "center" }}>
              <span className="muted" style={{ fontSize: "12.5px" }}>Scope</span>
              <select className="select" value={scope} onChange={(e) => setScope(e.target.value as KeyScope)}>
                {isSuper ? <option value="platform">Platform-wide (all companies)</option> : null}
                <option value="company">Per-company key</option>
              </select>
            </div>
          </div>
          <div style={{ borderLeft: "1px solid var(--cur-hairline)", paddingLeft: "16px" }}>
            <div className="kv"><span className="k">Upstream</span><span className="v mono">{status?.upstream ?? "—"}</span></div>
            <div className="kv"><span className="k">Resolves from</span><span className="v">{status?.source ?? "—"}</span></div>
            <div className="kv"><span className="k">Last used</span><span className="v">{status?.lastUsedAt ? new Date(status.lastUsedAt).toLocaleString() : "—"}</span></div>
            <div className="kv"><span className="k">Status</span><span className="v">
              {state === "active" ? <span className="badge b-ok"><span className="dot" />routing</span>
                : state === "not_configured" ? <span className="badge b-err"><span className="dot" />no key</span>
                : <span className="badge b-err"><span className="dot" />{STATE_META[state].label.toLowerCase()}</span>}
            </span></div>
          </div>
        </div>
      </div>

      {/* Proxy health — REAL (last 24h, from the request audit log) */}
      <div className="grid g4 mt24">
        <div className="card metric feat"><div className="lbl">Requests · 24h</div><div className="val display">{metrics ? compact(metrics.requests24h) : "—"}</div><div className="sub">through the proxy</div></div>
        <div className="card metric"><div className="lbl">Error rate</div><div className="val display">{metrics ? `${metrics.errorRatePct}%` : "—"}</div><div className="sub">upstream + gate denials</div></div>
        <div className="card metric"><div className="lbl">Avg latency</div><div className="val display">{metrics ? `${metrics.avgLatencyMs}ms` : "—"}</div><div className="sub">proxy round-trip</div></div>
        <div className="card metric"><div className="lbl">Throughput</div><div className="val display">{metrics ? compact(metrics.tokensPerMin) : "—"}</div><div className="sub">tokens / min</div></div>
      </div>

      {/* Member controls — REAL (writes MemberProxyPolicy) */}
      <div className="section mt24">
        <header><h3>Member controls</h3><p>Model access is admin-controlled — grant a member the models they may use, block abusers, and see live 30-day spend. Granting several means the best of them answers; <b>Runs on</b> shows which that is. Budget &amp; rate caps are set on each member’s page.</p></header>
        <table>
          <thead>
            <tr><th>Member</th><th className="right">30d spend</th><th className="right">Budget cap</th><th className="right">Rate</th><th>Model access</th><th>Runs on</th><th className="right">Access</th></tr>
          </thead>
          <tbody>
            {membersQ.isLoading ? (
              <tr><td colSpan={7} className="muted" style={{ padding: "24px", textAlign: "center" }}>Loading members…</td></tr>
            ) : members.length === 0 ? (
              <tr><td colSpan={7} className="muted" style={{ padding: "24px", textAlign: "center" }}>No member usage yet.</td></tr>
            ) : (
              members.map((m) => {
                const p = effPolicy(m.userId)
                const name = m.name ?? m.email ?? "Member"
                const over = p.monthlyBudgetUsd != null && m.spend30d >= p.monthlyBudgetUsd
                return (
                  <tr key={m.userId}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        <div className="avatar">{name[0].toUpperCase()}</div>
                        <b style={{ fontWeight: 500 }}>{name}</b>
                      </div>
                    </td>
                    <td className="right"><b style={{ color: over ? "var(--cur-error)" : "var(--cur-ink)" }}>{usd(m.spend30d)}</b></td>
                    <td className="right">
                      <input className="input" defaultValue={p.monthlyBudgetUsd ?? ""} placeholder="—" disabled={!policiesReady}
                        key={`b-${p.monthlyBudgetUsd ?? "x"}`} style={{ width: "72px", textAlign: "right", padding: "4px 8px" }}
                        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur() }}
                        onBlur={(e) => { if (!editLimit(m.userId, "monthlyBudgetUsd", e.currentTarget.value, p.monthlyBudgetUsd)) e.currentTarget.value = fmtLimit(p.monthlyBudgetUsd) }} />
                    </td>
                    <td className="right">
                      <input className="input" defaultValue={p.rateLimitRpm ?? ""} placeholder="—" disabled={!policiesReady}
                        key={`r-${p.rateLimitRpm ?? "x"}`} style={{ width: "64px", textAlign: "right", padding: "4px 8px" }}
                        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur() }}
                        onBlur={(e) => { if (!editLimit(m.userId, "rateLimitRpm", e.currentTarget.value, p.rateLimitRpm)) e.currentTarget.value = fmtLimit(p.rateLimitRpm) }} />
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: "6px" }}>
                        {(models ?? []).map((mm) => {
                          const on = p.allowedModels.includes(mm.id)
                          return (
                            <button key={mm.id} className="badge" type="button" onClick={() => toggleModel(m.userId, mm.id)} disabled={savePolicy.isPending || !policiesReady}
                              title={`${mm.provider} · $${mm.inputPerMillionUsd}/M in, $${mm.outputPerMillionUsd}/M out${mm.vision ? " · reads images" : ""}`}
                              style={{ cursor: "pointer", textTransform: "none", ...(on ? { color: "var(--cur-primary)", borderColor: "color-mix(in srgb, var(--cur-primary) 45%, transparent)" } : { color: "var(--cur-muted-soft)", opacity: 0.6 }) }}>
                              {mm.label}
                            </button>
                          )
                        })}
                      </div>
                    </td>
                    <td>
                      {(() => {
                        const running = activeModel(models, p.allowedModels)
                        if (!running) return <span className="muted">—</span>
                        return (
                          <span className="mono" style={{ fontSize: "12.5px" }} title={running.id}>
                            {running.label}
                            {running.vision ? <span className="muted" style={{ marginLeft: 6 }}>sees images</span> : null}
                          </span>
                        )
                      })()}
                    </td>
                    <td className="right">
                      <button className="btn" type="button" onClick={() => toggleBlock(m.userId)} disabled={savePolicy.isPending || !policiesReady} style={p.blocked ? { color: "var(--cur-error)", borderColor: "color-mix(in srgb, var(--cur-error) 40%, transparent)" } : undefined}>
                        {p.blocked ? <><Ban size={14} /> Blocked</> : <><CheckCircle2 size={14} /> Active</>}
                      </button>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Live audit feed — REAL (per-request allow/deny, auto-refreshing) */}
      <div className="section mt24">
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h3><Activity size={15} style={{ marginRight: 6 }} />Live audit</h3>
            <p>Every proxied request with its allow / deny decision — block abusers right here.</p>
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            <select className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">All channels</option><option value="desktop">desktop</option><option value="lark">lark</option>
            </select>
            {(["all", "allowed", "denied"] as const).map((f) => (
              <button key={f} className="btn" type="button" onClick={() => setAuditFilter(f)}
                style={auditFilter === f ? { color: "var(--cur-primary)", borderColor: "color-mix(in srgb, var(--cur-primary) 45%, transparent)" } : { color: "var(--cur-muted)" }}>
                {f === "all" ? "All" : f === "allowed" ? "Allowed" : "Denied"}
              </button>
            ))}
          </div>
        </header>
        <table>
          <thead>
            <tr><th>Time</th><th>User</th><th>Channel</th><th>Model</th><th className="right">Tokens</th><th className="right">Cost</th><th className="right">Latency</th><th>Decision</th><th></th></tr>
          </thead>
          <tbody>
            {auditQ.isLoading ? (
              <tr><td colSpan={9} className="muted" style={{ padding: "24px", textAlign: "center" }}>Loading audit…</td></tr>
            ) : (auditQ.data ?? []).length === 0 ? (
              <tr><td colSpan={9} className="muted" style={{ padding: "24px", textAlign: "center" }}>No model requests yet.</td></tr>
            ) : (
              auditQ.data!.map((e) => (
                <tr key={e.id}>
                  <td className="mono muted">{new Date(e.createdAt).toLocaleTimeString()}</td>
                  <td>{e.user}</td>
                  <td className="muted">{e.channel}</td>
                  <td className="mono">{e.model}</td>
                  <td className="right mono">{e.tokens ? compact(e.tokens) : "—"}</td>
                  <td className="right">{e.costUsd ? usd(e.costUsd) : "—"}</td>
                  <td className="right muted">{e.latencyMs}ms</td>
                  <td>
                    {e.decision === "allowed" ? (
                      <span className="badge b-ok"><span className="dot" />allowed</span>
                    ) : (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                        <span className="badge b-err"><span className="dot" />denied</span>
                        <span className="muted" style={{ fontSize: "11.5px" }}>{e.reason}</span>
                      </span>
                    )}
                  </td>
                  <td className="right">
                    {!effPolicy(e.userId).blocked ? (
                      <button className="btn" type="button" onClick={() => toggleBlock(e.userId)} disabled={savePolicy.isPending || !policiesReady}
                        title="Block this member" style={{ color: "var(--cur-error)", borderColor: "color-mix(in srgb, var(--cur-error) 30%, transparent)" }}>
                        <Ban size={13} /> Block
                      </button>
                    ) : (
                      <span className="badge b-err"><span className="dot" />blocked</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt24" style={{ display: "flex", gap: "8px", alignItems: "center", color: "var(--cur-muted)", fontSize: "12px" }}>
        <ShieldCheck size={14} /> Live — key store, member controls, health metrics, and audit feed all read/write the backend proxy.
      </div>
    </div>
  )
}
