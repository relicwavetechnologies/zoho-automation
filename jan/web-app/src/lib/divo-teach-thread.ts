import type { PiTeachProfile } from '@/lib/pi-stream'

export const DIVO_TEACH_PROFILE_METADATA_KEY = 'divoTeachProfile' as const

export function readDivoTeachProfile(
  metadata: Thread['metadata'] | undefined
): PiTeachProfile | undefined {
  const value = metadata?.[DIVO_TEACH_PROFILE_METADATA_KEY]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const profile = value as Record<string, unknown>
  if (
    profile.kind !== 'teach' ||
    typeof profile.teachSessionId !== 'string' ||
    profile.teachSessionId.length === 0 ||
    typeof profile.departmentId !== 'string' ||
    profile.departmentId.length === 0
  ) {
    return undefined
  }

  return {
    kind: 'teach',
    teachSessionId: profile.teachSessionId,
    departmentId: profile.departmentId,
  }
}
