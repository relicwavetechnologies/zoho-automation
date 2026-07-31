import { useEffect, useState } from "react"
import { CheckCircle2, Gauge, Save, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { useCompanyScope } from "@/cursor/use-spend"
import {
  type CompanyCapabilityGovernance,
  useCompanyCapabilityGovernance,
  useSaveCompanyCapabilityGovernance,
} from "@/cursor/use-connection-governance"

type CapabilityPolicy = CompanyCapabilityGovernance["policy"]

const parseLimit = (value: string): number | null | undefined => {
  if (value.trim() === "") return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function CapabilityCard({ capability, onSave, saving }: {
  capability: CompanyCapabilityGovernance
  onSave: (policy: CapabilityPolicy) => void
  saving: boolean
}) {
  const [draft, setDraft] = useState<CapabilityPolicy>(capability.policy)
  useEffect(() => setDraft(capability.policy), [capability])

  const save = () => {
    const rpm = parseLimit(String(draft.requestsPerMinute ?? ""))
    const daily = parseLimit(String(draft.requestsPerDay ?? ""))
    if (rpm === undefined || daily === undefined) {
      toast.error("Limits must be positive whole numbers, or left empty")
      return
    }
    onSave({ ...draft, requestsPerMinute: rpm, requestsPerDay: daily })
  }

  return (
    <section className="section">
      <header>
        <div><h3>{capability.label}</h3><p>{capability.description}</p></div>
        <span className={`badge ${draft.enabled ? "b-ok" : "b-err"}`}>{draft.enabled ? "Enabled" : "Disabled"}</span>
      </header>
      <div style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "minmax(160px, 1fr) minmax(130px, 0.7fr) minmax(130px, 0.7fr) minmax(180px, 1fr)", gap: "12px", alignItems: "end" }}>
        <label style={{ display: "grid", gap: "6px" }}><span className="muted" style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Availability</span><select className="input" value={draft.enabled ? "enabled" : "disabled"} onChange={(event) => setDraft((value) => ({ ...value, enabled: event.target.value === "enabled" }))}><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></label>
        <label style={{ display: "grid", gap: "6px" }}><span className="muted" style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Requests / min</span><input className="input" inputMode="numeric" placeholder="No cap" value={draft.requestsPerMinute ?? ""} onChange={(event) => { const next = parseLimit(event.target.value); if (next !== undefined) setDraft((value) => ({ ...value, requestsPerMinute: next })) }} /></label>
        <label style={{ display: "grid", gap: "6px" }}><span className="muted" style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Requests / day</span><input className="input" inputMode="numeric" placeholder="No cap" value={draft.requestsPerDay ?? ""} onChange={(event) => { const next = parseLimit(event.target.value); if (next !== undefined) setDraft((value) => ({ ...value, requestsPerDay: next })) }} /></label>
        <label style={{ display: "grid", gap: "6px" }}><span className="muted" style={{ fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Approval route</span><select className="input" value={draft.approval} onChange={(event) => setDraft((value) => ({ ...value, approval: event.target.value as CapabilityPolicy["approval"] }))}><option value="none">No approval</option><option value="company_admin">Company admin in Lark</option></select></label>
      </div>
      <div style={{ padding: "0 18px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
        <div className="muted" style={{ fontSize: "12px" }}>{capability.source === "company_admin" ? `Company policy revision ${capability.version}` : "Using platform default until your first save."}</div>
        <button className="btn primary" type="button" onClick={save} disabled={saving}><Save size={14} /> {saving ? "Saving…" : "Save policy"}</button>
      </div>
    </section>
  )
}

export function CompanyControlsPage() {
  const { token } = useAdminAuth()
  const companyId = useCompanyScope()
  const capabilities = useCompanyCapabilityGovernance(token, companyId)
  const save = useSaveCompanyCapabilityGovernance(token, companyId)

  return (
    <div className="page">
      <div className="profile">
        <div className="pic"><ShieldCheck size={21} /></div>
        <div>
          <h1 className="display">Company controls</h1>
          <div className="sub">Company-wide capability limits and approval routes.</div>
        </div>
      </div>

      <div className="grid g3">
        <div className="card metric feat"><div className="lbl">Company capabilities</div><div className="val display">{capabilities.data?.length ?? "—"}</div><div className="sub">centrally governed</div></div>
        <div className="card metric"><div className="lbl">Enabled</div><div className="val display">{capabilities.data?.filter((capability) => capability.policy.enabled).length ?? "—"}</div><div className="sub">available to permitted members</div></div>
        <div className="card metric"><div className="lbl">Admin policies</div><div className="val display">{capabilities.data?.filter((capability) => capability.source === "company_admin").length ?? "—"}</div><div className="sub">overriding platform defaults</div></div>
      </div>

      <section className="section mt24">
        <header><div><h3>How controls apply</h3><p>Company policy defines the outer boundary. Member and department permissions can narrow access but cannot exceed it.</p></div></header>
        <div style={{ padding: "16px 18px", display: "flex", gap: "12px", alignItems: "flex-start" }}><Gauge size={18} style={{ color: "var(--cur-primary)", marginTop: "2px" }} /><div style={{ fontSize: "13px" }}><b style={{ fontWeight: 500 }}>One policy authority</b><div className="muted" style={{ marginTop: "4px" }}>These policies are saved centrally and are designed to feed the same runtime preflight and approval engine as connection controls.</div></div></div>
      </section>

      <div className="stack mt24" style={{ display: "grid", gap: "16px" }}>
        {capabilities.isLoading ? <div className="section"><div className="muted" style={{ padding: "22px" }}>Loading company controls…</div></div> : null}
        {capabilities.data?.map((capability) => <CapabilityCard key={capability.id} capability={capability} saving={save.isPending} onSave={(policy) => save.mutate({ capabilityId: capability.id, policy }, { onSuccess: () => toast.success(`${capability.label} policy saved`) })} />)}
        {capabilities.isError ? <div className="section"><div className="muted" style={{ padding: "22px" }}>Could not load company controls.</div></div> : null}
      </div>

      <div className="muted" style={{ marginTop: "18px", display: "flex", gap: "7px", alignItems: "center", fontSize: "12px" }}><CheckCircle2 size={14} /> Connection-specific policies are managed from each person’s connection detail.</div>
    </div>
  )
}
