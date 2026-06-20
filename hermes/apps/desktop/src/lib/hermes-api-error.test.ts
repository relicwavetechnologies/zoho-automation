import { describe, expect, it } from 'vitest'

import { parseHermesApiIpcError } from './hermes-api-error'

describe('parseHermesApiIpcError', () => {
  it('strips the Electron IPC wrapper and parses JSON detail', () => {
    const message = parseHermesApiIpcError(
      new Error(
        "Error invoking remote method 'hermes:api': Error: 503: {\"detail\":\"Divo Follow Ups store is unavailable\"}"
      )
    )

    expect(message).toBe('HTTP 503: Divo Follow Ups store is unavailable')
  })

  it('returns the inner error when no HTTP status is present', () => {
    expect(parseHermesApiIpcError(new Error("Error invoking remote method 'hermes:api': Error: connect ECONNREFUSED"))).toBe(
      'connect ECONNREFUSED'
    )
  })
})
