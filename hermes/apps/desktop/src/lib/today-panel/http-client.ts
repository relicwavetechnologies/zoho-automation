import type { TodayPanelClient } from './client'
import { TODAY_PANEL_API_PATHS, TodayPanelClientError, type TodayPanelResponse } from './api-types'
import { GatewayReauthRequiredError, isGatewayReauthRequired } from '@/lib/gateway-ws-url'

function ensureDesktopApi() {
  if (typeof window === 'undefined' || !window.hermesDesktop?.api) {
    throw new TodayPanelClientError('Desktop API bridge unavailable', 'api_unavailable')
  }
  return window.hermesDesktop.api
}

function assertTodayPanelResponse(body: unknown): TodayPanelResponse {
  if (!body || typeof body !== 'object') {
    throw new TodayPanelClientError('Today panel API returned an invalid payload', 'invalid_response')
  }
  const record = body as Partial<TodayPanelResponse>
  if (typeof record.dateLabel !== 'string' || !Array.isArray(record.tasks)) {
    throw new TodayPanelClientError('Today panel API returned an invalid payload', 'invalid_response')
  }
  return body as TodayPanelResponse
}

export function createHttpTodayPanelClient(): TodayPanelClient {
  const api = ensureDesktopApi()

  return {
    async getTodayPanel(): Promise<TodayPanelResponse> {
      const body = await api<TodayPanelResponse>({ path: TODAY_PANEL_API_PATHS.today })
      if (isGatewayReauthRequired(body)) {
        throw new GatewayReauthRequiredError(
          typeof (body as { detail?: unknown }).detail === 'string'
            ? String((body as { detail?: unknown }).detail)
            : 'Company sign-in required'
        )
      }
      return assertTodayPanelResponse(body)
    }
  }
}
