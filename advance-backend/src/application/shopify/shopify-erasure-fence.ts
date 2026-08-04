export const SHOPIFY_ERASURE_LOCK_NAMESPACE = 'shopify_erasure_source_v1';
const MAX_LEARNING_SOURCE_ID_CHARS = 500;

export function shopifyErasureSourceId(channel: string, runId: string): string {
  return `${channel}:${runId}`.slice(0, MAX_LEARNING_SOURCE_ID_CHARS);
}

export function shopifyErasureLockKey(companyId: string, sourceId: string): string {
  return `${companyId}:${sourceId}`;
}
