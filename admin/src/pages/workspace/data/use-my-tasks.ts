/**
 * The work still waiting on the signed-in person.
 *
 * `reachable` is the whole reason this returns more than an array. Somebody who
 * is up to date and somebody whose Lark account was never linked both have no
 * tasks, and a panel should say nothing in the first case and offer to connect
 * in the second — which it cannot do if both arrive as `[]`.
 *
 * There is no mutation here and there is not meant to be. Ticking a task off
 * from a dashboard would mean this surface holds a credential that can change
 * somebody's Lark; the route behind it asks for read access only.
 */
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'

export type OpenTask = {
  readonly taskId: string
  readonly title: string
  readonly dueDate?: string
  readonly overdue: boolean
}

type TasksResponse = {
  status: 'ok' | 'no_lark_identity' | 'not_connected'
  tasks: OpenTask[]
}

export function useMyTasks(limit = 6) {
  const { token } = useAdminAuth()
  const [tasks, setTasks] = useState<OpenTask[]>([])
  /** False when Divo cannot see this person's tasks at all, for any reason. */
  const [reachable, setReachable] = useState(true)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    let live = true
    void (async () => {
      try {
        /* `raw` because this route answers bare, the way `/api/artifacts` does
           — member routes under `http/member/` do not use the `{ success, data }`
           envelope. Without it the reader hands back `body.data`, which is
           `undefined` here, and the panel reads a shape bug as "no Lark". */
        const data = await api.get<TasksResponse>(
          `/api/me/tasks?limit=${limit}`, token, { quiet: true, raw: true },
        )
        if (!live) return
        setTasks(data.tasks ?? [])
        setReachable(data.status === 'ok')
      } catch {
        // Lark being unreachable is not something to put a red banner in front
        // of somebody for. The panel simply does not appear.
        if (live) { setTasks([]); setReachable(false) }
      } finally {
        if (live) setLoading(false)
      }
    })()
    return () => { live = false }
  }, [token, limit])

  return { tasks, reachable, loading }
}

/** "Due today", "3 days late", or nothing at all when Lark has no date. */
export function dueLabel(task: OpenTask, now = new Date()): string | null {
  if (!task.dueDate) return null
  const today = now.toISOString().slice(0, 10)
  if (task.dueDate === today) return 'Due today'
  const days = Math.round(
    (new Date(`${task.dueDate}T00:00:00`).getTime()
      - new Date(`${today}T00:00:00`).getTime()) / 86_400_000,
  )
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} late`
  if (days === 1) return 'Due tomorrow'
  return `Due in ${days} days`
}
