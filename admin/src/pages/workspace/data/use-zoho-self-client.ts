/**
 * Connecting Zoho with Self Client credentials.
 *
 * The other way in is OAuth, where Zoho asks the person for consent. This is
 * for the case where that is not on offer: an admin registers a Self Client in
 * Zoho's console, generates a short-lived grant, and hands it over.
 *
 * What is pasted is a *grant*, never a refresh token. The backend exchanges it
 * with Zoho, receives the refresh token, encrypts it, and renews from there —
 * so the credential that lasts never travels through a browser, and the one
 * that does expires in minutes.
 *
 * Ported from the desktop app, which had this and the web did not. Same route,
 * same payload, so the two surfaces cannot drift into disagreeing about what a
 * Zoho connection is.
 */

import { useCallback, useState } from 'react'
import { api } from '@/lib/api'
import { useAdminAuth } from '@/auth/AdminAuthProvider'

/**
 * Zoho runs separate data centres and a grant is only valid in the one that
 * issued it. Getting this wrong fails at the exchange with an error that does
 * not say so, which is why it is a named list and not free text.
 */
export const ZOHO_DATA_CENTRES = [
  { label: 'India', value: 'https://accounts.zoho.in' },
  { label: 'United States', value: 'https://accounts.zoho.com' },
  { label: 'Europe', value: 'https://accounts.zoho.eu' },
  { label: 'Australia', value: 'https://accounts.zoho.com.au' },
  { label: 'Japan', value: 'https://accounts.zoho.jp' },
  { label: 'Canada', value: 'https://accounts.zohocloud.ca' },
  { label: 'Saudi Arabia', value: 'https://accounts.zoho.sa' },
  { label: 'United Kingdom', value: 'https://accounts.zoho.uk' },
] as const

export type ZohoSelfClientAccess = 'read_only' | 'read_write'

export type ZohoSelfClientInput = {
  label?: string
  clientId: string
  clientSecret: string
  grantToken: string
  accountsBaseUrl: string
  access: ZohoSelfClientAccess
}

export type ZohoSelfClientResult = {
  connectionId: string
  label: string
  access: ZohoSelfClientAccess
  scopes: string[]
}

export function useZohoSelfClientConnect() {
  const { token } = useAdminAuth()
  const [saving, setSaving] = useState(false)

  const connect = useCallback(async (input: ZohoSelfClientInput) => {
    if (!token) throw new Error('Sign in again before connecting Zoho.')
    setSaving(true)
    try {
      // `quiet` because the caller shows the failure next to the field that
      // caused it — a grant that expired while being pasted is a correctable
      // mistake, not an application error worth a global toast.
      return await api.post<ZohoSelfClientResult>(
        '/api/desktop/auth/zoho/self-client',
        input,
        token,
        { quiet: true },
      )
    } finally {
      setSaving(false)
    }
  }, [token])

  return { saving, connect }
}
