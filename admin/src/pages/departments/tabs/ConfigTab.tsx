import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { DepartmentDetail } from "@/lib/api"

type Props = {
  detail: DepartmentDetail
  onSave: (data: {
    systemPrompt: string
    skillsMarkdown: string
    zohoRateLimit?: unknown
    managerApproval?: unknown
    isActive?: boolean
  }) => Promise<void>
}

function stringifyJson(value: unknown) {
  if (value === undefined || value === null) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ""
  }
}

function parseJsonField(value: string) {
  if (!value.trim()) return null
  return JSON.parse(value)
}

export function ConfigTab({ detail, onSave }: Props) {
  const [systemPrompt, setSystemPrompt] = useState(detail.config.systemPrompt)
  const [skillsMarkdown, setSkillsMarkdown] = useState(detail.config.skillsMarkdown)
  const [zohoRateLimit, setZohoRateLimit] = useState(stringifyJson(detail.config.zohoRateLimit))
  const [managerApproval, setManagerApproval] = useState(stringifyJson(detail.config.managerApproval))
  const [isActive, setIsActive] = useState(detail.config.isActive)
  const [parseError, setParseError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setSystemPrompt(detail.config.systemPrompt)
    setSkillsMarkdown(detail.config.skillsMarkdown)
    setZohoRateLimit(stringifyJson(detail.config.zohoRateLimit))
    setManagerApproval(stringifyJson(detail.config.managerApproval))
    setIsActive(detail.config.isActive)
    setParseError(null)
  }, [detail])

  const dirty = useMemo(
    () =>
      systemPrompt !== detail.config.systemPrompt ||
      skillsMarkdown !== detail.config.skillsMarkdown ||
      zohoRateLimit !== stringifyJson(detail.config.zohoRateLimit) ||
      managerApproval !== stringifyJson(detail.config.managerApproval) ||
      isActive !== detail.config.isActive,
    [
      detail.config.isActive,
      detail.config.managerApproval,
      detail.config.skillsMarkdown,
      detail.config.systemPrompt,
      detail.config.zohoRateLimit,
      isActive,
      managerApproval,
      skillsMarkdown,
      systemPrompt,
      zohoRateLimit,
    ],
  )

  const handleSave = async () => {
    setBusy(true)
    setParseError(null)

    try {
      const zohoRateLimitValue = parseJsonField(zohoRateLimit)
      const managerApprovalValue = parseJsonField(managerApproval)
      await onSave({
        systemPrompt,
        skillsMarkdown,
        zohoRateLimit: zohoRateLimitValue,
        managerApproval: managerApprovalValue,
        isActive,
      })
    } catch (error) {
      setParseError(error instanceof Error ? error.message : "Invalid JSON in config fields")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg bg-card p-3 shadow-soft">
        <div>
          <p className="text-[13px] font-semibold">Department agent active</p>
          <p className="text-[11px] text-muted-foreground">Disable the department config without archiving the department.</p>
        </div>
        <Switch checked={isActive} onCheckedChange={setIsActive} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">System prompt</Label>
          <Textarea
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            className="min-h-[220px] bg-card font-mono text-[12px] leading-5"
            placeholder="Core operating instructions for the department agent."
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Skills markdown</Label>
          <Textarea
            value={skillsMarkdown}
            onChange={(event) => setSkillsMarkdown(event.target.value)}
            className="min-h-[220px] bg-card font-mono text-[12px] leading-5"
            placeholder="Shared department skills, playbooks, and operating notes."
          />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Zoho rate limit JSON</Label>
          <Textarea
            value={zohoRateLimit}
            onChange={(event) => setZohoRateLimit(event.target.value)}
            className="min-h-[160px] bg-card font-mono text-[12px] leading-5"
            placeholder='{"perMinute": 30}'
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Manager approval JSON</Label>
          <Textarea
            value={managerApproval}
            onChange={(event) => setManagerApproval(event.target.value)}
            className="min-h-[160px] bg-card font-mono text-[12px] leading-5"
            placeholder='{"required": true}'
          />
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg bg-card p-3 shadow-soft">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Department skills</p>
          <p className="mt-1 text-[12px] text-foreground/85">{detail.departmentSkills.length} scoped skills attached to this department</p>
        </div>
        <div className="rounded-lg bg-card p-3 shadow-soft">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Global skills</p>
          <p className="mt-1 text-[12px] text-foreground/85">{detail.globalSkills.length} company-wide skills available alongside this config</p>
        </div>
      </div>

      {parseError ? <p className="text-[11px] text-destructive">{parseError}</p> : null}

      <div className="flex justify-end">
        <Button
          type="button"
          className="h-8 rounded-md bg-emphasis px-3 text-[12px] font-semibold text-emphasis-foreground hover:bg-emphasis/90"
          disabled={!dirty || busy}
          onClick={handleSave}
        >
          Save config
        </Button>
      </div>
    </div>
  )
}
