import type { TodayPanelResponse } from './api-types'
import { createHttpTodayPanelClient } from './http-client'
import { createMockTodayPanelResponse } from './mock-data'

export interface TodayPanelClient {
  getTodayPanel(): Promise<TodayPanelResponse>
}

export type TodayPanelClientMode = 'mock' | 'http'

function hasHermesDesktopApiBridge(): boolean {
  const bridge = (window as Window & { hermesDesktop?: Window['hermesDesktop'] }).hermesDesktop
  return typeof bridge?.api === 'function'
}

let singletonClient: TodayPanelClient | null = null

export function resolveTodayPanelClientMode(): TodayPanelClientMode {
  const raw = import.meta.env.VITE_DESKTOP_TODAY_PANEL_CLIENT
  if (raw === 'mock') {
    return 'mock'
  }
  if (raw === 'http') {
    return 'http'
  }
  // Electron ships the dashboard API bridge — prefer live Lark data unless mock is explicit.
  if (typeof window !== 'undefined' && hasHermesDesktopApiBridge()) {
    return 'http'
  }
  return 'mock'
}

export function createMockTodayPanelClient(): TodayPanelClient {
  return {
    async getTodayPanel() {
      return createMockTodayPanelResponse()
    }
  }
}

export function createTodayPanelClient(mode: TodayPanelClientMode = resolveTodayPanelClientMode()): TodayPanelClient {
  return mode === 'http' ? createHttpTodayPanelClient() : createMockTodayPanelClient()
}

export function getTodayPanelClient(): TodayPanelClient {
  if (!singletonClient) {
    singletonClient = createTodayPanelClient()
  }
  return singletonClient
}

export function setTodayPanelClientForTests(client: TodayPanelClient | null): void {
  singletonClient = client
}
