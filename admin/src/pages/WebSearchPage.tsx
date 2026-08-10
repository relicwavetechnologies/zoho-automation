import { useMemo, useState } from "react"
import { Search } from "lucide-react"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { compact } from "@/cursor/use-spend"
import { Skel } from "@/pages/workspace/ui"
import { type WebSearchConnection, type WebSearchConnectionHealth, useWebSearchConnections } from "@/cursor/use-web-search"

const HEALTH_META: Record<WebSearchConnectionHealth, { label: string; className: string }> = {
  available: { label: "Available", className: "b-ok" },
  cooling_down: { label: "Cooling down", className: "b-err" },
  estimated_depleted: { label: "Estimated depleted", className: "b-err" },
  disabled: { label: "Disabled", className: "" },
  unavailable: { label: "Unavailable", className: "b-err" },
}

const dateTime = (value: string | null) => value ? new Date(value).toLocaleString() : "—"

const personLabel = (connection: WebSearchConnection) =>
  connection.addedBy?.name ?? connection.addedBy?.email ?? "Unknown"

const creditMeter = (connection: WebSearchConnection) => {
  if (connection.creditsAtLastSync === null) return null
  const total = Math.max(0, connection.creditsAtLastSync)
  const remaining = Math.min(total, Math.max(0, connection.estimatedCreditsRemaining ?? 0))
  const used = total - remaining
  const remainingPct = total === 0 ? 0 : Math.round((remaining / total) * 100)
  return { total, remaining, used, remainingPct }
}

