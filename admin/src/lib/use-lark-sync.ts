import { useCallback, useState } from "react"
import { toast } from "sonner"
import { useAdminAuth } from "@/auth/AdminAuthProvider"

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000"

export type SyncState = {
  active: boolean
  phase: string
  message: string
  synced: number
  total: number
  pct: number
}

export function useLarkSync(onComplete?: () => void) {
  const { token } = useAdminAuth()
  const [state, setState] = useState<SyncState>({
    active: false,
    phase: "",
    message: "",
    synced: 0,
    total: 0,
    pct: 0,
  })

  const sync = useCallback(async () => {
    if (!token || state.active) return
    setState({ active: true, phase: "starting", message: "Starting sync...", synced: 0, total: 0, pct: 0 })

    try {
      const res = await fetch(`${API_BASE_URL}/api/admin/company/sync-directory`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      })

      if (!res.ok || !res.body) {
        const text = await res.text()
        let msg = `Sync failed (${res.status})`
        try { msg = (JSON.parse(text) as { message?: string }).message ?? msg } catch {}
        toast.error(msg)
        setState(s => ({ ...s, active: false, phase: "error", message: msg }))
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        let eventType = ""
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim()
          } else if (line.startsWith("data: ") && eventType) {
            try {
              const data = JSON.parse(line.slice(6)) as Record<string, unknown>
              if (eventType === "status") {
                setState(s => ({
                  ...s,
                  phase: String(data.phase ?? s.phase),
                  message: String(data.message ?? s.message),
                  total: typeof data.total === "number" ? data.total : s.total,
                }))
              } else if (eventType === "progress") {
                setState(s => ({
                  ...s,
                  phase: "syncing",
                  synced: typeof data.synced === "number" ? data.synced : s.synced,
                  total: typeof data.total === "number" ? data.total : s.total,
                  pct: typeof data.pct === "number" ? data.pct : s.pct,
                  message: `Synced ${data.synced}/${data.total} users`,
                }))
              } else if (eventType === "done") {
                const synced = typeof data.synced === "number" ? data.synced : 0
                toast.success(`Synced ${synced} users from Lark`)
                setState({ active: false, phase: "done", message: String(data.message ?? "Done"), synced, total: synced, pct: 100 })
                onComplete?.()
              } else if (eventType === "error") {
                toast.error(String(data.message ?? "Sync failed"))
                setState(s => ({ ...s, active: false, phase: "error", message: String(data.message ?? "Failed") }))
              }
            } catch {}
            eventType = ""
          }
        }
      }

      setState(s => s.active ? { ...s, active: false } : s)
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Network error"
      toast.error(msg)
      setState(s => ({ ...s, active: false, phase: "error", message: msg }))
    }
  }, [token, state.active, onComplete])

  return { ...state, sync }
}
