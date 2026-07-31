import { describe, expect, it } from 'vitest'

import {
  DIVO_TEACH_PENDING_MESSAGE_METADATA_KEY,
  DIVO_TEACH_PROFILE_METADATA_KEY,
  readDivoTeachPendingMessage,
  readDivoTeachProfile,
  teachThreadDisplayTitle,
} from '@/lib/divo-teach-thread'

describe('Teach thread metadata', () => {
  it('reads a valid profile used by the standard chat transport', () => {
    expect(readDivoTeachProfile({
      [DIVO_TEACH_PROFILE_METADATA_KEY]: {
        kind: 'teach',
        teachSessionId: 'teach-session-1',
        departmentId: 'department-1',
      },
    })).toEqual({
      kind: 'teach',
      teachSessionId: 'teach-session-1',
      departmentId: 'department-1',
    })
  })

  it('rejects incomplete or malformed metadata', () => {
    expect(readDivoTeachProfile(undefined)).toBeUndefined()
    expect(readDivoTeachProfile({
      [DIVO_TEACH_PROFILE_METADATA_KEY]: {
        kind: 'teach',
        teachSessionId: '',
        departmentId: 'department-1',
      },
    })).toBeUndefined()
    expect(readDivoTeachProfile({
      [DIVO_TEACH_PROFILE_METADATA_KEY]: 'teach',
    })).toBeUndefined()
  })

  it('reads only complete durable Teach handoffs', () => {
    expect(readDivoTeachPendingMessage({
      [DIVO_TEACH_PENDING_MESSAGE_METADATA_KEY]: {
        teachSessionId: 'teach-session-1',
        text: 'Analyze this workflow.',
        createdAt: '2026-07-19T00:00:00.000Z',
      },
    })).toEqual({
      teachSessionId: 'teach-session-1',
      text: 'Analyze this workflow.',
      createdAt: '2026-07-19T00:00:00.000Z',
    })
    expect(readDivoTeachPendingMessage({
      [DIVO_TEACH_PENDING_MESSAGE_METADATA_KEY]: { teachSessionId: 'missing-fields' },
    })).toBeUndefined()
  })
})

describe('teachThreadDisplayTitle', () => {
  it('drops the prefix the badge already conveys', () => {
    expect(teachThreadDisplayTitle('Teach: How we analyse spend')).toBe(
      'How we analyse spend'
    )
    expect(teachThreadDisplayTitle('teach - onboarding')).toBe('onboarding')
  })

  it('leaves ordinary titles alone', () => {
    expect(teachThreadDisplayTitle('Teaching plan for Q3')).toBe(
      'Teaching plan for Q3'
    )
    expect(teachThreadDisplayTitle('hi there')).toBe('hi there')
  })

  it('keeps the original when the prefix is all there is', () => {
    expect(teachThreadDisplayTitle('Teach:')).toBe('Teach:')
  })
})
