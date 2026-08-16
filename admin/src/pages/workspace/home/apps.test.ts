import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { appChips, withReference } from './apps'

describe('appChips', () => {
  it('opens one connection into the apps behind it', () => {
    assert.deepEqual(
      appChips(['google_workspace']).map((c) => c.label),
      ['Gmail', 'Drive', 'Sheets', 'Calendar'],
    )
  })

  it('offers nothing for a workspace with nothing connected', () => {
    assert.deepEqual(appChips([]), [])
  })

  it('follows the order it was given', () => {
    assert.deepEqual(
      appChips(['lark', 'zoho']).map((c) => c.label),
      ['Lark', 'Books', 'CRM'],
    )
  })
})

describe('withReference', () => {
  const gmail = { key: 'gmail', label: 'Gmail' } as const

  it('starts a sentence with the app', () => {
    assert.equal(withReference('', gmail), '@Gmail ')
  })

  it('appends without throwing away what was typed', () => {
    assert.equal(withReference('summarise ', gmail), 'summarise @Gmail ')
  })

  it('refuses to name the same app twice', () => {
    assert.equal(withReference('@Gmail and then', gmail), '@Gmail and then')
  })
})
