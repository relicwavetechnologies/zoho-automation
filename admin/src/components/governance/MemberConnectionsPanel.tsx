import { ArrowRight, Link2, ShieldCheck } from "lucide-react"
import { Link } from "react-router-dom"
import { useMemberConnections } from "@/cursor/use-connection-governance"

type Props = {
  token: string | null
  userId: string | undefined
  companyId?: string
}

const labelForSource = (source: string) => {
  if (source === "company_admin_override") return "Company override"
  if (source === "manager_policy") return "Manager policy"
  return "Platform defaults"
}

export function MemberConnectionsPanel({ token, userId, companyId }: Props) {
  const connections = useMemberConnections(token, userId, companyId)

  return (
    <section className="section mt24">
      <header>
        <div>
          <h3>Connections &amp; governance</h3>
          <p>Connection metadata, sharing, and company-admin operating controls. Credentials and account data stay private.</p>
        </div>
        <div className="badge">{connections.data?.length ?? "—"} connected</div>
      </header>
      {connections.isLoading ? (
        <div className="muted" style={{ padding: "22px 18px" }}>Loading connections…</div>
      ) : connections.isError ? (
        <div className="muted" style={{ padding: "22px 18px" }}>Could not load this member’s connections.</div>
      ) : connections.data?.length === 0 ? (
        <div className="muted" style={{ padding: "22px 18px" }}>No active connections for this member.</div>
      ) : (
        <div>
          {connections.data?.map((connection) => (
            <Link
              key={connection.id}
              to={`/people/${userId}/connections/${connection.id}`}
              style={{ display: "flex", gap: "14px", alignItems: "center", padding: "15px 18px", borderTop: "1px solid var(--cur-line)", color: "inherit", textDecoration: "none" }}
            >
              <div style={{ width: "32px", height: "32px", display: "grid", placeItems: "center", border: "1px solid var(--cur-line)", borderRadius: "8px", color: "var(--cur-muted)" }}><Link2 size={16} /></div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <b style={{ fontWeight: 500 }}>{connection.label}</b>
                  <span className="badge">{connection.provider.replace(/_/g, " ")}</span>
                  <span className={`badge ${connection.status === "connected" ? "b-ok" : "b-err"}`}>{connection.status}</span>
                </div>
                <div className="muted" style={{ fontSize: "12px", marginTop: "4px" }}>
                  {connection.accountEmail ?? connection.accountName ?? "No account label"} · {connection.ownerType === "company" ? "Company owned" : "Personal owner"} · {connection.grants.length} active grant{connection.grants.length === 1 ? "" : "s"}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "6px", color: connection.governance.source === "company_admin_override" ? "var(--cur-primary)" : "var(--cur-muted)", fontSize: "12px" }}>
                <ShieldCheck size={14} /> {labelForSource(connection.governance.source)} <ArrowRight size={14} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}
