import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (data: { name: string; description?: string }) => Promise<{ id: string } | null>
}

export function CreateDepartmentDialog({ open, onOpenChange, onCreate }: Props) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setName("")
    setDescription("")
  }

  const handleCreate = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const created = await onCreate({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      })
      if (created) {
        reset()
        onOpenChange(false)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border/40 bg-mat sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-semibold">Create new department</DialogTitle>
          <DialogDescription className="text-[12px]">
            Add a department, seed its default manager/member roles, and wire its agent config.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Name</Label>
            <Input
              placeholder="e.g. Revenue Operations"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-9 bg-card text-[13px]"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Description</Label>
            <Textarea
              placeholder="Describe the function this department owns."
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="min-h-[120px] bg-card text-[13px] leading-5"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8 bg-emphasis text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90"
            disabled={busy || !name.trim()}
            onClick={handleCreate}
          >
            Create department
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
