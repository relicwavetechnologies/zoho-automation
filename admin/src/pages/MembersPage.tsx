import { useMemo } from "react"
import { useNavigate } from "react-router-dom"
import { ChevronRight, Download } from "lucide-react"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { compact, usd, useCompanyScope, useDirectory, useSpendMembers } from "@/cursor/use-spend"
import { useProxyPolicies } from "@/cursor/use-proxy-policy"

const MODEL_LABEL: Record<string, string> = { "deepseek-v4-flash": "Flash", "deepseek-v4-pro": "Pro" }

export function MembersPage() {
  const navigate = useNavigate()
  const { token } = useAdminAuth()
  const companyId = useCompanyScope()
  const dir = useDirectory(token, companyId)
  const spend = useSpendMembers(token, 30, companyId)
  const policies = useProxyPolicies(token, companyId)

  const rows = useMemo(() => {
    const spendMap = new Map((spend.data?.members ?? []).map((m) => [m.userId, m]))
    const policyMap = new Map((policies.data ?? []).map((p) => [p.userId, p]))
    return (dir.data ?? []).map((d) => {
      const s = spendMap.get(d.userId)
      const pol = policyMap.get(d.userId)
      // No explicit policy ⇒ Flash-only default (matches the proxy gate).
      const models = pol && pol.allowedModels.length ? pol.allowedModels : ["deepseek-v4-flash"]
      return {
        userId: d.userId,
        name: d.name ?? d.email,
        dept: d.departmentNames?.[0] ?? "—",
        role: d.companyRole ?? "Member",
        runs: s?.runs ?? 0,
        tokens: compact(s?.tokens ?? 0),
        today: usd(s?.spendToday ?? 0),
        m30: usd(s?.spend30d ?? 0),
        blocked: pol?.blocked ?? false,
        models: models.map((m) => MODEL_LABEL[m] ?? m),
      }
    })
  }, [dir.data, spend.data, policies.data])

  const totals = spend.data?.totals
  const loading = dir.isLoading

  return (
    <div className="page">
      <div className="ph">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1 className="display">People</h1>
          <p>Members, their activity, and what each person is spending. Click anyone to open their profile.</p>
        </div>
        <button className="btn" type="button"><Download size={15} /> Export CSV</button>
      </div>

      <div className="grid g4" style={{ marginBottom: "24px" }}>
        <div className="card metric"><div className="lbl">Members</div><div className="val display">{dir.data?.length ?? "—"}</div><div className="sub">in directory</div></div>
        <div className="card metric"><div className="lbl">Spend · 30d</div><div className="val display">{totals ? usd(totals.spend30d) : "—"}</div><div className="sub">all members</div></div>
        <div className="card metric"><div className="lbl">Top spender</div><div className="val display" style={{ fontSize: "20px" }}>{totals?.topSpender?.name ?? "—"}</div><div className="sub">{totals?.topSpender ? `${usd(totals.topSpender.amount)} · 30d` : "no activity"}</div></div>
        <div className="card metric"><div className="lbl">Over limit</div><div className="val display">{totals?.overLimit.count ?? 0}</div><div className="sub">{totals?.overLimit.name ? `${totals.overLimit.name} · ${totals.overLimit.pct}% of cap` : "all within limits"}</div></div>
      </div>

      <div className="section">
        <table>
          <thead>
            <tr>
              <th>Member</th><th>Department</th><th>Role</th><th>Access</th>
              <th className="right">Runs 30d</th><th className="right">Tokens</th>
              <th className="right">Today</th><th className="right">30 days</th><th />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="muted" style={{ padding: "28px", textAlign: "center" }}>Loading members…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={9} className="muted" style={{ padding: "28px", textAlign: "center" }}>No members in the directory yet.</td></tr>
            ) : (
              rows.map((p) => (
                <tr key={p.userId} className="click" onClick={() => navigate(`/people/${p.userId}`)}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <div className="avatar">{(p.name || "?")[0].toUpperCase()}</div>
                      <b style={{ fontWeight: 500 }}>{p.name}</b>
                    </div>
                  </td>
                  <td className="muted">{p.dept}</td>
                  <td><span className="badge">{p.role}</span></td>
                  <td>
                    {policies.isLoading ? (
                      <span className="muted">…</span>
                    ) : p.blocked ? (
                      <span className="badge b-err"><span className="dot" />Blocked</span>
                    ) : (
                      <span style={{ display: "inline-flex", gap: "4px" }}>
                        {p.models.map((mm) => <span key={mm} className="badge" style={{ textTransform: "none" }}>{mm}</span>)}
                      </span>
                    )}
                  </td>
                  <td className="right">{p.runs}</td>
                  <td className="right mono">{p.tokens}</td>
                  <td className="right">{p.today}</td>
                  <td className="right"><b>{p.m30}</b></td>
                  <td className="right muted"><ChevronRight size={15} /></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
