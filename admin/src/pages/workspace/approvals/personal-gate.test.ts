import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  NO_PERSONAL_GATE,
  personalGateFrom,
  personalGateSize,
  personallyGated,
  personallyPicked,
  togglePersonalAction,
} from './personal-gate'

/*
 * The browser's copy of the rule. The backend covers the shared logic; these
 * cover the two things only this copy can get wrong — the distinction between
 * "gated" and "picked", which exists so a tick box reflects the list it writes
 * to, and the toggle the pills call on every click.
 */

describe('personallyPicked vs personallyGated', () => {
  it('separates "covered by everything" from "named in the list"', () => {
    /* If the pills read `personallyGated`, switching "everything" off would
       appear to un-tick rows nobody ever touched, and switching it back on
       would appear to tick rows that are not in the list. */
    const gate = personalGateFrom(true, [['googleGmail', 'send']])
    assert.equal(personallyGated(gate, 'googleSheets', 'update'), true)
    assert.equal(personallyPicked(gate, 'googleSheets', 'update'), false)
    assert.equal(personallyPicked(gate, 'googleGmail', 'send'), true)
  })
})

describe('togglePersonalAction', () => {
  it('adds what is missing and removes what is there', () => {
    const added = togglePersonalAction(NO_PERSONAL_GATE, 'googleGmail', 'send')
    assert.equal(personallyPicked(added, 'googleGmail', 'send'), true)
    assert.deepEqual(togglePersonalAction(added, 'googleGmail', 'send'), NO_PERSONAL_GATE)
  })

  it('leaves the other actions on the same tool alone', () => {
    const gate = personalGateFrom(false, [['googleGmail', 'send'], ['googleGmail', 'create']])
    assert.deepEqual(
      togglePersonalAction(gate, 'googleGmail', 'send').actions,
      [{ toolId: 'googleGmail', actions: ['create'] }],
    )
  })

  it('does not disturb "everything"', () => {
    assert.equal(togglePersonalAction(personalGateFrom(true, []), 'googleGmail', 'send').all, true)
  })

  it('never writes a read, so a row that cannot be gated cannot be ticked', () => {
    const gate = togglePersonalAction(NO_PERSONAL_GATE, 'googleSheets', 'read')
    assert.deepEqual(gate, NO_PERSONAL_GATE)
    assert.equal(personalGateSize(gate), 0)
  })
})
