/**
 * Does this mail rule send a mailbox's contents outside the company?
 *
 * A rule forwards the entire original message, `{"from":"@company.com"}` is a
 * legal match, and `destination.email` accepts any address at all — so one
 * successful tool call can establish a silent, persistent, full-mailbox
 * forward. Rule *matching* involves no model, but rule *creation* does, which
 * puts this within reach of an instruction injected into an earlier tool
 * result. Nothing in the pipeline re-examined the destination afterwards.
 *
 * Externality is judged against the requester's own address. When that is
 * unknown the answer is "external": the failure direction that asks a human
 * one extra question is the only acceptable one here.
 */
export function mailRuleLeavesOrganisation(input: {
  readonly destinationEmail: string;
  readonly requesterEmail?: string | undefined;
}): boolean {
  const destination = emailDomain(input.destinationEmail);
  if (!destination) return true;
  const own = emailDomain(input.requesterEmail ?? '');
  if (!own) return true;
  return destination !== own;
}

/**
 * The external destination a create/update request would establish, or null
 * when the request does not establish one.
 *
 * Reads the arguments defensively rather than through the tool's Zod schema:
 * the approval gate sees whatever the model sent, before the tool has had a
 * chance to reject it, so nothing here may assume a shape.
 */
export function externalMailDestination(input: {
  readonly args: unknown;
  readonly requesterEmail?: string | undefined;
}): string | null {
  const args = input.args;
  if (typeof args !== 'object' || args === null) return null;
  const record = args as Record<string, unknown>;
  const operation = record['operation'];
  if (operation !== 'create' && operation !== 'update') return null;

  const destination = record['destination'];
  if (typeof destination !== 'object' || destination === null) return null;
  const destinationRecord = destination as Record<string, unknown>;
  if (destinationRecord['type'] !== 'email') return null;

  const email = destinationRecord['email'];
  if (typeof email !== 'string' || !email) return null;

  return mailRuleLeavesOrganisation({
    destinationEmail: email,
    requesterEmail: input.requesterEmail,
  })
    ? email
    : null;
}

function emailDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLowerCase();
}
