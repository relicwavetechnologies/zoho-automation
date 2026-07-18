import { describe, expect, it } from 'vitest'

import {
  DIVO_TEACH_PROFILE_METADATA_KEY,
  readDivoTeachProfile,
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
})
