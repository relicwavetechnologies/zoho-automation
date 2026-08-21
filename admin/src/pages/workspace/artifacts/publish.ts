export type ArtifactPublishState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'publishing' }
  | { readonly kind: 'published'; readonly url: string }
  | { readonly kind: 'failed'; readonly message: string }

export type ArtifactPublishEvent =
  | { readonly type: 'start' }
  | { readonly type: 'success'; readonly url: string }
  | { readonly type: 'failure'; readonly message: string }

export const initialArtifactPublishState: ArtifactPublishState = { kind: 'idle' }

export function reduceArtifactPublishState(
  _state: ArtifactPublishState,
  event: ArtifactPublishEvent,
): ArtifactPublishState {
  switch (event.type) {
    case 'start':
      return { kind: 'publishing' }
    case 'success':
      return { kind: 'published', url: event.url }
    case 'failure':
      return { kind: 'failed', message: event.message }
  }
}
