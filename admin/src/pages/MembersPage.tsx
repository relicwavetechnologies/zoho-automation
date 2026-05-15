import { FormEvent, useMemo, useState } from "react"
import { Loader2, Plus, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { DataTable } from "@/components/admin/data-table"
import { PageHeader } from "@/components/admin/page-header"
import { SectionCard } from "@/components/admin/section-card"
import { StatusBadge } from "@/components/admin/status-badge"
import { useApiList } from "@/components/admin/use-api-list"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAdminAuth } from "@/auth/AdminAuthProvider"
import { api } from "@/lib/api"
import type { JsonRecord } from "@/components/admin/types"

type InviteRole = "MEMBER" | "COMPANY_ADMIN"

const withQuery = (path: string, params: Record<string, string | undefined>) => {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value) query.set(key, value)
  })
  const suffix = query.toString()
  return suffix ? `${path}?${suffix}` : path
}

export function MembersPage() {
  const { token, session } = useAdminAuth()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState("")
  const [roleId, setRoleId] = useState<InviteRole>("MEMBER")
  const [submitting, setSubmitting] = useState(false)
  const companyId = session?.role === "SUPER_ADMIN" ? session.companyId : undefined
  const directoryPath = useMemo(() => withQuery("/api/admin/company/directory", { companyId }), [companyId])
  const invitesPath = useMemo(() => withQuery("/api/admin/company/invites", { companyId }), [companyId])
  const directory = useApiList<JsonRecord>(directoryPath, token, ["items", "members"])
  const invites = useApiList<JsonRecord>(invitesPath, token, ["items", "invites"])

  const [syncing, setSyncing] = useState(false)

  const refreshAll = async () => {
    await Promise.all([directory.refresh(), invites.refresh()])
  }

  const syncFromLark = async () => {
    if (!token) return
    setSyncing(true)
    try {
      const result = await api.post<{ synced: number }>("/api/admin/company/sync-directory", {}, token)
      toast.success(`Synced ${result.synced} users from Lark`)
      await refreshAll()
    } catch {
      toast.error("Sync failed")
    } finally {
      setSyncing(false)
    }
  }

  const createInvite = async (event: FormEvent) => {
    event.preventDefault()
    if (!token) return
    setSubmitting(true)
    try {
      await api.post("/api/admin/company/invites", { email, roleId }, token)
      toast.success("Invite created")
      setEmail("")
      setRoleId("MEMBER")
      setOpen(false)
      await refreshAll()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="People"
        title="Members and invites"
        description="Review workspace identities and send onboarding invites from the live company admin API."
        actions={
          <>
            <Button type="button" variant="outline" className="rounded-full" onClick={() => void syncFromLark()} disabled={syncing}>
              <RefreshCw className={syncing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              {syncing ? "Syncing…" : "Sync from Lark"}
            </Button>
            <Button type="button" variant="outline" className="rounded-full" onClick={() => void refreshAll()} disabled={directory.refreshing || invites.refreshing}>
              <RefreshCw className={directory.refreshing || invites.refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
              Refresh
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button type="button" className="rounded-full">
                  <Plus className="h-4 w-4" />
                  Invite member
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create invite</DialogTitle>
                  <DialogDescription>Send an invite token for a workspace role.</DialogDescription>
                </DialogHeader>
                <form className="space-y-4" onSubmit={createInvite}>
                  <div className="space-y-2">
                    <Label htmlFor="invite-email">Email</Label>
                    <Input id="invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="invite-role">Role</Label>
                    <Select value={roleId} onValueChange={(value) => setRoleId(value as InviteRole)}>
                      <SelectTrigger id="invite-role">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MEMBER">Member</SelectItem>
                        <SelectItem value="COMPANY_ADMIN">Company admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <DialogFooter>
                    <Button type="submit" disabled={submitting}>
                      {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Send invite
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </>
        }
      />
      <section className="grid gap-3 xl:grid-cols-[1.15fr_0.85fr]">
        <SectionCard title="Directory" description="Active known workspace identities.">
          <DataTable
            rows={directory.data}
            loading={directory.loading}
            emptyTitle="No members found"
            emptyDescription="Members will appear after directory sync or invite acceptance."
            columns={[
              { key: "email", header: "Email" },
              { key: "name", header: "Name" },
              { key: "role", header: "Role" },
              { key: "status", header: "Status", render: (row) => <StatusBadge value={String(row.status ?? "active")} /> },
            ]}
          />
        </SectionCard>
        <SectionCard title="Pending invites" description="Outstanding invite tokens and their state.">
          <DataTable
            rows={invites.data}
            loading={invites.loading}
            emptyTitle="No pending invites"
            emptyDescription="Create an invite when a new teammate needs access."
            columns={[
              { key: "email", header: "Email" },
              { key: "roleId", header: "Role" },
              { key: "status", header: "Status", render: (row) => <StatusBadge value={String(row.status ?? "")} /> },
            ]}
          />
        </SectionCard>
      </section>
    </>
  )
}
