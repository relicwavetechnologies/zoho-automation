import type { ChannelIdentityRepoPort } from '../../persistence/channel-identity.repository';
import type { LarkAuthenticatedCardActor } from './lark-workbook-conversion-card.handler';

export async function resolveAuthenticatedCardActor(
  cardEvent: unknown,
  envelope: Record<string, unknown>,
  header: Record<string, unknown> | undefined,
  identityRepo: ChannelIdentityRepoPort,
): Promise<(LarkAuthenticatedCardActor & { activeDepartmentId?: string }) | null> {
  const card = toRecord(cardEvent);
  const operator = toRecord(card?.['operator']);
  const operatorId = toRecord(operator?.['operator_id']);
  const envelopeEvent = toRecord(envelope['event']);
  const envelopeOperator = toRecord(envelopeEvent?.['operator']);
  const envelopeOperatorId = toRecord(envelopeOperator?.['operator_id']);
  const openId = firstNonEmptyString(
    operator?.['open_id'], operatorId?.['open_id'], card?.['open_id'],
    envelopeOperator?.['open_id'], envelopeOperatorId?.['open_id'],
    envelopeEvent?.['open_id'], envelope['open_id'],
  );
  const larkUserId = firstNonEmptyString(
    operator?.['user_id'], operatorId?.['user_id'], card?.['user_id'],
    envelopeOperator?.['user_id'], envelopeOperatorId?.['user_id'],
    envelopeEvent?.['user_id'], envelope['user_id'],
  );
  const tenantKey = firstNonEmptyString(
    header?.['tenant_key'], card?.['tenant_key'],
    envelopeEvent?.['tenant_key'], envelope['tenant_key'],
  );
  if ((!openId && !larkUserId) || !tenantKey) return null;

  const resolved = await identityRepo.resolveByLarkTenantIdentity(openId, tenantKey, larkUserId);
  if (!resolved.ok || !resolved.value) return null;
  const canonicalOpenId = resolved.value.larkOpenId ?? openId;
  if (!canonicalOpenId) return null;
  const displayName = firstNonEmptyString(
    operator?.['name'], card?.['user_name'], resolved.value.displayName,
  );
  return {
    tenantKey,
    openId: canonicalOpenId,
    userId: resolved.value.userId,
    companyId: resolved.value.companyId,
    aiRole: resolved.value.aiRole,
    ...(displayName ? { displayName } : {}),
    ...(resolved.value.activeDepartmentId
      ? { activeDepartmentId: resolved.value.activeDepartmentId }
      : {}),
  };
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find(value => typeof value === 'string' && value.trim().length > 0) as string | undefined;
}
