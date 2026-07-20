import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { RefreshCw } from "lucide-react"
import { StatusPill } from "@/cursor/components"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import {
  useAiOpsKpis,
  useModelTargets,
  useRuns,
  useRuntimeTasks,
  useTokenUsageMembers,
  useTokenUsageSummary,
} from "@/cursor/use-ai-ops"
import { compact, usd, useCompanyScope, useDirectory, useSpendByModel, useSpendMembers } from "@/cursor/use-spend"

type Tab = "runs" | "cost" | "spend" | "tokens" | "models" | "runtime"

const TABS: { id: Tab; label: string }[] = [
  { id: "runs", label: "Runs" },
  { id: "cost", label: "Cost" },
  { id: "spend", label: "Spend" },
  { id: "tokens", label: "Token Usage" },
  { id: "models", label: "Models" },
  { id: "runtime", label: "Runtime" },
]

export function AiOpsPage() {
  const navigate = useNavigate()
  const { token } = useAdminAuth()
  const [tab, setTab] = useState<Tab>("runs")
  const [channel, setChannel] = useState("")
  const [status, setStatus] = useState("")
  const [search, setSearch] = useState("")

  const companyId = useCompanyScope()
  const kpis = useAiOpsKpis(token, companyId)
  const runs = useRuns(token, { channel: channel || undefined, status: status || undefined })
  const byModel = useSpendByModel(token, 30, companyId, channel || undefined)
  const spendMembers = useSpendMembers(token, 30, companyId, channel || undefined)
  const dir = useDirectory(token, companyId)
  const tokenSummary = useTokenUsageSummary(token, companyId, channel || undefined)
  const tokenMembers = useTokenUsageMembers(token, companyId, channel || undefined)
  const modelTargets = useModelTargets(token)
  const runtime = useRuntimeTasks(token, companyId, channel || undefined)

  const deptByUser = useMemo(
    () => new Map((dir.data ?? []).map((d) => [d.userId, d.departmentNames?.[0] ?? "—"])),
    [dir.data],
  )

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return runs.data ?? []
    return (runs.data ?? []).filter((r) => r.user.toLowerCase().includes(q) || r.shortId.includes(q))
  }, [runs.data, search])

  const openRun = (runId: string) => navigate(`/ai-ops/runs/${runId}`, { state: { from: "aiops" } })
  const refresh = () => {
    void kpis.refetch()
    void runs.refetch()
  }

  const k = kpis.data

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="eyebrow">Operations</div>
          <h1 className="display">AI Ops</h1>
          <p>Run traces, cost, spend, and model routing for the whole company.</p>
        </div>
        <button className="btn" type="button" onClick={refresh}><RefreshCw size={15} /> Refresh</button>
      </div>

      <div className="grid g4" style={{ marginBottom: "22px" }}>
        <div className="card metric feat"><div className="lbl">Spend · 24h</div><div className="val display">{k ? k.spend24h : "—"}</div><div className="sub">{k ? k.cacheNote : "estimated cost"}</div></div>
        <div className="card metric"><div className="lbl">Runs · 24h</div><div className="val display">{k ? k.runs24h : "—"}</div><div className="sub">desktop · lark · web</div></div>
        <div className="card metric"><div className="lbl">Avg / run</div><div className="val display">{k ? k.avgPerRun : "—"}</div><div className="sub">{k ? k.avgNote : "per run · 24h"}</div></div>
        <div className="card metric"><div className="lbl">Errors</div><div className="val display">{k ? k.errors : "—"}</div><div className="sub">{k ? k.errorPct : "—"}</div></div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`tab${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab !== "models" ? (
        <div className="filters">
          <select className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">All channels</option><option value="desktop">desktop</option><option value="lark">lark</option><option value="web">web</option>
          </select>
          <span className="muted" style={{ fontSize: "12px" }}>
            {channel === "lark" ? "Lark · pinned to DeepSeek V4 Flash" : channel ? `${channel} activity only` : "Company-wide activity"}
          </span>
        </div>
      ) : null}

      {tab === "runs" ? (
        <>
          <div className="filters">
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All status</option><option value="completed">completed</option><option value="failed">failed</option><option value="running">running</option>
            </select>
            <div style={{ flex: 1 }} />
            <input className="input" placeholder="Filter by user or run id…" style={{ width: "220px" }} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="section">
            <table>
              <thead>
                <tr>
                  <th>Run</th><th>User</th><th>Channel</th><th>Status</th>
                  <th className="right">Turns</th><th className="right">Tokens</th><th className="right">Cost</th>
                  <th className="right">Duration</th><th>Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.isLoading ? (
                  <tr><td colSpan={9} className="muted" style={{ padding: "28px", textAlign: "center" }}>Loading runs…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={9} className="muted" style={{ padding: "28px", textAlign: "center" }}>No runs match these filters.</td></tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.id} className="click" onClick={() => openRun(r.id)}>
                      <td className="mono">{r.shortId}</td>
                      <td>{r.user}</td>
                      <td className="muted">{r.channel}</td>
                      <td><StatusPill status={r.status} /></td>
                      <td className="right">{r.turns}</td>
                      <td className="right mono">{r.tokensLabel}</td>
                      <td className="right"><b>{r.costLabel}</b></td>
                      <td className="right muted">{r.durationLabel}</td>
                      <td className="muted">{r.startedLabel}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {tab === "cost" ? (
        <div className="section">
          <header><h3>Per-model cost breakdown</h3><p>Provider-reported cost · 30 days</p></header>
          <table>
            <thead>
              <tr><th>Model</th><th className="right">Calls</th><th className="right">Cache-miss in</th><th className="right">Cache-hit in</th><th className="right">Output</th><th className="right">Cost</th></tr>
            </thead>
            <tbody>
              {byModel.isLoading ? (
                <tr><td colSpan={6} className="muted" style={{ padding: "24px", textAlign: "center" }}>Loading…</td></tr>
              ) : (byModel.data ?? []).length === 0 ? (
                <tr><td colSpan={6} className="muted" style={{ padding: "24px", textAlign: "center" }}>No model usage in this window.</td></tr>
              ) : (
                byModel.data!.map((m) => (
                  <tr key={`${m.provider}:${m.modelId}`}>
                    <td className="mono">{m.modelId}</td>
                    <td className="right">{m.calls}</td>
                    <td className="right">{compact(m.cacheMissIn)}</td>
                    <td className="right">{compact(m.cacheHitIn)}</td>
                    <td className="right">{compact(m.output)}</td>
                    <td className="right"><b>{usd(m.costUsd)}</b></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "spend" ? (
        <div className="section">
          <header><h3>Spend by member</h3><p>Provider-reported cost · today vs 30 days</p></header>
          <table>
            <thead><tr><th>Member</th><th>Department</th><th className="right">Today</th><th className="right">30 days</th></tr></thead>
            <tbody>
              {spendMembers.isLoading ? (
                <tr><td colSpan={4} className="muted" style={{ padding: "24px", textAlign: "center" }}>Loading…</td></tr>
              ) : (spendMembers.data?.members ?? []).length === 0 ? (
                <tr><td colSpan={4} className="muted" style={{ padding: "24px", textAlign: "center" }}>No spend recorded yet.</td></tr>
              ) : (
                spendMembers.data!.members.map((m) => (
                  <tr key={m.userId}>
                    <td>{m.name ?? m.email ?? "—"}</td>
                    <td className="muted">{deptByUser.get(m.userId) ?? "—"}</td>
                    <td className="right">{usd(m.spendToday)}</td>
                    <td className="right"><b>{usd(m.spend30d)}</b></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "tokens" ? (
        <div className="section">
          <header>
            <h3>Token usage</h3>
            <p>
              {tokenSummary.data
                ? `Company total ${compact(tokenSummary.data.totalTokens)} tokens · ${tokenSummary.data.callCount} calls · 30 days`
                : "Per-member consumption vs monthly limits · 30 days"}
            </p>
          </header>
          <table>
            <thead>
              <tr><th>Member</th><th className="right">Calls</th><th className="right">Tokens</th><th className="right">Limit</th><th className="right">Usage</th></tr>
            </thead>
            <tbody>
              {tokenMembers.isLoading ? (
                <tr><td colSpan={5} className="muted" style={{ padding: "24px", textAlign: "center" }}>Loading…</td></tr>
              ) : (tokenMembers.data ?? []).length === 0 ? (
                <tr><td colSpan={5} className="muted" style={{ padding: "24px", textAlign: "center" }}>No token usage in this window.</td></tr>
              ) : (
                tokenMembers.data!.map((m) => (
                  <tr key={m.userId}>
                    <td>{m.name ?? m.email ?? "—"}</td>
                    <td className="right">{m.calls}</td>
                    <td className="right mono">{compact(m.totalTokens)}</td>
                    <td className="right muted">{compact(m.monthlyLimit)}</td>
                    <td className="right">
                      <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
                        <div style={{ width: "60px", height: "6px", borderRadius: "3px", background: "var(--cur-surface-strong)", overflow: "hidden" }}>
                          <div style={{ width: `${Math.min(100, m.usagePct)}%`, height: "100%", background: m.usagePct >= 85 ? "var(--cur-error)" : "var(--cur-primary)" }} />
                        </div>
                        <b>{m.usagePct}%</b>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "models" ? (
        <div className="section">
            <div className="card" style={{ marginBottom: "14px", padding: "14px 16px" }}>
              <b>Lark channel model</b>
              <div className="muted" style={{ marginTop: "4px" }}>DeepSeek V4 Flash · pinned by backend policy · not changed by routing targets below</div>
            </div>
            <header><h3>Model routing targets</h3><p>Provider / model per routing tier</p></header>
            <table>
              <thead>
                <tr><th>Target</th><th>Provider</th><th>Model</th><th>Thinking</th><th>Fast</th><th>Xtreme</th></tr>
              </thead>
              <tbody>
                {modelTargets.isLoading ? (
                  <tr><td colSpan={6} className="muted" style={{ padding: "24px", textAlign: "center" }}>Loading…</td></tr>
                ) : (modelTargets.data ?? []).length === 0 ? (
                  <tr><td colSpan={6} className="muted" style={{ padding: "24px", textAlign: "center" }}>No model targets configured.</td></tr>
                ) : (
                  modelTargets.data!.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{t.targetKey}</td>
                      <td className="muted">{t.provider}</td>
                      <td className="mono">{t.modelId}</td>
                      <td className="muted">{t.thinkingLevel ?? "—"}</td>
                      <td className="mono muted">{t.fastModelId ?? "—"}</td>
                      <td className="mono muted">{t.xtremeModelId ?? "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
        </div>
      ) : null}

      {tab === "runtime" ? (
        <div className="section">
          <header><h3>Runtime tasks</h3><p>Recent execution runs across channels</p></header>
          <table>
            <thead>
              <tr><th>Run</th><th>User</th><th>Channel</th><th>Status</th><th className="right">Turns</th><th className="right">Cost</th><th>Started</th></tr>
            </thead>
            <tbody>
              {runtime.isLoading ? (
                <tr><td colSpan={7} className="muted" style={{ padding: "24px", textAlign: "center" }}>Loading…</td></tr>
              ) : (runtime.data ?? []).length === 0 ? (
                <tr><td colSpan={7} className="muted" style={{ padding: "24px", textAlign: "center" }}>No runtime tasks yet.</td></tr>
              ) : (
                runtime.data!.map((r) => (
                  <tr key={r.id} className="click" onClick={() => openRun(r.id)}>
                    <td className="mono">{r.shortId}</td>
                    <td>{r.user}</td>
                    <td className="muted">{r.channel}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td className="right">{r.turns}</td>
                    <td className="right"><b>{r.costLabel}</b></td>
                    <td className="muted">{r.startedLabel}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
