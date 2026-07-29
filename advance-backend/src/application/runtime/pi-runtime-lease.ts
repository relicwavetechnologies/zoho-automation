import { createHmac, randomUUID } from 'node:crypto';

export const PI_RUNTIME_AUDIENCE = 'divo-pi-runtime';
export const PI_RUNTIME_CHANNEL = 'lark';

export interface PiRuntimeLeaseClaims {
  readonly aud: typeof PI_RUNTIME_AUDIENCE;
  readonly channel: typeof PI_RUNTIME_CHANNEL;
  readonly sessionId: string;
  readonly userId: string;
  readonly companyId: string;
  readonly role?: string;
  readonly instanceId: string;
  readonly threadId: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export interface IssuePiRuntimeLeaseInput {
  readonly sessionId: string;
  readonly userId: string;
  readonly companyId: string;
  readonly role?: string;
  readonly instanceId: string;
  readonly threadId: string;
  readonly ttlSeconds?: number;
  readonly now?: Date;
}

export function issuePiRuntimeLease(
  input: IssuePiRuntimeLeaseInput,
  secret: string,
): string {
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  const claims: PiRuntimeLeaseClaims = {
    aud: PI_RUNTIME_AUDIENCE,
    channel: PI_RUNTIME_CHANNEL,
    sessionId: input.sessionId,
    userId: input.userId,
    companyId: input.companyId,
    ...(input.role ? { role: input.role } : {}),
    instanceId: input.instanceId,
    threadId: input.threadId,
    iat: issuedAt,
    exp: issuedAt + (input.ttlSeconds ?? 300),
    jti: randomUUID(),
  };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function isPiRuntimeLeaseClaims(
  value: Record<string, unknown>,
): boolean {
  return value['aud'] === PI_RUNTIME_AUDIENCE
    && value['channel'] === PI_RUNTIME_CHANNEL
    && typeof value['instanceId'] === 'string'
    && value['instanceId'].length > 0
    && typeof value['threadId'] === 'string'
    && value['threadId'].length > 0
    && typeof value['iat'] === 'number'
    && typeof value['exp'] === 'number'
    && typeof value['jti'] === 'string'
    && value['jti'].length > 0;
}
