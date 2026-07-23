import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { Ban, CheckCircle2, SlidersHorizontal } from "lucide-react"
import { toast } from "sonner"
import { StatusPill, Spark } from "@/cursor/components"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { useRuns } from "@/cursor/use-ai-ops"
import { compact, usd, useCompanyScope, useDirectory, useMemberSpend } from "@/cursor/use-spend"
import { PROXY_MODELS, useProxyPolicy, useSaveProxyPolicy } from "@/cursor/use-proxy-policy"
import { useProxyAudit } from "@/cursor/use-proxy"
import { companyMembersApi, type CompanyMemberRole } from "@/lib/api"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MemberConnectionsPanel } from "@/components/governance/MemberConnectionsPanel"

export function MemberDetailPage() {
  const { userId } = useParams()
  const navigate = useNavigate()
  const { token } = useAdminAuth()
  const companyId = useCompanyScope()

  const spend = useMemberSpend(token, userId, 30, companyId)
  const dir = useDirectory(token, companyId)
  const runs = useRuns(token, { userId, limit: 10 })

  // Proxy controls — the backend proxy's per-member guardrails (block / budget / rate / models).
  const policy = useProxyPolicy(token, userId, companyId)
  const savePolicy = useSaveProxyPolicy(token, companyId)
  const denials = useProxyAudit(token, companyId, { userId, decision: "denied", limit: 5 })
  const [blocked, setBlocked] = useState(false)
  const [budget, setBudget] = useState("")
  const [rate, setRate] = useState("")
  const [models, setModels] = useState<string[]>(["deepseek-v4-flash"])
  const [manageOpen, setManageOpen] = useState(false)
  const [roleDraft, setRoleDraft] = useState<CompanyMemberRole>("MEMBER")
  const [savingRole, setSavingRole] = useState(false)

  useEffect(() => {
    const p = policy.data
    if (!p) return
    setBlocked(p.blocked)
    setBudget(p.monthlyBudgetUsd != null ? String(p.monthlyBudgetUsd) : "")
    setRate(p.rateLimitRpm != null ? String(p.rateLimitRpm) : "")
    setModels(p.allowedModels.length ? p.allowedModels : ["deepseek-v4-flash"])
  }, [policy.data])

  const toggleModel = (id: string) =>
    setModels((prev) => (prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]))

  // Parse a limit field → null (cleared), a positive number, or undefined (invalid).
  // Mirrors the backend's zod rules (budget > 0; rate positive integer).
  const parseLimit = (raw: string, kind: "money" | "int"): number | null | undefined => {
    const t = raw.trim()
    if (t === "") return null
    const n = Number(t)
    if (!Number.isFinite(n) || n <= 0) return undefined
    return kind === "int" ? Math.round(n) : n
  }

  const saveControls = () => {
    if (!userId) return
    if (models.length === 0) { toast.error("Select at least one model"); return }
    const budgetVal = parseLimit(budget, "money")
    if (budgetVal === undefined) { toast.error("Budget cap must be a positive number, or empty for no cap"); return }
    const rateVal = parseLimit(rate, "int")
    if (rateVal === undefined) { toast.error("Rate limit must be a positive number, or empty for no limit"); return }
    // Reflect the normalized (rounded) values back into the inputs.
    setBudget(budgetVal != null ? String(budgetVal) : "")
    setRate(rateVal != null ? String(rateVal) : "")
    savePolicy.mutate(
      { userId, input: { blocked, monthlyBudgetUsd: budgetVal, rateLimitRpm: rateVal, allowedModels: models } },
      { onSuccess: () => toast.success("Controls saved") },
    )
  }

  const identity = (dir.data ?? []).find((d) => d.userId === userId)
  const s = spend.data
  const name = s?.name ?? identity?.name ?? identity?.email ?? "Member"
  const email = s?.email ?? identity?.email
  const dept = identity?.departmentNames?.[0]
  const role = identity?.companyRole

  const openRun = (runId: string) =>
    navigate(`/ai-ops/runs/${runId}`, { state: { from: "person", personId: userId, personName: name } })

  const openManage = () => {
    setRoleDraft(role === "COMPANY_ADMIN" ? "COMPANY_ADMIN" : "MEMBER")
    setManageOpen(true)
  }

  const saveRole = async () => {
    if (!userId) return
    setSavingRole(true)
    try {
      await companyMembersApi.updateRole(userId, {
        role: roleDraft,
        ...(companyId ? { companyId } : {}),
      }, token ?? undefined)
      await dir.refetch()
      setManageOpen(false)
      toast.success("Member role updated", { description: roleDraft === "COMPANY_ADMIN" ? "Company admin access granted." : "Company admin access removed." })
    } catch {
      // The API client has already shown the server's actionable error.
    } finally {
      setSavingRole(false)
    }
  }

  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/people">People</Link> › <span>{name}</span>
      </div>

      <div className="profile">
        <div className="pic">{(name || "?")[0].toUpperCase()}</div>
        <div style={{ flex: 1 }}>
          <h1 className="display">{name}</h1>
          <div className="sub">
            {email ? <span>{email}</span> : null}
            {dept ? <><span>·</span><span>{dept}</span></> : null}
            {role ? <><span>·</span><span className="badge">{role}</span></> : null}
          </div>
        </div>
        <button className="btn" type="button" onClick={openManage}><SlidersHorizontal size={15} /> Manage</button>
      </div>

      <div className="grid g4">
        <div className="card metric feat"><div className="lbl">Spend · 30 days</div><div className="val display">{s ? usd(s.spend30d) : "—"}</div><div className="sub">{s ? `${s.runs} runs` : "—"}</div></div>
        <div className="card metric"><div className="lbl">Spend today</div><div className="val display">{s ? usd(s.spendToday) : "—"}</div><div className="sub">today</div></div>
        <div className="card metric"><div className="lbl">Avg / run</div><div className="val display">{s ? usd(s.avgPerRun) : "—"}</div><div className="sub">{s ? `${compact(s.tokens)} tokens` : "—"}</div></div>
        <div className="card metric"><div className="lbl">Token limit</div><div className="val display">{s ? `${s.usagePct}%` : "—"}</div><div className="sub">{s ? `${compact(s.tokens)} of ${compact(s.monthlyLimit)} / mo` : "—"}</div></div>
      </div>

      {/* Access & limits — the backend proxy's per-member guardrails (block / budget / rate / models). */}
      <div className="section mt24">
        <header>
          <h3>Access &amp; limits</h3>
          <p>Enforced by the backend proxy in real time. {policy.data?.isDefault ? "No policy set — defaults to Flash-only." : "Model access is admin-controlled; the member can’t override it."}</p>
        </header>
        <div style={{ padding: "16px", display: "flex", gap: "22px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--cur-muted)", marginBottom: "6px" }}>Access</div>
            <button className="btn" type="button" onClick={() => setBlocked((v) => !v)} style={blocked ? { color: "var(--cur-error)", borderColor: "color-mix(in srgb, var(--cur-error) 40%, transparent)" } : undefined}>
              {blocked ? <><Ban size={14} /> Blocked</> : <><CheckCircle2 size={14} /> Active</>}
            </button>
          </div>
          <div>
            <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--cur-muted)", marginBottom: "6px" }}>Model access</div>
            <div style={{ display: "flex", gap: "7px" }}>
              {PROXY_MODELS.map((m) => {
                const on = models.includes(m.id)
                return (
                  <button key={m.id} className="btn" type="button" onClick={() => toggleModel(m.id)}
                    style={on ? { color: "var(--cur-primary)", borderColor: "color-mix(in srgb, var(--cur-primary) 45%, transparent)", background: "color-mix(in srgb, var(--cur-primary) 8%, transparent)" } : { color: "var(--cur-muted)" }}>
                    {on ? <CheckCircle2 size={14} /> : null} {m.label}
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--cur-muted)", marginBottom: "6px" }}>Monthly budget cap ($)</div>
            <input className="input" style={{ width: "120px" }} placeholder="No cap" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </div>
          <div>
            <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--cur-muted)", marginBottom: "6px" }}>Rate limit (req/min)</div>
            <input className="input" style={{ width: "120px" }} placeholder="No limit" value={rate} onChange={(e) => setRate(e.target.value)} />
          </div>
          <button className="btn primary" type="button" onClick={saveControls} disabled={savePolicy.isPending || policy.isLoading}>
            {savePolicy.isPending ? "Saving…" : "Save controls"}
          </button>
        </div>
        {/* Spend vs cap — month-to-date, the exact window the proxy gate enforces */}
        {policy.data?.monthlyBudgetUsd != null && s ? (() => {
          const cap = policy.data.monthlyBudgetUsd!
          const pct = cap > 0 ? Math.min(100, Math.round((s.spendMtd / cap) * 100)) : 0
          const near = pct >= 85
          return (
            <div style={{ padding: "0 16px 16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--cur-muted)", marginBottom: "5px" }}>
                <span>Spend vs cap (this month)</span>
                <span><b style={{ color: near ? "var(--cur-error)" : "var(--cur-ink)" }}>{usd(s.spendMtd)}</b> / {usd(cap)} · {pct}%</span>
              </div>
              <div style={{ height: "6px", borderRadius: "999px", background: "var(--cur-surface-strong)", overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: near ? "var(--cur-error)" : "var(--cur-primary)" }} />
              </div>
            </div>
          )
        })() : null}
        {/* Recent denials for this member (from the proxy audit log) */}
        {(denials.data ?? []).length > 0 ? (
          <div style={{ padding: "0 16px 16px" }}>
            <div style={{ fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--cur-muted)", marginBottom: "6px" }}>Recent denials</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {denials.data!.map((d) => (
                <div key={d.id} style={{ display: "flex", gap: "10px", alignItems: "center", fontSize: "12.5px" }}>
                  <span className="mono muted">{new Date(d.createdAt).toLocaleString()}</span>
                  <span className="badge b-err"><span className="dot" />{d.reason ?? "denied"}</span>
                  <span className="mono muted">{d.model}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <MemberConnectionsPanel token={token} userId={userId} companyId={companyId} />

      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="border-border/40 bg-mat sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-semibold">Manage member</DialogTitle>
            <DialogDescription className="text-[12px]">Set this person’s company-level access. Department roles are managed from the Department page.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" htmlFor="company-role">Company role</Label>
            <Select value={roleDraft} onValueChange={(value) => setRoleDraft(value as CompanyMemberRole)}>
              <SelectTrigger id="company-role" className="h-9 bg-card text-[13px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="MEMBER">Member</SelectItem>
                <SelectItem value="COMPANY_ADMIN">Company Admin</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[12px] text-muted-foreground">A company must always retain at least one active Company Admin. Super Admin is platform-only and cannot be assigned here.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" className="h-8 text-[12px]" onClick={() => setManageOpen(false)} disabled={savingRole}>Cancel</Button>
            <Button type="button" size="sm" className="h-8 bg-emphasis text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90" onClick={() => void saveRole()} disabled={savingRole || roleDraft === role}>{savingRole ? "Saving…" : "Save role"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid g2 mt24">
        <div className="section">
          <header><h3>Spend · last 14 days</h3><p>This member</p></header>
          <div style={{ padding: "18px" }}><Spark values={s?.sparkline ?? Array(14).fill(6)} /></div>
          <div style={{ padding: "0 18px 18px" }}><div className="muted" style={{ fontSize: "12.5px" }}>Provider-reported cost · mostly cache-hit input</div></div>
        </div>
        <div className="section">
          <header><h3>Cost by model</h3></header>
          <table>
            <tbody>
              {(s?.costByModel ?? []).length === 0 ? (
                <tr><td className="muted" style={{ padding: "18px" }}>No model usage yet.</td></tr>
              ) : (
                s!.costByModel.map((m) => (
                  <tr key={m.modelId}><td className="mono">{m.modelId}</td><td className="right muted">{m.runs} runs</td><td className="right"><b>{usd(m.costUsd)}</b></td></tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section mt24">
        <header><h3>Recent runs</h3><p>Click a run to open its full trace</p></header>
        <table>
          <thead>
            <tr><th>Run</th><th>Channel</th><th>Status</th><th className="right">Turns</th><th className="right">Tokens</th><th className="right">Cost</th><th>Started</th></tr>
          </thead>
          <tbody>
            {runs.isLoading ? (
              <tr><td colSpan={7} className="muted" style={{ padding: "24px", textAlign: "center" }}>Loading runs…</td></tr>
            ) : (runs.data ?? []).length === 0 ? (
              <tr><td colSpan={7} className="muted" style={{ padding: "24px", textAlign: "center" }}>No runs for this member yet.</td></tr>
            ) : (
              runs.data!.map((r) => (
                <tr key={r.id} className="click" onClick={() => openRun(r.id)}>
                  <td className="mono">{r.shortId}</td>
                  <td className="muted">{r.channel}</td>
                  <td><StatusPill status={r.status} /></td>
                  <td className="right">{r.turns}</td>
                  <td className="right mono">{r.tokensLabel}</td>
                  <td className="right"><b>{r.costLabel}</b></td>
                  <td className="muted">{r.startedLabel}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
