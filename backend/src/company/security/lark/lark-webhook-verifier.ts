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
};

export type LarkWebhookVerificationResult = {
  ok: boolean;
  reason?: 'missing_secret' | 'missing_headers' | 'replay_window_exceeded' | 'invalid_signature';
};

export const verifyLarkWebhookRequest = (
  input: LarkWebhookVerificationInput,
): LarkWebhookVerificationResult => {
  const signingSecret = process.env.LARK_WEBHOOK_SIGNING_SECRET;
  if (!signingSecret) {
    return {
      ok: false,
      reason: 'missing_secret',
    };
  }

  const timestamp = readHeader(input.headers['x-lark-request-timestamp']);
  const signature = readHeader(input.headers['x-lark-signature']);

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

  // Assumption: signature base for current webhook path is `${timestamp}:${rawBody}`.
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
};
