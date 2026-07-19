import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'

import { getDivoSessionStatus, type DivoSessionStatus } from '@/lib/divo-auth'
import { firstNameFrom, greetingForHour } from '@/lib/greeting'

/**
 * Home headline: a time-of-day greeting addressed to the signed-in member,
 * with the department they are acting in. Falls back to a neutral headline
 * before the session resolves, so nothing pops in late.
 */
export function HomeGreeting() {
  const [status, setStatus] = useState<DivoSessionStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    const refresh = () => {
      void getDivoSessionStatus()
        .then((next) => {
          if (!cancelled) setStatus(next.configured ? next : null)
        })
        .catch(() => {
          if (!cancelled) setStatus(null)
        })
    }

    refresh()
    if (IS_TAURI) {
      void listen('divo-session-changed', refresh).then((dispose) => {
        if (cancelled) dispose()
        else unlisten = dispose
      })
    }

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const firstName = firstNameFrom(status ?? {})
  const greeting = greetingForHour(new Date().getHours())
  const department =
    status?.departments.find((dept) => dept.id === status.departmentId)?.name ??
    null

  return (
    <div className="text-center">
      <h1 className="font-studio text-4xl font-medium tracking-tight text-foreground sm:text-5xl">
        {firstName ? `${greeting}, ${firstName}` : greeting}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        Ready when you are.
        {department ? (
          <>
            {' in '}
            <span className="font-medium text-foreground">{department}</span>
          </>
        ) : null}
      </p>
    </div>
  )
}
