import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bandFor, forecastGate, irreversible, type GatePolicy } from './forecast'
import { NO_PERSONAL_GATE, personalGateFrom } from './personal-gate'

const NO_POLICY: GatePolicy = { enabled: false, requiredActions: [] }

const base = {
  policy: NO_POLICY,
  channel: 'web' as const,
  askerIsApprover: true,
  selfBypassDisabled: false,
  approverExists: true,
  personal: NO_PERSONAL_GATE,
}

describe('irreversible', () => {
  it('counts only what cannot be taken back', () => {
    assert.equal(irreversible('delete'), true)
    assert.equal(irreversible('send'), true)
    assert.equal(irreversible('create'), false)
    assert.equal(irreversible('update'), false)
    assert.equal(irreversible('read'), false)
  })
})

describe('bandFor', () => {
  it('surfaces an ungated delete instead of folding it away', () => {
    /*
     * The miss this exists for. Somebody picked create and update on their
     * calendar and read the page as covering their calendar. Delete was not
     * picked, so it sat in the hundred-row fold, alphabetised among the
     * harmless, and Divo deleted an event without asking.
     */
    const outcome = forecastGate({ ...base, toolId: 'larkCalendar', action: 'delete' })
    assert.deepEqual(outcome, { kind: 'immediate', because: 'no_policy' })
    assert.equal(bandFor(outcome, 'delete'), 'exposed')
  })

  it('leaves a reversible ungated action in the fold', () => {
    const outcome = forecastGate({ ...base, toolId: 'larkCalendar', action: 'update' })
    assert.equal(bandFor(outcome, 'update'), 'runs')
  })

  it('never calls a read exposed, however it is spelled', () => {
    // Reads cannot be gated at all, so they are not a gap anybody can close.
    const outcome = forecastGate({ ...base, toolId: 'larkCalendar', action: 'read' })
    assert.equal(bandFor(outcome, 'read'), 'runs')
  })

  it('stops counting a delete as exposed once it is picked', () => {
    const personal = personalGateFrom(false, [['larkCalendar', 'delete']])
    const outcome = forecastGate({ ...base, toolId: 'larkCalendar', action: 'delete', personal })
    assert.equal(bandFor(outcome, 'delete'), 'stops')
  })

  it('keeps a team-gated delete in its own band rather than calling it exposed', () => {
    // It is gated and runs for the approver, which "watched" already explains.
    const policy: GatePolicy = {
      enabled: true,
      requiredActions: [{ toolId: 'larkCalendar', actions: ['delete'] }],
    }
    const outcome = forecastGate({ ...base, toolId: 'larkCalendar', action: 'delete', policy })
    assert.equal(bandFor(outcome, 'delete'), 'watched')
  })
})
