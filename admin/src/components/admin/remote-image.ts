export type RemoteImagePhase = 'loading' | 'shown' | 'failed'
export type RemoteImageState = { src: string; phase: RemoteImagePhase } | null

export function remoteImagePhase(src: string | null, state: RemoteImageState): RemoteImagePhase | 'disabled' {
  if (!src) return 'disabled'
  return state?.src === src ? state.phase : 'loading'
}

/** The fallback and a successful remote image must never be visible together. */
export function remoteImageLayers(src: string | null, phase: RemoteImagePhase | 'disabled') {
  return {
    showFallback: phase !== 'shown',
    showRemote: Boolean(src) && phase !== 'failed',
  }
}
