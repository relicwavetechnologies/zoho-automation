/**
 * The skills this member can actually run.
 *
 * The screen this feeds rendered a fixture until now — invented names, invented
 * scopes ("Private", "Finance"), invented run counts — because no endpoint
 * could answer the question. `GET /api/desktop/skills` answers it with the same
 * two services the Pi runtime asks before a run, so what the page shows and
 * what a run would find are the same list.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'

export type MySkill = {
  id: string
  slug: string
  name: string
  description: string
  toolIds: string[]
  tags: string[]
  /** The team it reached them through, or null when it is company-wide. */
  departmentName: string | null
  /**
   * Tools the skill needs that this person may not use.
   *
   * Empty means runnable. Enforcement is per tool — somebody missing one
   * cannot run the skill however it was shared — so this is the difference
   * between a skill that is theirs and one that is merely visible.
   */
  missingTools: string[]
  revision: number
}

export function useMySkills() {
  const { token } = useAdminAuth()
  const [skills, setSkills] = useState<MySkill[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    try {
      const data = await api.get<{ skills: MySkill[] }>('/api/desktop/skills', token, { quiet: true })
      setSkills(data.skills ?? [])
      setError(null)
    } catch {
      // A skills list that fails silently looks like a person with no skills,
      // which is a claim about their access rather than about the request.
      setError('Could not load your skills.')
      setSkills([])
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { void load() }, [load])

  return { skills, loading, error, refresh: load }
}
