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
export function externalMailDestinations(input: {
  readonly args: unknown;
  readonly requesterEmail?: string | undefined;
}): string[] {
  const args = input.args;
  if (typeof args !== 'object' || args === null) return [];
  const record = args as Record<string, unknown>;
  const operation = record['operation'];
  if (operation !== 'create' && operation !== 'update') return [];

  const destination = record['destination'];
  if (typeof destination !== 'object' || destination === null) return [];

  const seen = new Set<string>();
  for (const email of emailsIn(destination as Record<string, unknown>)) {
    if (!mailRuleLeavesOrganisation({
      destinationEmail: email,
      requesterEmail: input.requesterEmail,
    })) continue;
    // De-duplicated by address rather than by branch: two branches pointing at
    // one person is one address to approve, and naming it twice on a card reads
    // as two different things being asked for.
    seen.add(email);
  }
  return [...seen];
}

/**
 * Every address a destination would send to, however many places it has.
 *
 * Reads by shape rather than by declared type, because a routing table is the
 * one destination whose recipients are nested — and a reader that only
 * understood `{type:'email'}` returned nothing at all for it, which on this
 * path means "no approval needed". Missing one branch here is not a missing
 * warning; it is a standing export of company mail that nobody was asked about.
 *
 * The fallback counts. It is a recipient like any other and it is the branch
 * nobody thinks about — "everything else goes to X" is exactly where an
 * unnoticed address ends up.
 */
function emailsIn(destination: Record<string, unknown>): string[] {
  if (destination['type'] === 'email') {
    const email = destination['email'];
    return typeof email === 'string' && email ? [email] : [];
  }
  if (destination['type'] !== 'routed') return [];
  const found: string[] = [];
  const routes = destination['routes'];
  if (Array.isArray(routes)) {
    for (const route of routes) {
      if (!route || typeof route !== 'object') continue;
      const leaf = (route as Record<string, unknown>)['destination'];
      if (leaf && typeof leaf === 'object') {
        found.push(...emailsIn(leaf as Record<string, unknown>));
      }
    }
  }
  const otherwise = destination['otherwise'];
  if (otherwise && typeof otherwise === 'object') {
    found.push(...emailsIn(otherwise as Record<string, unknown>));
  }
  return found;
}

/**
 * Several addresses, said the way a sentence would say them.
 *
 * Lives here because the approval card, the refusal message and the browser's
 * own banner all have to name the same set, and three separate joins is three
 * chances for one of them to name fewer.
 */
export function namedAddresses(addresses: readonly string[]): string {
  if (addresses.length <= 1) return addresses[0] ?? '';
  return `${addresses.slice(0, -1).join(', ')} and ${addresses[addresses.length - 1]}`;
}

function emailDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLowerCase();
}
