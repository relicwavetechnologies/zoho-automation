import { describe, expect, it } from 'vitest'
import {
  isPiStreamCheckpoint,
  recoverPiStreamCheckpoint,
  withPiStreamCheckpoint,
} from '../stream-checkpoint'

describe('Pi stream checkpoints', () => {
  it('marks a partial stream without claiming it completed', () => {
    const checkpoint = withPiStreamCheckpoint({ piTraceTimeline: true })

    expect(isPiStreamCheckpoint(checkpoint)).toBe(true)
    expect(checkpoint).not.toHaveProperty('interrupted')
  })

  it('recovers a checkpoint as an interrupted historical response', () => {
    const recovered = recoverPiStreamCheckpoint(
      withPiStreamCheckpoint({ piTraceTimeline: true, parentId: 'user-1' })
    )

    expect(isPiStreamCheckpoint(recovered)).toBe(false)
    expect(recovered).toMatchObject({
      piTraceTimeline: true,
      parentId: 'user-1',
      interrupted: true,
      interruption: { state: 'interrupted', reason: 'app_closed' },
    })
  })
})
