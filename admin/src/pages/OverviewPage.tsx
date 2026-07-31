import { useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { StatusPill, Spark } from "@/cursor/components"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { useRuns } from "@/cursor/use-ai-ops"
import { compact, usd, useCompanyDaily, useCompanyScope, useSpendMembers } from "@/cursor/use-spend"
import { proxyState, useProxyMetrics, useProxyStatus } from "@/cursor/use-proxy"
import { useWebSearchConnections } from "@/cursor/use-web-search"

const PROXY_STATE_LABEL: Record<ReturnType<typeof proxyState>, { label: string; color: string }> = {
  active: { label: "Active", color: "var(--cur-success)" },
  not_configured: { label: "No key", color: "var(--cur-warning, #d08700)" },
  paused: { label: "Paused", color: "var(--cur-warning, #d08700)" },
  disabled: { label: "Disabled", color: "var(--cur-muted-soft)" },
}

export function OverviewPage() {
  const navigate = useNavigate()
  const { token } = useAdminAuth()
  const companyId = useCompanyScope()
  const daily = useCompanyDaily(token, 14, companyId)
  const members = useSpendMembers(token, 30, companyId)
  const runs = useRuns(token, { limit: 4 })
  const proxyStatus = useProxyStatus(token, "deepseek", companyId)
  const proxyMetrics = useProxyMetrics(token, companyId)
  const webSearch = useWebSearchConnections(token)

  const spark = useMemo(() => {
    const costs = (daily.data?.series ?? []).map((s) => s.spendUsd)
    const max = Math.max(...costs, 0)
    return costs.length ? costs.map((c) => (max > 0 ? Math.max(6, Math.round((c / max) * 100)) : 6)) : Array(14).fill(6)
  }, [daily.data])

  const total = (daily.data?.series ?? []).reduce((s, d) => s + d.spendUsd, 0)
  const d = daily.data

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1 className="display">Overview</h1>
          <p>Company activity at a glance — runs, spend, people, and health.</p>
        </div>
      </div>

      <div className="grid g4">
        <div className="card metric feat"><div className="lbl">Spend today</div><div className="val display">{d ? usd(d.today.spendUsd) : "—"}</div><div className="sub">provider-reported</div></div>
        <div className="card metric"><div className="lbl">Runs today</div><div className="val display">{d ? d.today.runs : "—"}</div><div className="sub">all channels</div></div>
        <div className="card metric"><div className="lbl">Active members</div><div className="val display">{members.data?.totals.memberCount ?? "—"}</div><div className="sub">with activity · 30d</div></div>
        <div className="card metric"><div className="lbl">Cache savings</div><div className="val display">{d ? `${d.cacheSavingsPct}%` : "—"}</div><div className="sub">cache-hit input share</div></div>
      </div>

      {/* AI proxy health — only when the proxy is enabled for this company */}
      {proxyStatus.data?.enabled ? (() => {
        const st = proxyState(proxyStatus.data)
        const meta = PROXY_STATE_LABEL[st]
        const pm = proxyMetrics.data
        return (
          <div className="section mt24" style={{ cursor: "pointer" }} onClick={() => navigate("/guardrails")}>
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div><h3>AI proxy</h3><p>DeepSeek provider health · last 24h — open Guardrails to manage all providers</p></div>
              <span className="role-pill"><span className="dot" style={{ width: 7, height: 7, borderRadius: "50%", background: meta.color }} />{meta.label}</span>
            </header>
            <div style={{ display: "flex", gap: "36px", padding: "16px 18px", flexWrap: "wrap" }}>
              <div><div className="muted" style={{ fontSize: "12px" }}>Requests · 24h</div><div className="display" style={{ fontSize: "22px" }}>{pm ? compact(pm.requests24h) : "—"}</div></div>
              <div><div className="muted" style={{ fontSize: "12px" }}>Error rate</div><div className="display" style={{ fontSize: "22px", color: pm && pm.errorRatePct >= 5 ? "var(--cur-error)" : undefined }}>{pm ? `${pm.errorRatePct}%` : "—"}</div></div>
              <div><div className="muted" style={{ fontSize: "12px" }}>Avg latency</div><div className="display" style={{ fontSize: "22px" }}>{pm ? `${pm.avgLatencyMs}ms` : "—"}</div></div>
              <div><div className="muted" style={{ fontSize: "12px" }}>Requests today</div><div className="display" style={{ fontSize: "22px" }}>{pm ? compact(pm.requestsToday) : "—"}</div></div>
            </div>
          </div>
        )
      })() : null}

      <div className="section mt24" style={{ cursor: "pointer" }} onClick={() => navigate("/web-search")}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div><h3>Web search</h3><p>Company Serper connection health and Divo-observed usage — open Web Search for the key inventory.</p></div>
          <span className="role-pill"><span className="dot" style={{ width: 7, height: 7, borderRadius: "50%", background: (webSearch.data?.summary.availableConnectionCount ?? 0) > 0 ? "var(--cur-success)" : "var(--cur-muted-soft)" }} />{webSearch.data?.summary.availableConnectionCount ?? 0} available</span>
        </header>
        <div style={{ display: "flex", gap: "36px", padding: "16px 18px", flexWrap: "wrap" }}>
          <div><div className="muted" style={{ fontSize: "12px" }}>Connections</div><div className="display" style={{ fontSize: "22px" }}>{webSearch.data ? compact(webSearch.data.summary.connectionCount) : "—"}</div></div>
          <div><div className="muted" style={{ fontSize: "12px" }}>Observed searches</div><div className="display" style={{ fontSize: "22px" }}>{webSearch.data ? compact(webSearch.data.summary.observedSearches) : "—"}</div></div>
          <div><div className="muted" style={{ fontSize: "12px" }}>Balances tracked</div><div className="display" style={{ fontSize: "22px" }}>{webSearch.data ? compact(webSearch.data.summary.balanceTrackedConnectionCount) : "—"}</div></div>
        </div>
      </div>

      <div className="grid g2 mt24">
        <div className="section">
          <header><h3>Recent runs</h3><p>Latest desktop &amp; channel activity</p></header>
          <table>
            <thead><tr><th>Run</th><th>User</th><th>Channel</th><th>Status</th><th className="right">Cost</th></tr></thead>
            <tbody>
              {runs.isLoading ? (
                <tr><td colSpan={5} className="muted" style={{ padding: "24px", textAlign: "center" }}>Loading…</td></tr>
              ) : (runs.data ?? []).length === 0 ? (
                <tr><td colSpan={5} className="muted" style={{ padding: "24px", textAlign: "center" }}>No runs yet.</td></tr>
              ) : (
                runs.data!.map((r) => (
                  <tr key={r.id} className="click" onClick={() => navigate(`/ai-ops/runs/${r.id}`, { state: { from: "aiops" } })}>
                    <td className="mono">{r.shortId}</td>
                    <td>{r.user}</td>
                    <td className="muted">{r.channel}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td className="right"><b>{r.costLabel}</b></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="section">
          <header><h3>Spend · last 14 days</h3></header>
          <div style={{ padding: "18px" }}>
            <Spark values={spark} />
            <div className="muted mt16" style={{ fontSize: "12.5px" }}>Total <b style={{ color: "var(--cur-ink)" }}>{usd(total)}</b> · provider-reported cost</div>
          </div>
        </div>
      </div>
    </div>
  )
}
