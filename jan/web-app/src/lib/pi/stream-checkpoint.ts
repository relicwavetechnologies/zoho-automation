export const PI_STREAM_CHECKPOINT_METADATA_KEY = 'piStreamCheckpoint'

export type PiStreamCheckpoint = {
  state: 'in_progress'
}

type Interruption = {
  state: 'interrupted'
  reason: 'app_closed'
}

export function withPiStreamCheckpoint(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...metadata,
    [PI_STREAM_CHECKPOINT_METADATA_KEY]: {
      state: 'in_progress',
    } satisfies PiStreamCheckpoint,
  }
}

export function isPiStreamCheckpoint(
  metadata: Record<string, unknown> | undefined
): boolean {
  const checkpoint = metadata?.[PI_STREAM_CHECKPOINT_METADATA_KEY]
  return (
    typeof checkpoint === 'object' &&
    checkpoint !== null &&
    (checkpoint as Record<string, unknown>).state === 'in_progress'
  )
}

/**
 * A stream checkpoint only becomes historical after the desktop starts again.
 * Pi's process is scoped to the desktop process, so a checkpoint left behind
 * at that point cannot still be producing output. Preserve it as evidence,
 * but never imply that unfinished work was completed or resumed.
 */
export function recoverPiStreamCheckpoint(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...metadata }
  delete next[PI_STREAM_CHECKPOINT_METADATA_KEY]
  return {
    ...next,
    interrupted: true,
    interruption: {
      state: 'interrupted',
      reason: 'app_closed',
    } satisfies Interruption,
  }
}
