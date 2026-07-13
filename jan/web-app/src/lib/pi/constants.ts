/** Message metadata flag — Pi agent runs use append-only trace rendering. */
export const PI_TRACE_TIMELINE_METADATA_KEY = 'piTraceTimeline' as const

export const PI_PROVIDER_ID = 'pi' as const
export const PI_MODEL_ID = 'pi-agent' as const

/** The only generation runtime supported by Divo Desktop. */
export const DIVO_THREAD_MODEL = {
  provider: PI_PROVIDER_ID,
  id: PI_MODEL_ID,
} as const
