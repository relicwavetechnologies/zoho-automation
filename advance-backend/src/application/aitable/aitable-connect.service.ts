import { AitableClient, AitableError, type AitableSpace } from '../../infrastructure/aitable/aitable.client';

/**
 * Adding an AITable connection.
 *
 * AITable has no OAuth, so nothing about a pasted key is trustworthy until it
 * has been used. There is no redirect handshake to stand in for proof, which
 * makes the live check the connect step rather than a nicety attached to it:
 * a key is proven first and stored second, never the other way round.
 */

export type AitableKeyCheck =
  | { readonly ok: true; readonly spaces: AitableSpace[] }
  | { readonly ok: false; readonly reason: AitableKeyRejection; readonly message: string };

/**
 * Why a key was not accepted. Deliberately more than one value: collapsing
 * these into "invalid key" would tell someone to rotate a perfectly good key
 * during an AITable outage.
 */
export type AitableKeyRejection =
  /** AITable rejected it. Rotating the key is the fix. */
  | 'rejected'
  /** We could not reach AITable. The key may well be fine; retry is the fix. */
  | 'unreachable'
  /** Nothing was pasted. */
  | 'empty';

export interface AitableKeyVerifier {
  verify(apiKey: string): Promise<AitableKeyCheck>;
}

export function createAitableKeyVerifier(deps: {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}): AitableKeyVerifier {
  return {
    async verify(apiKey: string): Promise<AitableKeyCheck> {
      const trimmed = apiKey?.trim() ?? '';
      if (!trimmed) {
        return { ok: false, reason: 'empty', message: 'Enter an AITable API key.' };
      }

      const client = new AitableClient(trimmed, deps.baseUrl, {
        ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
      });

      try {
        // An empty workspace list is a real answer, not a failure: the key
        // works, its owner just has not been added to a workspace yet. The
        // caller decides whether to warn about that; it is not a rejection.
        return { ok: true, spaces: await client.listSpaces() };
      } catch (error) {
        if (error instanceof AitableError) {
          if (error.code === 'invalid_key') {
            return {
              ok: false,
              reason: 'rejected',
              message: 'AITable rejected this API key. Check it was copied whole from User Center → Developer Configuration.',
            };
          }
          if (error.code === 'unreachable' || error.code === 'rate_limited') {
            return {
              ok: false,
              reason: 'unreachable',
              message: 'Could not reach AITable to check this key. The key was not saved — try again in a moment.',
            };
          }
        }
        // Anything else is still a failure to prove the key, and proof is the
        // whole point of this step, so it is never stored on the benefit of
        // the doubt.
        return {
          ok: false,
          reason: 'unreachable',
          message: 'Could not verify this API key with AITable. The key was not saved.',
        };
      }
    },
  };
}

/** True when a verified key reaches no workspace — worth saying out loud. */
export function reachesNoWorkspace(check: AitableKeyCheck): boolean {
  return check.ok && check.spaces.length === 0;
}
