import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sha256 } from '../../shared/hash';

export const CONNECTION_AUTHORIZATION_PROVIDER = 'google_workspace' as const;
export const CONNECTION_AUTHORIZATION_TTL_MS = 10 * 60_000;

export type ConnectionAuthorizationStatus =
  | 'pending'
  | 'exchanging'
  | 'connected'
  | 'expired'
  | 'failed';

export type ConnectionContinuationStatus =
  | 'blocked'
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

const connectionContinuationPayloadSchema = z.object({
  kind: z.literal('data_export_confirmation'),
  offerId: z.string().uuid(),
  progressMessageId: z.string().min(1),
  format: z.enum(['google_sheet', 'csv', 'xlsx']).optional(),
}).strict();

export type ConnectionContinuationPayload = z.infer<
  typeof connectionContinuationPayloadSchema
>;

export function parseConnectionContinuationPayload(
  value: unknown,
): ConnectionContinuationPayload | undefined {
  if (value === null || value === undefined) return undefined;
  return connectionContinuationPayloadSchema.parse(value);
}

export interface ConnectionAuthorizationTarget {
  companyId: string;
  userId: string;
  departmentId?: string;
  larkOpenId: string;
  larkTenantKey: string;
  chatId: string;
  chatType: string;
  originalMessageId: string;
  rootMessageId?: string;
  replyInThread: boolean;
  groupReplyMode?: string;
  originalRequest: string;
  requestedToolIds: string[];
  continuationPayload?: ConnectionContinuationPayload;
}

export interface ConnectionAuthorizationSecrets {
  state: string;
  stateHash: string;
  correlationId: string;
  continuationIdempotencyKey: string;
}

export function createConnectionAuthorizationSecrets(): ConnectionAuthorizationSecrets {
  const state = randomBytes(32).toString('base64url');
  const correlationId = randomUUID();
  return {
    state,
    stateHash: hashConnectionAuthorizationState(state),
    correlationId,
    continuationIdempotencyKey: `google-oauth-continuation:${correlationId}`,
  };
}

export function hashConnectionAuthorizationState(state: string): string {
  return sha256(state);
}

export function connectionAuthorizationDedupeKey(
  target: Pick<
    ConnectionAuthorizationTarget,
    'companyId' | 'userId' | 'larkTenantKey' | 'originalMessageId'
  >,
): string {
  return sha256([
    CONNECTION_AUTHORIZATION_PROVIDER,
    target.companyId,
    target.userId,
    target.larkTenantKey,
    target.originalMessageId,
  ].join(':'));
}
