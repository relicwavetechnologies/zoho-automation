import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  EMPTY_DRAFT, advance, answered, companyFromEmail, hostOf, isPersonalHost,
  looksLikeEmail, problem, retreat, stepIndex, type Draft,
} from './signup'

const draft = (over: Partial<Draft>): Draft => ({ ...EMPTY_DRAFT, ...over })

describe('companyFromEmail', () => {
  it('names the company after the domain', () => {
    assert.equal(companyFromEmail('abhishek@emiactech.com'), 'Emiactech')
  })

  it('ignores a mail subdomain rather than naming the company after it', () => {
    assert.equal(companyFromEmail('me@mail.emiactech.com'), 'Emiactech')
  })

  it('sees through a two-part public suffix', () => {
    assert.equal(companyFromEmail('me@acme.co.uk'), 'Acme')
  })

  it('opens a hyphenated domain into words', () => {
    assert.equal(companyFromEmail('me@acme-tech.com'), 'Acme Tech')
  })

  it('has nothing to offer before there is an address', () => {
    assert.equal(companyFromEmail(''), '')
    assert.equal(companyFromEmail('abhishek'), '')
  })
})

describe('hostOf', () => {
  it('takes everything after the last @', () => {
    assert.equal(hostOf('a@b@emiactech.com'), 'emiactech.com')
  })

  it('lowercases, because domains are not case sensitive and people are', () => {
    assert.equal(hostOf('Me@EmiacTech.COM'), 'emiactech.com')
  })
})

describe('isPersonalHost', () => {
  it('turns away an address nobody at the company controls', () => {
    assert.equal(isPersonalHost('someone@gmail.com'), true)
    assert.equal(isPersonalHost('SOMEONE@Gmail.com'), true)
  })

  it('lets a work address through', () => {
    assert.equal(isPersonalHost('abhishek@emiactech.com'), false)
  })
})

describe('looksLikeEmail', () => {
  it('catches only the typo somebody can see', () => {
    assert.equal(looksLikeEmail('abhishek@emiactech.com'), true)
    assert.equal(looksLikeEmail('abhishek@emiactech'), false)
    assert.equal(looksLikeEmail('abhishek'), false)
    assert.equal(looksLikeEmail('a b@emiactech.com'), false)
  })
})

describe('problem', () => {
  it('says nothing to somebody who has not typed yet', () => {
    assert.equal(problem('email', EMPTY_DRAFT), null)
  })

  it('names the domain it is refusing, rather than quoting a rule', () => {
    const message = problem('email', draft({ email: 'me@gmail.com' }))
    assert.ok(message?.includes('gmail.com'))
  })

  it('holds its tongue until a password is long enough to judge', () => {
    assert.equal(problem('password', draft({ password: '' })), null)
    assert.ok(problem('password', draft({ password: 'short' })))
    assert.equal(problem('password', draft({ password: 'longenough' })), null)
  })
})

describe('advance', () => {
  it('stays put while the card is unanswered', () => {
    assert.equal(advance('email', EMPTY_DRAFT), 'email')
    assert.equal(advance('role', draft({ role: null })), 'role')
  })

  it('refuses to move on from a personal address', () => {
    assert.equal(advance('email', draft({ email: 'me@gmail.com' })), 'email')
  })

  it('walks a founder to the end', () => {
    const founder = draft({
      email: 'abhishek@emiactech.com', role: 'founder',
      company: 'Emiactech', name: 'Abhishek', password: 'longenough',
    })
    assert.equal(advance('email', founder), 'role')
    assert.equal(advance('role', founder), 'company')
    assert.equal(advance('company', founder), 'password')
    assert.equal(advance('password', founder), 'submit')
  })

  it('stops a member at the invite card instead of creating a second company', () => {
    const member = draft({ email: 'priya@emiactech.com', role: 'member' })
    assert.equal(advance('role', member), 'invite')
    /* And there is nowhere forward from it. */
    assert.equal(advance('invite', member), 'invite')
  })

  it('wants a name as well as a company', () => {
    assert.equal(answered('company', draft({ company: 'Emiactech' })), false)
    assert.equal(answered('company', draft({ company: 'Emiactech', name: 'Abhishek' })), true)
  })

  it('does not count whitespace as an answer', () => {
    assert.equal(answered('company', draft({ company: '  ', name: '  ' })), false)
  })
})

describe('retreat', () => {
  it('has nowhere to go from the first card', () => {
    assert.equal(retreat('email'), null)
  })

  it('brings both branches back to the fork they came from', () => {
    assert.equal(retreat('company'), 'role')
    assert.equal(retreat('invite'), 'role')
  })

  it('undoes every forward move a founder makes', () => {
    assert.equal(retreat('role'), 'email')
    assert.equal(retreat('password'), 'company')
  })
})

describe('stepIndex', () => {
  it('counts the four questions in order', () => {
    assert.deepEqual(
      (['email', 'role', 'company', 'password'] as const).map(stepIndex),
      [0, 1, 2, 3],
    )
  })

  it('leaves the turned-away card on the role dot rather than inventing progress', () => {
    assert.equal(stepIndex('invite'), stepIndex('role'))
  })
})
