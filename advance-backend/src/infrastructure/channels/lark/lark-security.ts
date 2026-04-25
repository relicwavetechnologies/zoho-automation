/**
 * Lark webhook security — two independent concerns:
 *
 *  1.  AES-256-CBC message decryption (LARK_ENCRYPT_KEY)
 *      When Lark app has "message encryption" enabled the entire event payload
 *      is replaced by { encrypt: "<base64>" }. Spec:
 *        key  = SHA-256( LARK_ENCRYPT_KEY ) → 32 bytes
 *        data = base64_decode( encrypt )
 *        iv   = data[0..15]
 *        ct   = data[16..]
 *        pt   = AES-256-CBC decrypt( ct, key, iv ) → strip PKCS#7 pad
 *
 *  2.  Request authenticity verification (two modes):
 *      a. Signing-secret (preferred): HMAC-SHA256 over `${timestamp}:${rawBody}`,
 *         compared with x-lark-signature header, replay window enforced.
 *      b. Verification-token (legacy): body.token or body.header.token compared
 *         to LARK_VERIFICATION_TOKEN.
 *
 *  Neither mode is enabled if neither env var is set — callers must handle that.
 */

import { createHmac, createHash, createDecipheriv, timingSafeEqual } from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export type LarkVerifyReason =
  | 'missing_verification_config'
  | 'signature_required'
  | 'invalid_timestamp'
  | 'replay_window_exceeded'
  | 'invalid_signature'
  | 'missing_verification_token'
  | 'invalid_verification_token';

export type LarkVerifyResult =
  | { ok: true }
  | { ok: false; reason: LarkVerifyReason };

export interface LarkVerifyInput {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  parsedBody?: unknown;
}

export interface LarkVerifyConfig {
  signingSecret?: string;
  verificationToken?: string;
  maxSkewSeconds?: number;
  now?: () => number;   // injectable for tests (returns ms epoch)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_SKEW_SECONDS = 300;

const firstHeader = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

const readBodyToken = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b['token'] === 'string' && b['token'].trim()) return b['token'].trim();
  const h = b['header'];
  if (h && typeof h === 'object') {
    const hb = h as Record<string, unknown>;
    if (typeof hb['token'] === 'string' && hb['token'].trim()) return hb['token'].trim();
  }
  return undefined;
};

// ─── AES-256-CBC decryption ───────────────────────────────────────────────────

/**
 * Decrypt a Lark-encrypted event body.
 *
 * @param encryptedPayload  Value of body.encrypt (base64-encoded ciphertext+IV)
 * @param encryptKey        Value of LARK_ENCRYPT_KEY
 * @returns                 The decrypted JSON string of the real event payload
 * @throws                  Error if decryption fails (corrupt payload / wrong key)
 */
export function decryptLarkEvent(encryptedPayload: string, encryptKey: string): string {
  // Step 1: derive 32-byte key from LARK_ENCRYPT_KEY via SHA-256
  const key = createHash('sha256').update(encryptKey, 'utf8').digest(); // Buffer, 32 bytes

  // Step 2: base64-decode the encrypted payload
  const data = Buffer.from(encryptedPayload, 'base64');

  if (data.length < 16) {
    throw new Error('lark.decrypt: encrypted payload too short to contain IV');
  }

  // Step 3: split IV (first 16 bytes) and ciphertext (remainder)
  const iv = data.subarray(0, 16);
  const ciphertext = data.subarray(16);

  // Step 4: AES-256-CBC decrypt (PKCS#7 padding handled by Node crypto)
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString('utf8');
}

/**
 * If `body` contains an `encrypt` field and `encryptKey` is provided,
 * decrypt and return the parsed real event object.
 * Otherwise return `body` unchanged.
 */
export function maybeDecryptLarkBody(
  body: unknown,
  encryptKey: string | undefined,
): unknown {
  if (!encryptKey) return body;
  if (!body || typeof body !== 'object') return body;

  const b = body as Record<string, unknown>;
  if (typeof b['encrypt'] !== 'string') return body;

  const decryptedJson = decryptLarkEvent(b['encrypt'], encryptKey);
  return JSON.parse(decryptedJson) as unknown;
}

// ─── HMAC-SHA256 / verification-token check ───────────────────────────────────

/**
 * Verify a Lark webhook request.
 *
 * Priority:
 *   1. If `signingSecret` is configured → strict HMAC-SHA256 mode.
 *   2. Else if `verificationToken` is configured → token-in-body mode.
 *   3. Else → { ok: false, reason: 'missing_verification_config' }.
 */
export function verifyLarkWebhookRequest(
  input: LarkVerifyInput,
  config: LarkVerifyConfig = {},
): LarkVerifyResult {
  const signingSecret   = config.signingSecret?.trim()        || undefined;
  const verificationToken = config.verificationToken?.trim()  || undefined;
  const maxSkew = config.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const nowMs   = config.now ?? (() => Date.now());

  // ── Mode 1: signing-secret (HMAC-SHA256) ──────────────────────────────────
  if (signingSecret) {
    const timestamp = firstHeader(input.headers['x-lark-request-timestamp'])?.trim();
    const signature = firstHeader(input.headers['x-lark-signature'])?.trim().toLowerCase();

    if (!timestamp || !signature) {
      return { ok: false, reason: 'signature_required' };
    }

    const requestTimestamp = Number(timestamp);
    if (!Number.isFinite(requestTimestamp)) {
      return { ok: false, reason: 'invalid_timestamp' };
    }

    const nowSec = Math.floor(nowMs() / 1000);
    if (Math.abs(nowSec - requestTimestamp) > maxSkew) {
      return { ok: false, reason: 'replay_window_exceeded' };
    }

    const computed = createHmac('sha256', signingSecret)
      .update(`${timestamp}:${input.rawBody}`)
      .digest('hex');

    const expectedBuf = Buffer.from(computed);
    const actualBuf   = Buffer.from(signature);

    if (
      expectedBuf.length !== actualBuf.length ||
      !timingSafeEqual(expectedBuf, actualBuf)
    ) {
      return { ok: false, reason: 'invalid_signature' };
    }

    return { ok: true };
  }

  // ── Mode 2: verification-token (legacy) ───────────────────────────────────
  if (verificationToken) {
    const incoming = readBodyToken(input.parsedBody);
    if (!incoming) {
      return { ok: false, reason: 'missing_verification_token' };
    }
    if (incoming !== verificationToken) {
      return { ok: false, reason: 'invalid_verification_token' };
    }
    return { ok: true };
  }

  return { ok: false, reason: 'missing_verification_config' };
}
