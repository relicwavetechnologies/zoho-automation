import { useCallback, useEffect, useMemo, useState } from 'react'

import { followUpRecordToTask } from '@/lib/follow-ups/map-task'
import type { FollowUpTask } from '@/lib/follow-ups/types'
import { syncCompanyAuthGate } from '@/lib/company-auth'
import { parseHermesApiIpcError } from '@/lib/hermes-api-error'
import { isGatewayReauthRequired } from '@/lib/gateway-ws-url'

import type { TodayPanelResponse } from './api-types'
import {
  getTodayPanelClient,
  resolveTodayPanelClientMode,
  type TodayPanelClient
} from './client'
import { mapTodayPanelToBrief } from './map-brief'
import { createEmptyTodayPanelResponse, createMockTodayPanelResponse } from './mock-data'

export function useTodayPanelData(client: TodayPanelClient = getTodayPanelClient()) {
  const clientMode = resolveTodayPanelClientMode()
  const useMockData = clientMode === 'mock'
  const [data, setData] = useState<TodayPanelResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await client.getTodayPanel()
      setData(response)
    } catch (err) {
      if (isGatewayReauthRequired(err)) {
        void syncCompanyAuthGate(window.hermesDesktop, err)
      }
      const message = parseHermesApiIpcError(err)
      setError(message)
      setData(useMockData ? createMockTodayPanelResponse() : null)
    } finally {
      setLoading(false)
    }
  }, [client, useMockData])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const brief = useMemo(() => {
    if (data) {
      return mapTodayPanelToBrief(data)
    }
    return mapTodayPanelToBrief(
      useMockData ? createMockTodayPanelResponse() : createEmptyTodayPanelResponse()
    )
  }, [data, useMockData])
  const tasks: FollowUpTask[] = useMemo(
    () => (data?.tasks ?? []).map(followUpRecordToTask),
    [data?.tasks]
  )

  return {
    data,
    brief,
    tasks,
    loading,
    error,
    refresh
  }
}
