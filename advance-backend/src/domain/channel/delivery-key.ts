/**
 * Identity for one piece of a run's outbound answer.
 *
 * Wave 2 guarantees a message is executed at least once. That is the right
 * guarantee for work and the wrong one for speech: retrying a run that already
 * answered would say the same thing twice. This key is what lets a retry
 * recognise its own earlier delivery.
 *
 * It has to be derived, not generated. A random key minted per attempt would be
 * new on every retry and would identify nothing — the whole point is that the
 * second attempt at the same segment computes the same string as the first.
 *
 * `runKey` is the run's correlation ID, which is stable across retries of one
 * accepted message. `purpose` and `segmentIndex` separate the parts of an
 * answer, so a long reply split across continuation cards can have its third
 * card retried without resending the first two.
 */

export type DeliveryPurpose = 'final' | 'continuation' | 'status';

export interface DeliveryIdentity {
  readonly runKey: string;
  readonly purpose: DeliveryPurpose;
  readonly segmentIndex?: number;
}

/**
 * Lark's `uuid` accepts up to 50 characters, so the key is kept short and
 * URL-safe rather than expressive. Colons separate fields because none of the
 * components can contain one: a correlation ID is a UUID and the purpose is
 * drawn from a closed set.
 */
export const buildDeliveryKey = (identity: DeliveryIdentity): string => {
  const index = identity.segmentIndex ?? 0;
  return `${identity.runKey}:${identity.purpose}:${index}`;
};

/** Lark rejects a `uuid` longer than 50 characters, so long run keys are hashed. */
export const toProviderIdempotencyKey = (
  deliveryKey: string,
  hash: (input: string) => string,
): string => (deliveryKey.length <= 50 ? deliveryKey : hash(deliveryKey).slice(0, 50));
