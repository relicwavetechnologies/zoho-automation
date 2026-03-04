import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

const readHeader = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

export type LarkWebhookVerificationInput = {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  parsedBody?: unknown;
};

export type LarkWebhookVerificationResult = {
  ok: boolean;
  reason?:
    | 'missing_verification_config'
    | 'missing_headers'
    | 'replay_window_exceeded'
    | 'invalid_signature'
    | 'missing_verification_token'
    | 'invalid_verification_token';
};

const readBodyToken = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.token === 'string' && record.token.trim().length > 0) {
    return record.token.trim();
  }

  const header = record.header;
  if (header && typeof header === 'object') {
    const headerRecord = header as Record<string, unknown>;
    if (typeof headerRecord.token === 'string' && headerRecord.token.trim().length > 0) {
      return headerRecord.token.trim();
    }
  }

  return undefined;
};

export const verifyLarkWebhookRequest = (
  input: LarkWebhookVerificationInput,
): LarkWebhookVerificationResult => {
  const signingSecret = process.env.LARK_WEBHOOK_SIGNING_SECRET?.trim();
  const verificationToken = process.env.LARK_VERIFICATION_TOKEN?.trim();
  const timestamp = readHeader(input.headers['x-lark-request-timestamp']);
  const signature = readHeader(input.headers['x-lark-signature']);

  // Signature mode: if signature headers are present and signing secret exists, enforce HMAC verification.
  // If secret is not configured, gracefully fall back to verification-token mode below.
  if ((timestamp || signature) && signingSecret) {

    if (!timestamp || !signature) {
      return {
        ok: false,
        reason: 'missing_headers',
      };
    }

    const requestTimestamp = Number(timestamp);
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const maxSkew = Number(process.env.LARK_WEBHOOK_MAX_SKEW_SECONDS ?? DEFAULT_REPLAY_WINDOW_SECONDS);

    if (!Number.isFinite(requestTimestamp) || Math.abs(currentTimestamp - requestTimestamp) > maxSkew) {
      return {
        ok: false,
        reason: 'replay_window_exceeded',
      };
    }

    const computed = createHmac('sha256', signingSecret)
      .update(`${timestamp}:${input.rawBody}`)
      .digest('hex');

    const expected = Buffer.from(computed);
    const actual = Buffer.from(signature.trim().toLowerCase());

    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return {
        ok: false,
        reason: 'invalid_signature',
      };
    }

    return {
      ok: true,
    };
  }

  // Verification-token mode (commonly used in app event subscriptions).
  if (verificationToken) {
    const incomingToken = readBodyToken(input.parsedBody);
    if (!incomingToken) {
      return {
        ok: false,
        reason: 'missing_verification_token',
      };
    }
    if (incomingToken !== verificationToken) {
      return {
        ok: false,
        reason: 'invalid_verification_token',
      };
    }
    return {
      ok: true,
    };
  }

  return {
    ok: false,
    reason: 'missing_verification_config',
  };
};
