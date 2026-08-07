/**
 * What the sidebar needs to know about a person's first few minutes.
 *
 * Two things live here — the Recent list and the Getting started checklist —
 * because they read the same two endpoints and the sidebar renders on every
 * page. Both are on react-query with a generous `staleTime` for exactly that
 * reason: `useConnections` and `useMyRuns` are plain `useEffect` fetches, so
 * lifting either of them into the shell would re-run seven requests on every
 * single navigation.
 *
 * The duplicate read that remains: Home mounts `useConnections` as well, which
 * fetches the same six status routes uncached. That is deliberate for now —
 * that hook also *performs* connects and disconnects, and rewriting it onto
 * react-query belongs to the Connections pass, not to Home. Collapse the two
 * when that page is re-skinned.
 *
 * Every step below is read from something real. There is no step here for
 * "approve your first action" or "set what Divo can do", because no route
 * reports either, and a checklist that ticks itself off on a guess is worse
 * than a shorter checklist.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'
import { getAdminQueryScope } from '@/lib/query-client'
import type { Provider } from '../fixtures'
import type { MyRun } from './use-my-activity'
import { CONNECTABLE, SEGMENT } from './use-connections'

export type OnboardingStep = {
  id: 'connect' | 'ask' | 'mail' | 'lark'
  label: string
  done: boolean
  /** Where the step is completed. Absent when nothing on the web can do it. */
  to?: string
}

/** Recent runs for the sidebar. Short list — the panel on Home shows more. */
export function useRecentRuns(limit = 5) {
  const { token } = useAdminAuth()
  const scope = getAdminQueryScope(token)
  const query = useQuery({
    queryKey: ['workspace', scope, 'recent-runs', limit],
    enabled: Boolean(token),
    staleTime: 60_000,
    queryFn: async () => {
      const data = await api.get<{ runs: MyRun[] }>(
        `/api/desktop/me/runs?limit=${limit}`,
        token ?? undefined,
        { quiet: true },
      )
      return data.runs ?? []
    },
  })
  return { runs: query.data ?? [], loading: query.isPending }
}

/**
 * Whether anything at all is connected.
 *
 * Only the boolean is returned. The checklist asks one question and six
 * provider payloads is not the answer to it — Connected apps is where the
 * detail belongs, and it reads the same routes for itself.
 */
function useHasConnection() {
  const { token } = useAdminAuth()
  const scope = getAdminQueryScope(token)
  const query = useQuery({
    queryKey: ['workspace', scope, 'any-connection'],
    enabled: Boolean(token),
    staleTime: 60_000,
    queryFn: async () => {
      const results = await Promise.all(
        CONNECTABLE.map(async (provider: Provider) => {
          try {
            const data = await api.get<{ connected: boolean }>(
              `/api/desktop/auth/${SEGMENT[provider]}/status`,
              token ?? undefined,
              { quiet: true },
            )
            return data.connected
          } catch {
            // A provider this deployment has no app for answers 503. That is
            // not "disconnected" and it is certainly not a reason to fail the
            // other five, so it simply does not count as a yes.
            return false
          }
        }),
      )
      return results.some(Boolean)
    },
  })
  // `undefined` while loading reads as "not done yet" rather than "done", so a
  // slow request never shows somebody a tick they have not earned.
  return { connected: query.data ?? false, loading: query.isPending }
}

/**
 * Whether any mailbox is being watched.
 *
 * Its own query rather than `useMailAutomations`, which is a plain `useEffect`
 * pair — the sidebar renders on every page, so mounting that here would fire
 * two mail requests on every navigation in the app. Only the count is wanted.
 */
function useHasMailbox() {
  const { token } = useAdminAuth()
  const scope = getAdminQueryScope(token)
  const query = useQuery({
    queryKey: ['workspace', scope, 'any-mailbox'],
    enabled: Boolean(token),
    staleTime: 60_000,
    queryFn: async () => {
      const data = await api.get<{ mailboxes: unknown[] }>(
        '/api/mail-automations/health', token ?? undefined, { quiet: true },
      )
      return (data.mailboxes ?? []).length > 0
    },
  })
  return { watched: query.data ?? false, loading: query.isPending }
}

export function useOnboarding() {
  const { session } = useAdminAuth()
  const { connected, loading: connectionsLoading } = useHasConnection()
  const { runs, loading: runsLoading } = useRecentRuns()
  const { watched, loading: mailLoading } = useHasMailbox()

  const steps = useMemo<OnboardingStep[]>(() => [
    { id: 'connect', label: 'Connect an app', done: connected, to: '/settings/connections' },
    { id: 'ask', label: 'Ask Divo something', done: runs.length > 0 },
    /* Above Lark because it is the one step here a member can finish alone and
       see working the same day — nothing on it waits for anybody else. */
    { id: 'mail', label: 'Set up your mail', done: watched, to: '/me/mail' },
    /* Password sign-in mints no Lark identity, so this person's Lark chat
       cannot resolve their account until they link it once. */
    { id: 'lark', label: 'Link Lark', done: Boolean(session?.larkLinked), to: '/settings/connections' },
  ], [connected, runs.length, watched, session?.larkLinked])

  const doneCount = steps.filter((s) => s.done).length
  return {
    steps,
    doneCount,
    percent: Math.round((doneCount / steps.length) * 100),
    complete: doneCount === steps.length,
    loading: connectionsLoading || runsLoading || mailLoading,
  }
}
