import { Link, useParams } from "react-router-dom"
import {
  ArrowLeft,
  CheckCircle2,
  KeyRound,
  type LucideIcon,
  ShieldCheck,
  User,
  Users,
} from "lucide-react"
import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/admin/page-header"
import { SectionCard } from "@/components/admin/section-card"
import { StatusBadge } from "@/components/admin/status-badge"
import { MetricCard } from "@/components/admin/metric-card"
import { cn } from "@/lib/utils"
import {
  getAdminProfileByUserId,
  getAdminProfilePreviewByUserId,
  type AdminConnectionAccess,
  type AdminUserConnection,
} from "@/lib/admin-user-connections"

export function MemberDetailPage() {
  const { userId } = useParams()
  const exactProfile = getAdminProfileByUserId(userId)
  const profile = getAdminProfilePreviewByUserId(userId)

  if (!profile) {
    return (
      <>
        <PageHeader
          eyebrow="People"
          title="Member connection profile"
          description="This user is not in the local UI fixture yet. Backend wiring will hydrate this route from the selected member."
          actions={
            <Button asChild variant="outline" className="rounded-full">
              <Link to="/people">
                <ArrowLeft className="h-4 w-4" />
                Back to people
              </Link>
            </Button>
          }
        />
        <SectionCard title="No connection data" description="The route is ready for live data, but this user has no mocked connection profile.">
          <div className="rounded-lg border border-dashed bg-card/60 p-8 text-center">
            <p className="text-sm font-medium">No plugin connection records found</p>
            <p className="mt-2 text-[12px] text-muted-foreground">
              Once the backend connection registry is available, this page should load by user id and company id.
            </p>
          </div>
        </SectionCard>
      </>
    )
  }

  const personalCount = profile.connections.filter((connection) => connection.kind === "personal").length
  const sharedCount = profile.connections.filter((connection) => connection.kind === "company_shared").length
  const readOnlyCount = profile.connections.filter((connection) => connection.access === "read_only").length

  return (
    <>
      <PageHeader
        eyebrow="People"
        title={profile.name}
        description={
          exactProfile
            ? "Review this member's personal connections, shared grants, connection admins, and what Pi can select at runtime."
            : "Preview this member's connection surface before live backend connection records are wired."
        }
        actions={
          <>
            <Button asChild variant="outline" className="rounded-full">
              <Link to="/people">
                <ArrowLeft className="h-4 w-4" />
                Back
              </Link>
            </Button>
            <Button className="rounded-full">
              <KeyRound className="h-4 w-4" />
              Grant connection
            </Button>
          </>
        }
      />

      <section className="grid gap-3 md:grid-cols-4">
        <MetricCard label="Connections" value={String(profile.connections.length)} detail={`${personalCount} personal, ${sharedCount} shared`} icon={KeyRound} tone="primary" />
        <MetricCard label="Read-only grants" value={String(readOnlyCount)} detail="Scoped shared access" icon={ShieldCheck} />
        <MetricCard label="Departments" value={String(profile.departments.length)} detail={profile.departments.join(", ")} icon={Users} />
        <MetricCard label="Role" value={profile.role === "COMPANY_ADMIN" ? "Admin" : "Member"} detail={profile.canShareConnections ? "Can share accounts" : "Cannot share accounts"} icon={User} tone={profile.canShareConnections ? "accent" : "default"} />
      </section>

      <section className="grid gap-3 xl:grid-cols-[0.8fr_1.2fr]">
        <SectionCard title="Identity and authority" description="Who this user is, who manages them, and whether they can administer shared connections.">
          <div className="space-y-3">
            <IdentityRow label="Email" value={profile.email} />
            <IdentityRow label="Status" value={<StatusBadge value={profile.status} />} />
            <IdentityRow label="Workspace role" value={profile.role.replace("_", " ")} />
            <IdentityRow label="Manager / admin" value={profile.managerName ? `${profile.managerName} · ${profile.managerEmail}` : "No manager assigned"} />
            <IdentityRow label="Departments" value={profile.departments.join(", ")} />
            <IdentityRow
              label="Connection admin"
              value={profile.canShareConnections ? "Can connect and share company accounts" : "Uses personal and granted shared accounts only"}
            />
          </div>
        </SectionCard>

        <SectionCard title="Administered connections" description="Shared accounts this user controls for other people or departments.">
          {profile.administeredConnections.length ? (
            <div className="grid gap-2 md:grid-cols-2">
              {profile.administeredConnections.map((connection) => (
                <div key={connection} className="rounded-lg bg-card p-3 shadow-soft">
                  <div className="flex items-start gap-2">
                    <ShieldCheck className="mt-0.5 h-4 w-4 text-accent" />
                    <div>
                      <p className="text-[13px] font-semibold">{connection}</p>
                      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                        Can update grants, review users, and revoke access from the shared account.
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-6 text-center">
              <p className="text-[13px] font-semibold">No administered shared accounts</p>
              <p className="mt-1 text-[11px] text-muted-foreground">This member cannot share company connections.</p>
            </div>
          )}
        </SectionCard>
      </section>

      <section className="grid gap-3 xl:grid-cols-[1.2fr_0.8fr]">
        <SectionCard title="Connections visible to this user" description="Personal accounts and admin-granted shared accounts shown in this user's desktop plugin page.">
          <div className="space-y-3">
            {profile.connections.map((connection) => (
              <ConnectionCard key={connection.id} connection={connection} />
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Pi connection context" description="The instruction layer should expose selectable aliases, account purpose, and constraints.">
          <div className="space-y-2">
            {profile.connections.map((connection) => (
              <div key={connection.id} className="rounded-lg bg-card p-3 shadow-soft">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold">{connection.piAlias}</p>
                    <p className="mt-1 truncate text-[11px] text-muted-foreground">{connection.accountEmail}</p>
                  </div>
                  <AccessBadge access={connection.access} />
                </div>
                <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{connection.policy}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      </section>
    </>
  )
}

function IdentityRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg bg-card p-3 shadow-soft">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="max-w-[70%] text-right text-[13px] font-medium">{value}</div>
    </div>
  )
}

function ConnectionCard({ connection }: { connection: AdminUserConnection }) {
  const isShared = connection.kind === "company_shared"

  return (
    <article className="rounded-lg bg-card p-3 shadow-soft">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-semibold">{connection.label}</p>
            <Badge variant={isShared ? "secondary" : "outline"}>{isShared ? "shared" : "personal"}</Badge>
            <AccessBadge access={connection.access} />
            <StatusBadge value={connection.status} />
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">{connection.accountEmail}</p>
          <p className="mt-2 max-w-3xl text-[12px] leading-5 text-muted-foreground">{connection.policy}</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0 rounded-full">
          Review grant
        </Button>
      </div>

      <div className="mt-3 grid gap-2 border-t pt-3 md:grid-cols-3">
        <ConnectionFact icon={User} label={isShared ? "Connection owner" : "Owned by"} value={`${connection.ownerName} · ${connection.ownerEmail}`} />
        <ConnectionFact icon={ShieldCheck} label={isShared ? "Shared by admin" : "Admin"} value={`${connection.adminName ?? connection.ownerName} · ${connection.adminEmail ?? connection.ownerEmail}`} />
        <ConnectionFact icon={Users} label="Grant source" value={connection.sharedFrom ?? connection.sharedTo.join(", ")} />
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {connection.services.map((service) => {
          const Icon = service.icon
          return (
            <div key={`${connection.id}-${service.name}`} className="flex items-center gap-2 rounded-md border bg-background/40 px-2 py-2">
              <Icon className="h-4 w-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{service.name}</span>
              <AccessBadge access={service.access} compact />
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {connection.scopes.map((scope) => (
          <span key={scope} className="rounded-full border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {scope}
          </span>
        ))}
      </div>
    </article>
  )
}

function ConnectionFact({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-background/40 p-2">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="mt-1 truncate text-[12px] font-medium">{value}</p>
    </div>
  )
}

function AccessBadge({ access, compact }: { access: AdminConnectionAccess; compact?: boolean }) {
  const label = access === "read_only" ? "read-only" : access === "read_write" ? "read/write" : "admin"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold",
        compact ? "text-[10px]" : "text-xs",
        access === "read_only" && "border-amber-400/30 bg-amber-400/10 text-amber-300",
        access === "read_write" && "border-accent/30 bg-accent/10 text-accent",
        access === "admin" && "border-primary/30 bg-primary/10 text-primary",
      )}
    >
      {access === "read_only" ? <ShieldCheck className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
      {label}
    </span>
  )
}
