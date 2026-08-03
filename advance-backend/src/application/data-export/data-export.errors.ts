import { UnrecoverableError } from 'bullmq';

/**
 * An export that cannot succeed on any retry.
 *
 * A disconnected destination or a recipe the provider rejects is not a wobble:
 * retrying it burns the attempt budget and, worse, tells the member "please try
 * again shortly" about something that will fail identically until an
 * administrator or the request itself changes.
 *
 * Extends BullMQ's own type so the queue stops retrying, and carries the
 * sentence the member should actually read — the generic failure card is
 * accurate but useless when we know exactly what is wrong.
 */
export class PermanentDataExportError extends UnrecoverableError {
  constructor(
    /** Shown to the member. Say what is wrong and who can fix it. */
    readonly memberMessage: string,
    /** Operator detail, when it differs from what the member should see. */
    logMessage?: string,
  ) {
    super(logMessage ?? memberMessage);
  }
}

/** The member-facing sentence for a failure, when the failure named one. */
export function dataExportFailureReason(error: unknown): string | undefined {
  return error instanceof PermanentDataExportError ? error.memberMessage : undefined;
}
