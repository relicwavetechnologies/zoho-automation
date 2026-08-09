import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { previewScopeSentence } from './preview-scope'

const EN = 'en-GB'

describe('previewScopeSentence', () => {
  it('says the archive is empty rather than reporting a zero', () => {
    // The branch that matters. "Read 0" alongside "none matched" reads as a
    // rule that failed, when nothing was ever tested.
    assert.equal(
      previewScopeSentence({ consideredCount: 0 }, EN),
      'Divo has recorded nothing for this inbox yet.',
    )
  })

  it('says "all" only when the replay ran out of mail, not out of ceiling', () => {
    assert.equal(
      previewScopeSentence({ consideredCount: 11, coversSince: '2026-08-02T09:00:00.000Z' }, EN),
      'Read all 11 Divo has stored, back to 2 Aug.',
    )
  })

  it('never says "all" at the ceiling, and warns that older mail was missed', () => {
    const sentence = previewScopeSentence(
      { consideredCount: 50, coversSince: '2026-07-14T09:00:00.000Z', truncated: true },
      EN,
    )
    assert.equal(
      sentence,
      'Read the 50 most recent, back to 14 Jul. There may be older mail this did not reach.',
    )
    assert.ok(!sentence.includes('all'), 'a truncated replay must not claim to have read everything')
  })

  it('drops the date rather than inventing one when the server sent none', () => {
    assert.equal(
      previewScopeSentence({ consideredCount: 4 }, EN),
      'Read all 4 Divo has stored.',
    )
  })

  it('an empty archive outranks a truncation flag, which cannot both be true', () => {
    assert.equal(
      previewScopeSentence({ consideredCount: 0, truncated: true }, EN),
      'Divo has recorded nothing for this inbox yet.',
    )
  })
})
