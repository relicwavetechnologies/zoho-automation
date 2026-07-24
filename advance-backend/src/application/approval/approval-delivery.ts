import type { ChannelError } from '../../shared/errors';

const DEFINITE_NON_DELIVERY_REASONS = new Set([
  'malformed',
  'upstream_4xx',
  'not_supported',
  'rate_limited',
]);

/**
 * Only a provider rejection proves an approval card was not created.
 * Timeouts, disconnects, and 5xx responses are ambiguous because Lark may
 * have accepted the card before the caller lost its response.
 */
export function isDefiniteApprovalNonDelivery(error: ChannelError): boolean {
  return DEFINITE_NON_DELIVERY_REASONS.has(error.payload?.reason);
}

export function approvalDeliveryUnknownCheckpoint(message: string) {
  return {
    status: 'approval_delivery_unknown',
    message,
    nextAction: 'contact_administrator',
    retry: 'do_not_retry',
  } as const;
}

export function approvalDeliveryFailedCheckpoint(message: string) {
  return {
    status: 'approval_delivery_failed',
    message,
    nextAction: 'retry_exact',
    retry: 'retry_exact',
  } as const;
}
