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
    | 'signature_required'
    | 'invalid_timestamp'
    | 'replay_window_exceeded'
    | 'invalid_signature'
    | 'missing_verification_token'
    | 'invalid_verification_token';
};

export type LarkWebhookVerificationOptions = {
  now?: () => number;
  config?: {
    signingSecret?: string;
    verificationToken?: string;
    maxSkewSeconds?: number;
  };
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
  options: LarkWebhookVerificationOptions = {},
): LarkWebhookVerificationResult => {
  const resolvedConfig = {
    signingSecret: options.config?.signingSecret ?? process.env.LARK_WEBHOOK_SIGNING_SECRET?.trim(),
    verificationToken: options.config?.verificationToken ?? process.env.LARK_VERIFICATION_TOKEN?.trim(),
    maxSkewSeconds:
      options.config?.maxSkewSeconds
      ?? Number(process.env.LARK_WEBHOOK_MAX_SKEW_SECONDS ?? DEFAULT_REPLAY_WINDOW_SECONDS),
  };

  const timestamp = readHeader(input.headers['x-lark-request-timestamp'])?.trim();
  const signature = readHeader(input.headers['x-lark-signature'])?.trim().toLowerCase();
  const now = options.now ?? (() => Date.now());

  // Signature mode is strict when signing secret is configured.
  if (resolvedConfig.signingSecret) {
    if (!timestamp || !signature) {
      return {
        ok: false,
        reason: 'signature_required',
      };
    }

    const requestTimestamp = Number(timestamp);
    if (!Number.isFinite(requestTimestamp)) {
      return {
        ok: false,
        reason: 'invalid_timestamp',
      };
    }

    const currentTimestamp = Math.floor(now() / 1000);
    if (Math.abs(currentTimestamp - requestTimestamp) > resolvedConfig.maxSkewSeconds) {
      return {
        ok: false,
        reason: 'replay_window_exceeded',
      };
    }

    const computed = createHmac('sha256', resolvedConfig.signingSecret)
      .update(`${timestamp}:${input.rawBody}`)
      .digest('hex');

    const expected = Buffer.from(computed);
    const actual = Buffer.from(signature);

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
  if (resolvedConfig.verificationToken) {
    const incomingToken = readBodyToken(input.parsedBody);
    if (!incomingToken) {
      return {
        ok: false,
        reason: 'missing_verification_token',
      };
    }
    if (incomingToken !== resolvedConfig.verificationToken) {
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
