import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { DepartmentDetail } from "@/lib/api"

type Props = {
  detail: DepartmentDetail
  onSave: (data: { name?: string; description?: string | null; status?: "active" | "archived" }) => Promise<void>
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

export function OverviewTab({ detail, onSave }: Props) {
  const [name, setName] = useState(detail.department.name)
  const [description, setDescription] = useState(detail.department.description ?? "")
  const [status, setStatus] = useState<"active" | "archived">(
    detail.department.status === "archived" ? "archived" : "active",
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setName(detail.department.name)
    setDescription(detail.department.description ?? "")
    setStatus(detail.department.status === "archived" ? "archived" : "active")
  }, [detail])

  const dirty = useMemo(
    () =>
      name.trim() !== detail.department.name ||
      description.trim() !== (detail.department.description ?? "") ||
      status !== detail.department.status,
    [description, detail.department.description, detail.department.name, detail.department.status, name, status],
  )

  const handleSave = async () => {
    setBusy(true)
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        status,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Name</Label>
          <Input value={name} onChange={(event) => setName(event.target.value)} className="h-9 bg-card text-[13px]" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Status</Label>
          <Select value={status} onValueChange={(value) => setStatus(value as "active" | "archived")}>
            <SelectTrigger className="h-9 bg-card text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Description</Label>
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          className="min-h-[140px] bg-card text-[13px] leading-5"
          placeholder="What this department owns, how it operates, and where approvals should route."
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg bg-card p-3 shadow-soft">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Slug</p>
          <p className="mt-1 font-mono text-[12px] text-foreground/80">{detail.department.slug}</p>
        </div>
        <div className="rounded-lg bg-card p-3 shadow-soft">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Members / Roles</p>
          <p className="mt-1 text-[12px] text-foreground/80">
            {detail.memberships.length} members across {detail.roles.length} roles
          </p>
        </div>
        <div className="rounded-lg bg-card p-3 shadow-soft">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Created</p>
          <p className="mt-1 text-[12px] text-foreground/80">{formatDate(detail.department.createdAt)}</p>
        </div>
        <div className="rounded-lg bg-card p-3 shadow-soft">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Updated</p>
          <p className="mt-1 text-[12px] text-foreground/80">{formatDate(detail.department.updatedAt)}</p>
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          className="h-8 rounded-md bg-emphasis px-3 text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90"
          disabled={!dirty || busy || !name.trim()}
          onClick={handleSave}
        >
          Save overview
        </Button>
      </div>
    </div>
  )
}
