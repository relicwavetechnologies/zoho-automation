/**
 * Export offers are identified at two different scopes, and using the wrong one
 * breaks a different thing each way.
 *
 * `dataExportOfferKey` hashes `{companyId, userId, requestId}`. Which
 * `requestId` a caller supplies therefore decides what "the same export" means,
 * and the two ways an export can be created want opposite answers.
 */

/**
 * Run-scoped identity, for offers assembled from many tool calls.
 *
 * `appendAuthorizedPart` merges the parts of one answer into a single offer, and
 * this hash is the only thing that groups them: a run answering "compare these
 * 22 domains" makes 22 provider calls and must show one 22-row export.
 * `runContext.requestId` is the per-tool-call action id the runtime sends, so
 * deriving from it first gives every call its own offer — `offers.create`
 * answers `created` every time, no part ever appends, and the member is left
 * with a button covering whichever call happened to run last.
 *
 * `runtimeRunId` comes off the signed runtime lease and is stable for the whole
 * run, which is exactly the scope a merged offer describes.
 */
export function dataExportRunRequestId(
  runContext: {
    readonly runtimeRunId?: string;
    readonly requestId?: string;
  },
  correlationId: string,
): string {
  return runContext.runtimeRunId ?? runContext.requestId ?? correlationId;
}

/**
 * Call-scoped identity, for `submitAuthorized` — one call, one artifact, queued
 * immediately with no merge step.
 *
 * These must NOT share the run's identity. `submitAuthorized` has no merge
 * logic: a second call in the same run would hit the first call's offer key,
 * `create` would answer `existing`, and `assertSameRequest` would reject the
 * whole request with "Only one data export can be queued per user request" —
 * so "export all my invoices and all my bills" would queue the invoices and
 * then fail outright on the bills. `dataExportJobId` hashes `requestId` too, so
 * the same collision waits one layer down in the queue.
 *
 * The per-tool-call action id is the right scope here, because each call really
 * is its own export.
 */
export function dataExportCallRequestId(
  runContext: { readonly requestId?: string },
  correlationId: string,
): string {
  return runContext.requestId ?? correlationId;
}
