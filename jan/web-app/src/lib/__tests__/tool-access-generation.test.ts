import { describe, expect, it } from 'vitest'

import { CommittedToolAccessGeneration } from '../tool-access-generation'

describe('CommittedToolAccessGeneration', () => {
  it('does not invalidate the committed dialog for a discarded render candidate', () => {
    const generation = new CommittedToolAccessGeneration<object>()
    const committedItem = {}
    const discardedItem = {}

    generation.commit(committedItem, 'global')
    const committedGeneration = generation.current

    const discardedCandidate = generation.candidate(discardedItem, 'department:operations')

    // This models a React render candidate that is discarded before its layout effect.
    expect(generation.current).toBe(committedGeneration)

    expect(discardedCandidate).toBeDefined()
    generation.candidate(discardedItem, 'department:operations').commit()
    expect(generation.current).toBeGreaterThan(committedGeneration)
  })

  it('can fence a pending request at a committed dialog event boundary', () => {
    const generation = new CommittedToolAccessGeneration<object>()
    const item = {}
    generation.commit(item, 'global')
    const requestGeneration = generation.current

    generation.invalidateForEvent()

    expect(generation.current).not.toBe(requestGeneration)
  })
})
