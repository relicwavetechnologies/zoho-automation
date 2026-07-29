import { createPublicKey, verify } from 'node:crypto';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ALLOWED_ISSUERS = new Set([
  'accounts.google.com',
  'https://accounts.google.com',
]);

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  email?: string;
  email_verified?: boolean | string;
}

interface GoogleJwks {
  keys?: Array<Record<string, unknown> & { kid?: string; alg?: string }>;
}

export class GooglePubSubPushVerifier {
  private cached?: { expiresAt: number; keys: GoogleJwks['keys'] };

  constructor(
    private readonly config: {
      audience: string;
      serviceAccountEmail: string;
    },
    private readonly request: typeof fetch = fetch,
  ) {}

  async verifyAuthorizationHeader(header: string | undefined): Promise<void> {
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new Error('Missing Pub/Sub bearer token.');
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Malformed Pub/Sub bearer token.');
    const [encodedHeader, encodedClaims, encodedSignature] = parts as [
      string,
      string,
      string,
    ];
    const jwtHeader = decodeJson<JwtHeader>(encodedHeader);
    const claims = decodeJson<JwtClaims>(encodedClaims);
    if (jwtHeader.alg !== 'RS256' || !jwtHeader.kid) {
      throw new Error('Unsupported Pub/Sub bearer token.');
    }
    const key = (await this.googleKeys()).find(item => item.kid === jwtHeader.kid);
    if (!key) throw new Error('Unknown Pub/Sub signing key.');
    const valid = verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      createPublicKey({ key: key as never, format: 'jwk' }),
      Buffer.from(encodedSignature, 'base64url'),
    );
    if (!valid) throw new Error('Invalid Pub/Sub bearer signature.');
    validateClaims(claims, this.config);
  }

  private async googleKeys(): Promise<NonNullable<GoogleJwks['keys']>> {
    if (this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.keys ?? [];
    }
    const response = await this.request(GOOGLE_JWKS_URL);
    if (!response.ok) throw new Error('Could not load Google signing keys.');
    const payload = await response.json() as GoogleJwks;
    const maxAge = Number(
      response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] ?? 3600,
    );
    this.cached = {
      expiresAt: Date.now() + Math.max(60, maxAge) * 1_000,
      keys: payload.keys ?? [],
    };
    return this.cached.keys ?? [];
  }
}

function validateClaims(
  claims: JwtClaims,
  expected: { audience: string; serviceAccountEmail: string },
): void {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (!claims.iss || !ALLOWED_ISSUERS.has(claims.iss)) {
    throw new Error('Invalid Pub/Sub token issuer.');
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.audience)) {
    throw new Error('Invalid Pub/Sub token audience.');
  }
  if (
    typeof claims.exp !== 'number'
    || claims.exp < nowSeconds - 60
    || typeof claims.iat !== 'number'
    || claims.iat > nowSeconds + 60
  ) {
    throw new Error('Expired or invalid Pub/Sub token time claims.');
  }
  if (
    claims.email?.toLocaleLowerCase()
      !== expected.serviceAccountEmail.toLocaleLowerCase()
    || ![true, 'true'].includes(claims.email_verified ?? false)
  ) {
    throw new Error('Unexpected Pub/Sub push service account.');
  }
}

function decodeJson<T>(value: string): T {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
  } catch {
    throw new Error('Malformed Pub/Sub bearer token payload.');
  }
}
