/**
 * The connection jobs only a company admin can do.
 *
 * Kept apart from `use-connections`, which is the member's own surface, because
 * these three routes all gate on `COMPANY_ADMIN_ROLES` and answer 403 to
 * everybody else. Putting them in the You scope would have meant a member
 * seeing a control that always refuses.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'

const BASE = '/api/desktop/auth'

/**
 * The Google account the company's data exports are written through.
 *
 * Divo pages the source data outside model context, transforms it in a sandbox
 * with no network, and writes a Sheet or a CSV. That write has to happen as
 * *somebody*, and this is who — with the person who asked fixed as the only
 * reader.
 */
export type DataExportProfile = {
  version: 1
  enabled: true
  acknowledged: true
  googleConnectionId: string
  accountEmail: string
  readerDomain: string
  access: 'company_reader'
}

type ProfileResponse = {
  profile: DataExportProfile | null
  configuredAt: string | null
  configuredBy: string | null
  version: number
}

export function useDataExportProfile() {
  const { token } = useAdminAuth()
  const [profile, setProfile] = useState<DataExportProfile | null>(null)
  const [configuredAt, setConfiguredAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refused, setRefused] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)

  const load = useCallback(async () => {
    if (!token) { setLoading(false); return }
    const gen = ++generation.current
    setLoading(true)
    try {
      const data = await api.get<ProfileResponse>(`${BASE}/google/data-export-profile`, token, { quiet: true })
      if (generation.current !== gen) return
      setProfile(data.profile)
      setConfiguredAt(data.configuredAt)
      setRefused(false)
      setFailed(false)
    } catch (e) {
      if (generation.current !== gen) return
      // 403 is the answer for anybody who is not a company admin, and it is not
      // a failure — the panel hides rather than showing a broken read.
      setRefused(e instanceof ApiError && (e.status === 403 || e.status === 401))
      setFailed(!(e instanceof ApiError) || (e.status !== 403 && e.status !== 401))
      setProfile(null)
    } finally {
      if (generation.current === gen) setLoading(false)
    }
  }, [token])

  useEffect(() => { void load() }, [load])

  /**
   * Names the account exports are written through.
   *
   * `acknowledged` is not a checkbox the person ticks — the route demands it as
   * a literal, and choosing the account in a panel that says what the account
   * will be used for *is* the acknowledgement.
   */
  const configure = useCallback(async (googleConnectionId: string) => {
    if (!token) return
    setSaving(true)
    try {
      const data = await api.put<ProfileResponse>(
        `${BASE}/google/data-export-profile`,
        { googleConnectionId, acknowledged: true },
        token,
      )
      setProfile(data.profile)
      setConfiguredAt(data.configuredAt)
    } finally {
      setSaving(false)
    }
  }, [token])

  return { profile, configuredAt, loading, refused, failed, saving, configure, refresh: load }
}

/** How much of an Airtable workspace a personal access token is allowed to do. */
export type AirtableAccessMode = 'read_only' | 'read_write'

/**
 * Connecting a provider with a key instead of a sign-in.
 *
 * Airtable and AITable both accept a token posted straight to the backend, and
 * both restrict it to company admins — the resulting connection is held by the
 * company rather than by one person, so it is not a decision a member gets to
 * make for everybody.
 *
 * The value goes to the backend and is never held here beyond the request. It
 * is not put in a query string, not logged, and not read back: neither route
 * returns the token it was given.
 */
export function useTokenConnect() {
  const { token } = useAdminAuth()
  const [saving, setSaving] = useState(false)

  const connectAirtable = useCallback(async (
    personalAccessToken: string,
    options?: { label?: string; accessMode?: AirtableAccessMode },
  ) => {
    if (!token) return
    setSaving(true)
    try {
      await api.post(`${BASE}/airtable/pat`, {
        personalAccessToken,
        ...(options?.label ? { label: options.label } : {}),
        ...(options?.accessMode ? { accessMode: options.accessMode } : {}),
      }, token, { quiet: true })
    } finally {
      setSaving(false)
    }
  }, [token])

  const connectAitable = useCallback(async (apiKey: string, options?: { label?: string }) => {
    if (!token) return
    setSaving(true)
    try {
      await api.post(`${BASE}/aitable/connect`, {
        apiKey,
        ...(options?.label ? { label: options.label } : {}),
      }, token, { quiet: true })
    } finally {
      setSaving(false)
    }
  }, [token])

  return { saving, connectAirtable, connectAitable }
}
