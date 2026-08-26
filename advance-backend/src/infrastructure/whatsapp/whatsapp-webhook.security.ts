import crypto from 'node:crypto';

/**
 * Constant-time check of the `sha256=<hex>` header OpenWA sends when a webhook
 * secret is configured.
 *
 * Ported from the follow-up agent, with one adjustment: Divo captures raw
 * request bodies as a UTF-8 string in the JSON parser's `verify` hook (see
 * `server.ts`), so this takes what the rest of the app already has rather than
 * asking for a second parser on one route. `createHmac().update(str, 'utf8')`
 * digests the same bytes the client signed, which is how the Shopify webhook
 * verifies too.
 *
 * The length guard is not redundant: `timingSafeEqual` throws on mismatched
 * lengths rather than returning false, so comparing sizes first is what keeps a
 * malformed header a rejection instead of a crash.
 */
export function verifyWhatsappSignature(
  rawBody: string | Buffer,
  header: string | undefined,
  secret: string | undefined,
): boolean {
  // No secret configured means no signature to check. A deployment choice, not
  // a default to lean on — production sets one, and `assertProductionEnv`
  // should be where that is enforced.
  if (!secret) return true;
  if (!header) return false;

  const mac = crypto.createHmac('sha256', secret);
  if (typeof rawBody === 'string') mac.update(rawBody, 'utf8');
  else mac.update(rawBody);

  const expected = `sha256=${mac.digest('hex')}`;
  const received = Buffer.from(header);
  const computed = Buffer.from(expected);
  return received.length === computed.length && crypto.timingSafeEqual(received, computed);
}
