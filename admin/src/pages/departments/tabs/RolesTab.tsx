import { useEffect, useMemo, useState } from "react"
import { Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { DepartmentRole } from "@/lib/api"

type Props = {
  departmentId: string
  roles: DepartmentRole[]
  onCreate: (departmentId: string, data: { name: string; slug: string; zohoReadScope?: "personalized" | "show_all" }) => Promise<void>
  onUpdate: (departmentId: string, roleId: string, data: { name: string; isDefault?: boolean; zohoReadScope?: "personalized" | "show_all" }) => Promise<void>
  onDelete: (departmentId: string, roleId: string) => Promise<void>
}

type RoleDraft = {
  name: string
  isDefault: boolean
  zohoReadScope: "personalized" | "show_all"
}

export function RolesTab({ departmentId, roles, onCreate, onUpdate, onDelete }: Props) {
  const [drafts, setDrafts] = useState<Record<string, RoleDraft>>({})
  const [newName, setNewName] = useState("")
  const [newSlug, setNewSlug] = useState("")
  const [newScope, setNewScope] = useState<"personalized" | "show_all">("personalized")
  const [busyId, setBusyId] = useState<string | null>(null)
  const [createBusy, setCreateBusy] = useState(false)

  useEffect(() => {
    setDrafts(
      Object.fromEntries(
        roles.map((role) => [
          role.id,
          {
            name: role.name,
            isDefault: role.isDefault,
            zohoReadScope: role.zohoReadScope === "show_all" ? "show_all" : "personalized",
          },
        ]),
      ),
    )
  }, [roles])

  const defaultRoleId = useMemo(
    () => roles.find((role) => role.isDefault)?.id ?? null,
    [roles],
  )

  const handleCreate = async () => {
    if (!newName.trim() || !newSlug.trim()) return
    setCreateBusy(true)
    try {
      await onCreate(departmentId, {
        name: newName.trim(),
        slug: newSlug.trim(),
        zohoReadScope: newScope,
      })
      setNewName("")
      setNewSlug("")
      setNewScope("personalized")
    } finally {
      setCreateBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-card p-3 shadow-soft">
        <div className="grid gap-3 md:grid-cols-[1.2fr_1fr_auto] md:items-end">
          <div className="space-y-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Role name</Label>
            <Input value={newName} onChange={(event) => setNewName(event.target.value)} className="h-9 bg-card text-[13px]" placeholder="e.g. Analyst" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Role slug</Label>
            <Input value={newSlug} onChange={(event) => setNewSlug(event.target.value)} className="h-9 bg-card text-[13px]" placeholder="ANALYST" />
          </div>
          <Button
            type="button"
            className="h-9 rounded-md bg-emphasis px-3 text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90"
            disabled={createBusy || !newName.trim() || !newSlug.trim()}
            onClick={handleCreate}
          >
            Add role
          </Button>
        </div>
        <label className="mt-3 flex items-center justify-between rounded-md border border-border/60 bg-mat p-2.5">
          <div>
            <p className="text-[12px] font-medium">Zoho data personalization</p>
            <p className="text-[10px] text-muted-foreground">ON = members only see records matching their email</p>
          </div>
          <Switch checked={newScope === "personalized"} onCheckedChange={(checked) => setNewScope(checked ? "personalized" : "show_all")} />
        </label>
      </div>

      <div className="space-y-2">
        {roles.map((role) => {
          const draft = drafts[role.id]
          if (!draft) return null

          const isDirty =
            draft.name.trim() !== role.name ||
            draft.isDefault !== role.isDefault ||
            draft.zohoReadScope !== (role.zohoReadScope === "show_all" ? "show_all" : "personalized")

          return (
            <div key={role.id} className="rounded-lg bg-card p-3 shadow-soft">
              <div className="grid gap-3 md:grid-cols-[1.2fr_auto_auto] md:items-end">
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Role</Label>
                    <span className="rounded-full bg-secondary px-2 py-0.5 font-mono text-[10px] text-muted-foreground">{role.slug}</span>
                    {role.isSystem ? <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700 dark:bg-blue-500/15 dark:text-blue-300">System</span> : null}
                    {role.id === defaultRoleId ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">Default</span> : null}
                  </div>
                  <Input
                    value={draft.name}
                    onChange={(event) => setDrafts((prev) => ({ ...prev, [role.id]: { ...draft, name: event.target.value } }))}
                    className="h-9 bg-card text-[13px]"
                  />
                </div>

                <label className="flex h-9 items-center gap-2 rounded-md border border-border/60 bg-card px-3 text-[12px] text-foreground/80">
                  <Checkbox
                    checked={draft.isDefault}
                    onCheckedChange={(checked) =>
                      setDrafts((prev) => ({ ...prev, [role.id]: { ...draft, isDefault: checked === true } }))
                    }
                  />
                  Default role
                </label>

                <div className="flex items-center justify-end gap-2">
                  {!role.isSystem ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 px-2 text-[12px]"
                      disabled={busyId === role.id}
                      onClick={async () => {
                        setBusyId(role.id)
                        try {
                          await onDelete(departmentId, role.id)
                        } finally {
                          setBusyId(null)
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 rounded-md bg-emphasis px-3 text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90"
                    disabled={busyId === role.id || !draft.name.trim() || !isDirty}
                    onClick={async () => {
                      setBusyId(role.id)
                      try {
                        await onUpdate(departmentId, role.id, {
                          name: draft.name.trim(),
                          isDefault: draft.isDefault,
                          zohoReadScope: draft.zohoReadScope,
                        })
                      } finally {
                        setBusyId(null)
                      }
                    }}
                  >
                    Save
                  </Button>
                </div>
              </div>

              <label className={`mt-2.5 flex items-center justify-between rounded-md border p-2.5 ${draft.zohoReadScope === "personalized" ? "border-accent/30 bg-accent/5" : "border-border/60 bg-mat"}`}>
                <div>
                  <p className={`text-[12px] font-medium ${draft.zohoReadScope === "personalized" ? "text-accent" : ""}`}>Zoho data personalization</p>
                  <p className="text-[10px] text-muted-foreground">
                    {draft.zohoReadScope === "personalized"
                      ? "ON — members with this role only see Zoho records matching their email"
                      : "OFF — members see all Zoho records"}
                  </p>
                </div>
                <Switch
                  checked={draft.zohoReadScope === "personalized"}
                  onCheckedChange={(checked) =>
                    setDrafts((prev) => ({ ...prev, [role.id]: { ...draft, zohoReadScope: checked ? "personalized" : "show_all" } }))
                  }
                />
              </label>
            </div>
          )
        })}
      </div>
    </div>
  )
}
