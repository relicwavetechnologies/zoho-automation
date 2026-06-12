import { describe, expect, it } from 'vitest'

import { appViewForPath, isOverlayView, routeSessionId, SETTINGS_ROUTE } from './routes'

describe('desktop routes', () => {
  it('treats settings as an overlay route, not a chat session id', () => {
    expect(routeSessionId(SETTINGS_ROUTE)).toBeNull()
    expect(appViewForPath(SETTINGS_ROUTE)).toBe('settings')
    expect(isOverlayView('settings')).toBe(true)
  })
})
