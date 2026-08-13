import { createHmac, randomUUID } from 'node:crypto';
import { isRuntimeChannel, type RuntimeChannel } from '../../domain/channel/runtime-channel';

export const PI_RUNTIME_AUDIENCE = 'divo-pi-runtime';
export const PI_RUNTIME_CONTEXT_AUDIENCES = ['private', 'shared'] as const;
export type PiRuntimeContextAudience = typeof PI_RUNTIME_CONTEXT_AUDIENCES[number];

export interface PiRuntimeLeaseClaims {
  readonly aud: typeof PI_RUNTIME_AUDIENCE;
  /**
   * Which surface the backend launched this run for. Carried in the lease so a
   * container never has to guess, and so the middleware can tell a runtime lease
   * from a desktop session without assuming there is only one runtime.
   */
  readonly channel: RuntimeChannel;
  readonly sessionId: string;
  readonly userId: string;
  readonly companyId: string;
  readonly role?: string;
  readonly instanceId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly chatId: string;
  /**
   * Who can read the answer. A shared audience must never be launched with a
   * container that mounts the member's private workspace or session history.
   */
  readonly contextAudience: PiRuntimeContextAudience;
  /**
   * The department this run acts in. A member can belong to several, and the
   * container otherwise falls back to whichever is listed first — which would
   * silently run a Finance workflow under Sales' tool grants.
   */
  readonly departmentId?: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export interface IssuePiRuntimeLeaseInput {
  readonly channel: RuntimeChannel;
  readonly sessionId: string;
  readonly userId: string;
  readonly companyId: string;
  readonly role?: string;
  readonly instanceId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly chatId: string;
  readonly contextAudience?: PiRuntimeContextAudience;
  readonly departmentId?: string;
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
    channel: input.channel,
    sessionId: input.sessionId,
    userId: input.userId,
    companyId: input.companyId,
    ...(input.role ? { role: input.role } : {}),
    instanceId: input.instanceId,
    threadId: input.threadId,
    runId: input.runId,
    chatId: input.chatId,
    contextAudience: input.contextAudience ?? 'private',
    ...(input.departmentId ? { departmentId: input.departmentId } : {}),
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
    && isRuntimeChannel(value['channel'])
    && typeof value['instanceId'] === 'string'
    && value['instanceId'].length > 0
    && typeof value['threadId'] === 'string'
    && value['threadId'].length > 0
    && typeof value['runId'] === 'string'
    && value['runId'].length > 0
    && typeof value['chatId'] === 'string'
    && value['chatId'].length > 0
    && PI_RUNTIME_CONTEXT_AUDIENCES.includes(value['contextAudience'] as PiRuntimeContextAudience)
    && typeof value['iat'] === 'number'
    && typeof value['exp'] === 'number'
    && typeof value['jti'] === 'string'
    && value['jti'].length > 0;
}