export function WebSearchPage() {
  const { token, session } = useAdminAuth()
  const isSuper = session?.role === "SUPER_ADMIN"
  const connectionsQ = useWebSearchConnections(token)
  const [filter, setFilter] = useState("")
  const data = connectionsQ.data

  const connections = useMemo(() => {
    const term = filter.trim().toLowerCase()
    if (!term) return data?.connections ?? []
    return (data?.connections ?? []).filter((connection) => [
      connection.company.name,
      connection.label,
      connection.addedBy?.name,
      connection.addedBy?.email,
      connection.status,
    ].some((value) => value?.toLowerCase().includes(term)))
  }, [data?.connections, filter])

  const summary = data?.summary

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="eyebrow">Operations</div>
          <h1 className="display">Web Search</h1>
          <p>Company-owned Serper connections, key health, and the successful searches Divo has observed.</p>
        </div>
        <div className="role-pill">
          <Search size={15} /> {isSuper ? <><b>All companies</b></> : <><b>Company connections</b></>}
        </div>
      </div>

      <div className="grid g4">
        <div className="card metric feat"><div className="lbl">Connections</div><div className="val display">{summary ? compact(summary.connectionCount) : "—"}</div><div className="sub">{isSuper ? `${summary?.companyCount ?? 0} companies` : "in this company"}</div></div>
        <div className="card metric"><div className="lbl">Available now</div><div className="val display">{summary ? compact(summary.availableConnectionCount) : "—"}</div><div className="sub">ready for routing</div></div>
        <div className="card metric"><div className="lbl">Observed searches</div><div className="val display">{summary ? compact(summary.observedSearches) : "—"}</div><div className="sub">successful requests recorded by Divo</div></div>
        <div className="card metric"><div className="lbl">Balance tracked</div><div className="val display">{summary ? compact(summary.balanceTrackedConnectionCount) : "—"}</div><div className="sub">keys with a manual Serper snapshot</div></div>
      </div>

      <div className="section mt24">
        <header style={{ display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "center" }}>
          <div>
            <h3>Serper connection inventory</h3>
            <p>Credentials never appear here. Remaining credits are estimates from an admin-entered Serper balance, less only Divo-observed searches.</p>
          </div>
          <input className="input" aria-label="Filter web search connections" placeholder="Filter connections…" value={filter} onChange={(event) => setFilter(event.target.value)} style={{ width: "220px", flexShrink: 0 }} />
        </header>
        <table>
          <thead>
            <tr>
              {isSuper ? <th>Company</th> : null}
              <th>Connection</th>
              <th>Added by</th>
              <th>Health</th>
              <th className="right">Usage</th>
              <th className="right">Credits</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {connectionsQ.isLoading ? (
              /* Rows the width of the columns they stand in, so the table does
                 not collapse to one centred line and then snap back open. */
              [0, 1, 2].map((i) => (
                <tr key={`skeleton-${i}`}>
                  {isSuper ? <td><Skel w="70%" h={12} /></td> : null}
                  <td><Skel w="80%" h={12} /><div style={{ height: 6 }} /><Skel w="55%" h={9} /></td>
                  <td><Skel w="65%" h={12} /></td>
                  <td><Skel w={64} h={12} /></td>
                  <td className="right"><Skel w={48} h={12} /></td>
                  <td className="right"><Skel w={56} h={12} /></td>
                  <td><Skel w={84} h={12} /></td>
                </tr>
              ))
            ) : connections.length === 0 ? (
              <tr><td colSpan={isSuper ? 7 : 6} className="muted" style={{ padding: "28px", textAlign: "center" }}>{filter ? "No connections match this filter." : "No company Serper connections have been added yet."}</td></tr>
            ) : connections.map((connection) => {
              const health = HEALTH_META[connection.health]
              return (
                <tr key={connection.id}>
                  {isSuper ? <td><b style={{ fontWeight: 500 }}>{connection.company.name}</b></td> : null}
                  <td>
                    <b style={{ fontWeight: 500 }}>{connection.label}</b>
                    <div className="muted" style={{ fontSize: "11.5px", marginTop: "3px" }}>Priority {connection.priority + 1} · added {dateTime(connection.addedAt)}</div>
                  </td>
                  <td>
                    <div>{personLabel(connection)}</div>
                    {connection.addedBy?.email && connection.addedBy.name ? <div className="muted" style={{ fontSize: "11.5px", marginTop: "3px" }}>{connection.addedBy.email}</div> : null}
                  </td>
                  <td>
                    <span className={`badge ${health.className}`}><span className="dot" />{health.label}</span>
                    {connection.unavailableUntil && connection.health === "cooling_down" ? <div className="muted" style={{ fontSize: "11.5px", marginTop: "5px" }}>Retry {dateTime(connection.unavailableUntil)}</div> : null}
                    {connection.lastFailureCode ? <div className="muted" style={{ fontSize: "11.5px", marginTop: "5px" }}>Last issue: {connection.lastFailureCode}</div> : null}
                  </td>
                  <td className="right">
                    <b>{compact(connection.successfulRequestCount)}</b>
                    <div className="muted" style={{ fontSize: "11.5px", marginTop: "3px" }}>{connection.creditsAtLastSync === null ? "observed total" : `${compact(connection.observedRequestsSinceCreditSync)} since snapshot`}</div>
                  </td>
                  <td className="right">
                    {(() => {
                      const meter = creditMeter(connection)
                      if (!meter) return <>
                        <span className="muted">Not recorded</span>
                        <div style={{ height: "6px", width: "132px", margin: "8px 0 0 auto", borderRadius: "999px", border: "1px dashed var(--cur-hairline-strong)" }} />
                        <div className="muted" style={{ fontSize: "11.5px", marginTop: "5px" }}>Add a Serper balance to track it</div>
                      </>
                      const barColor = meter.remainingPct > 25 ? "var(--cur-success)" : meter.remainingPct > 10 ? "var(--cur-primary)" : "var(--cur-error)"
                      return <>
                        <b>{compact(meter.remaining)} estimated left</b>
                        <div style={{ height: "6px", width: "132px", margin: "8px 0 0 auto", borderRadius: "999px", overflow: "hidden", background: "var(--cur-surface-strong)" }} aria-label={`${meter.remainingPct}% of the recorded Serper credit balance remains`} title={`${meter.remainingPct}% of the recorded balance remains`}>
                          <div style={{ width: `${meter.remainingPct}%`, height: "100%", borderRadius: "inherit", background: barColor }} />
                        </div>
                        <div className="muted" style={{ fontSize: "11.5px", marginTop: "5px" }}>{compact(meter.used)} used · {meter.remainingPct}% left · of {compact(meter.total)}</div>
                        <div className="muted" style={{ fontSize: "11.5px", marginTop: "3px" }}>snapshot {dateTime(connection.creditsSyncedAt)}</div>
                      </>
                    })()}
                  </td>
                  <td>
                    <div>{connection.lastUsedAt ? dateTime(connection.lastUsedAt) : "No successful search yet"}</div>
                    <div className="muted" style={{ fontSize: "11.5px", marginTop: "3px" }}>{connection.lastTestedAt ? `Last tested ${dateTime(connection.lastTestedAt)}` : "Not tested"}</div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="muted" style={{ fontSize: "12px", padding: "13px 18px", borderTop: "1px solid var(--cur-hairline-soft)" }}>
          To refresh a balance, enter the current Serper-dashboard value in the desktop Web Search tool. Divo does not query or infer provider credit balances.
        </div>
      </div>
    </div>
  )
}
