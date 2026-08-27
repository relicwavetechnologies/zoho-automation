/**
 * What the gateway's session status means to Divo.
 *
 * This exists because the obvious version is wrong in a way that is very easy to
 * miss: `"disconnected".includes("connect")` is `true`, and so is
 * `/connect/.test("disconnected")`. A liveness check written that way reads a
 * dead handset as healthy — which is precisely the failure the check was added
 * to catch, silently inverted.
 *
 * The gateway's documented statuses are matched exactly, from a table. Anything
 * outside that table falls back to ordered patterns. Pairing's normalized view
 * remains conservative and calls unknown vocabulary disconnected; the liveness
 * worker uses the tri-state classifier and makes no stored-state change until a
 * usable or unusable status is confirmed.
 */

export type WhatsappSessionStatus = 'linked' | 'pending' | 'disconnected';
export type GatewaySessionStatus = WhatsappSessionStatus | 'unknown';

/**
 * The gateway's own vocabulary, from its `openapi.json`.
 *
 * An exact table rather than pattern matching, because the pattern version got
 * two of these wrong: `authenticating` is mid-scan but does not contain
 * `authenticated`, and `created` matches nothing at all — both fell through to
 * `disconnected`, so a handset part-way through being linked reported itself as
 * dead. The patterns below still run, but only for words this table does not
 * already answer.
 */
const KNOWN: Readonly<Record<string, WhatsappSessionStatus>> = {
  created: 'pending',
  initializing: 'pending',
  qr_ready: 'pending',
  authenticating: 'pending',
  ready: 'linked',
  disconnected: 'disconnected',
  // The gateway's word for "a person has to do something" — most often the
  // session was logged out from the handset. Not usable, and not mid-link.
  action_required: 'disconnected',
  failed: 'disconnected',
};

/** Terminal or broken states. Checked before anything else — see the note above. */
const DISCONNECTED = /disconnect|logged ?out|logout|unpaired|closed|failed|expired|banned/i;

/** Mid-link states: the handset is being paired but is not usable yet. */
const PENDING = /\bqr\b|pair|scan|starting|initiali[sz]ing|connecting|authenticating/i;

/** Usable states. Only reached once disconnection has been ruled out. */
const LINKED = /^connected$|\bready\b|authenticated|\bopen\b|\bactive\b|\bonline\b/i;

export function normalizeGatewaySessionStatus(
  remote: string | undefined | null,
): WhatsappSessionStatus {
  const classified = classifyGatewaySessionStatus(remote);
  return classified === 'unknown' ? 'disconnected' : classified;
}

/**
 * Classify a liveness response without treating new provider vocabulary as a
 * confirmed outage. Pairing keeps its conservative fallback through
 * `normalizeGatewaySessionStatus`; the worker uses this tri-state result before
 * changing stored state.
 */
export function classifyGatewaySessionStatus(
  remote: string | undefined | null,
): GatewaySessionStatus {
  // Underscores and hyphens are word characters to a regex, so `\bqr\b` does not
  // match inside `awaiting_qr`. Normalising separators to spaces first is what
  // lets the word-boundary anchors below mean what they look like they mean.
  const raw = (remote ?? '').trim().toLowerCase();
  if (!raw) return 'unknown';

  // The documented vocabulary answers first and exactly. The patterns below are
  // the fallback for a gateway version that adds a word we have not seen.
  const known = KNOWN[raw];
  if (known) return known;

  const value = raw.replace(/[_-]+/g, ' ');

  // Order is the whole point. "disconnected" and "connecting" both contain
  // "connect", so neither may be matched by a bare substring test.
  if (DISCONNECTED.test(value)) return 'disconnected';
  if (PENDING.test(value)) return 'pending';
  if (LINKED.test(value)) return 'linked';

  return 'unknown';
}

/** Convenience for the liveness sweep, which only cares about one question. */
export function isGatewaySessionUsable(remote: string | undefined | null): boolean {
  return normalizeGatewaySessionStatus(remote) === 'linked';
}
