import { useEffect, useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, Building2, RotateCcw, Save, ShieldCheck, UserRound } from "lucide-react"
import { toast } from "sonner"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { useCompanyScope } from "@/cursor/use-spend"
import {
  CONNECTION_ACTIONS,
  defaultConnectionGovernancePolicy,
  type ActionGovernance,
  type ConnectionAction,
  type ConnectionGovernancePolicy,
  useMemberConnection,
  useSaveConnectionGovernance,
} from "@/cursor/use-connection-governance"

const ACTION_LABEL: Record<ConnectionAction, string> = {
  read: "Read",
  create: "Create",
  update: "Update",
  delete: "Delete",
  send: "Send",
  execute: "Execute",
}

const humanDate = (value: string | null) => value ? new Date(value).toLocaleString() : "Never"

function cleanLimit(value: string): number | null | undefined {
  if (value.trim() === "") return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

export function ConnectionGovernancePage() {
  const { userId, connectionId } = useParams()
  const { token } = useAdminAuth()
  const companyId = useCompanyScope()
  const connection = useMemberConnection(token, userId, connectionId, companyId)
  const save = useSaveConnectionGovernance(token, companyId)
  const [policy, setPolicy] = useState<ConnectionGovernancePolicy>(defaultConnectionGovernancePolicy())

  useEffect(() => {
    if (connection.data) setPolicy(connection.data.governance.adminOverride)
  }, [connection.data])

  const hasCompanyOverride = connection.data?.governance.source === "company_admin_override"
  const managerPolicy = connection.data?.governance.managerPolicy
  const actionRows = useMemo(() => CONNECTION_ACTIONS.map((action) => ({
    action,
    value: policy.actions[action] ?? { mode: "inherit" as const },
    manager: managerPolicy?.actions[action],
  })), [managerPolicy, policy])

  const changeAction = (action: ConnectionAction, patch: Partial<ActionGovernance>) => {
    setPolicy((current) => ({
      ...current,
      actions: { ...current.actions, [action]: { ...current.actions[action], ...patch } },
    }))
  }

  const savePolicy = () => {
    for (const action of CONNECTION_ACTIONS) {
      const value = policy.actions[action]
      if (value.mode === "enforced" && !value.approval) {
        toast.error(`${ACTION_LABEL[action]} needs an approval setting`)
        return
      }
    }
    if (!connectionId) return
    save.mutate({ connectionId, adminOverride: policy }, {
      onSuccess: () => toast.success("Company override saved", { description: "The next runtime policy check will use these action-level controls." }),
    })
  }

  if (connection.isLoading) return <div className="page"><div className="muted">Loading connection governance…</div></div>
  if (!connection.data) return <div className="page"><Link to={`/people/${userId}`} className="btn"><ArrowLeft size={15} /> Back to member</Link><div className="section mt24"><div className="muted" style={{ padding: "22px" }}>This connection is unavailable or no longer belongs to this member.</div></div></div>

  const data = connection.data
  return (
    <div className="page">
      <div className="crumbs"><Link to="/people">People</Link> › <Link to={`/people/${userId}`}>Member</Link> › <span>{data.label}</span></div>
      <div className="profile">
        <div className="pic"><ShieldCheck size={21} /></div>
        <div style={{ flex: 1 }}>
          <h1 className="display">{data.label}</h1>
          <div className="sub"><span>{data.provider.replace(/_/g, " ")}</span><span>·</span><span>{data.accountEmail ?? data.accountName ?? "Connected account"}</span><span>·</span><span className="badge">{data.status}</span></div>
        </div>
        <button className="btn" type="button" onClick={() => setPolicy(defaultConnectionGovernancePolicy())} disabled={!hasCompanyOverride || save.isPending}><RotateCcw size={15} /> Reset override draft</button>
        <button className="btn primary" type="button" onClick={savePolicy} disabled={save.isPending}><Save size={15} /> {save.isPending ? "Saving…" : "Save controls"}</button>
      </div>

      <div className="grid g3">
        <div className="card metric"><div className="lbl">Ownership</div><div className="val" style={{ fontSize: "18px" }}>{data.ownerType === "company" ? "Company" : "Personal"}</div><div className="sub">{data.owner?.email ?? "No named owner"}</div></div>
        <div className="card metric"><div className="lbl">Active grants</div><div className="val display">{data.grants.length}</div><div className="sub">people, teams, or roles</div></div>
        <div className="card metric"><div className="lbl">Last used</div><div className="val" style={{ fontSize: "18px" }}>{data.lastUsedAt ? new Date(data.lastUsedAt).toLocaleDateString() : "—"}</div><div className="sub">connected {new Date(data.connectedAt).toLocaleDateString()}</div></div>
      </div>

      <section className="section mt24">
        <header>
          <div><h3>Company-admin override</h3><p>Set only the actions you want to control. “Use manager/default” leaves the connection’s lower-level policy untouched.</p></div>
          <span className={`badge ${hasCompanyOverride ? "b-ok" : ""}`}>{hasCompanyOverride ? "Override active" : "Using lower policy"}</span>
        </header>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Action</th><th>Policy source</th><th>Requests / min</th><th>Requests / day</th><th>Approval route</th></tr></thead>
            <tbody>
              {actionRows.map(({ action, value, manager }) => {
                const inherited = value.mode === "inherit"
                return (
                  <tr key={action}>
                    <td><b style={{ fontWeight: 500 }}>{ACTION_LABEL[action]}</b><div className="muted" style={{ fontSize: "11.5px", marginTop: "3px" }}>{manager?.mode === "enforced" ? "Manager policy available" : "Platform default if not overridden"}</div></td>
                    <td>
                      <select className="input" value={value.mode} onChange={(event) => changeAction(action, event.target.value === "enforced" ? { mode: "enforced", approval: value.approval ?? "connection_owner" } : { mode: "inherit", requestsPerMinute: null, requestsPerDay: null, approval: undefined })}>
                        <option value="inherit">Use manager/default</option>
                        <option value="enforced">Company override</option>
                      </select>
                    </td>
                    <td><input className="input" inputMode="numeric" disabled={inherited} placeholder="No cap" value={value.requestsPerMinute ?? ""} onChange={(event) => { const next = cleanLimit(event.target.value); if (next === undefined) return; changeAction(action, { requestsPerMinute: next }) }} /></td>
                    <td><input className="input" inputMode="numeric" disabled={inherited} placeholder="No cap" value={value.requestsPerDay ?? ""} onChange={(event) => { const next = cleanLimit(event.target.value); if (next === undefined) return; changeAction(action, { requestsPerDay: next }) }} /></td>
                    <td>
                      <select className="input" disabled={inherited} value={value.approval ?? "connection_owner"} onChange={(event) => changeAction(action, { approval: event.target.value as ActionGovernance["approval"] })}>
                        <option value="none">No approval</option>
                        <option value="connection_owner">Connection owner in Lark</option>
                        <option value="company_admin">Company admin in Lark</option>
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {data.governance.adminOverriddenAt ? <div className="muted" style={{ padding: "0 18px 16px", fontSize: "12px" }}>Last company change: {humanDate(data.governance.adminOverriddenAt)} · policy revision {data.governance.version}</div> : null}
      </section>

      <div className="grid g2 mt24">
        <section className="section">
          <header><div><h3>Access grants</h3><p>Who can use this connection. Governance controls do not add access.</p></div></header>
          {data.grants.length === 0 ? <div className="muted" style={{ padding: "18px" }}>No active grants.</div> : data.grants.map((grant) => (
            <div key={grant.id} style={{ padding: "14px 18px", borderTop: "1px solid var(--cur-line)", display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <div><b style={{ fontWeight: 500 }}>{grant.granteeType} · {grant.granteeId}</b><div className="muted" style={{ fontSize: "12px", marginTop: "4px" }}>Granted {humanDate(grant.grantedAt)}</div></div><span className="badge">{grant.access.replace(/_/g, " ")}</span>
            </div>
          ))}
        </section>
        <section className="section">
          <header><div><h3>Connection details</h3><p>Safe operational metadata only.</p></div></header>
          <div style={{ padding: "18px", display: "grid", gap: "13px", fontSize: "13px" }}>
            <div><div className="muted">Owner</div><div style={{ display: "flex", gap: "6px", alignItems: "center", marginTop: "3px" }}>{data.ownerType === "company" ? <Building2 size={14} /> : <UserRound size={14} />}{data.owner?.name ?? data.owner?.email ?? "Unassigned"}</div></div>
            <div><div className="muted">Granted scopes</div><div style={{ marginTop: "5px", display: "flex", gap: "5px", flexWrap: "wrap" }}>{data.scopes.length ? data.scopes.map((scope) => <span key={scope} className="badge">{scope}</span>) : <span>Not reported</span>}</div></div>
            <div><div className="muted">Manager policy</div><div style={{ marginTop: "3px" }}>{data.governance.managerPolicy ? "Present — company overrides take precedence" : "Not configured yet"}</div></div>
          </div>
        </section>
      </div>
    </div>
  )
}
