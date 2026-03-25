import { resolveChannelAdapter } from '../../channels';
import { channelIdentityRepository } from '../../channels/channel-identity.repository';
import { auditRepository } from '../../../modules/audit/audit.repository';
import { auditService } from '../../../modules/audit/audit.service';

type AlertReason = 'cross_user_target' | 'bulk_request';

const ALERT_ACTION = 'zoho.security.denied_alert';
const DEDUPE_WINDOW_MS = 15 * 60 * 1000;

const sanitizePreview = (value?: string): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return undefined;
  }
  return collapsed.length > 240 ? `${collapsed.slice(0, 237)}...` : collapsed;
};

export class ZohoSecurityAlertService {
  async maybeAlert(input: {
    companyId: string;
    actorId: string;
    requesterLabel?: string;
    reason: AlertReason;
    operation: string;
    module?: string;
    targetId?: string;
    preview?: string;
  }): Promise<void> {
    const dedupeKey = [
      input.companyId,
      input.actorId,
      input.reason,
      input.operation,
      input.module ?? '',
      input.targetId ?? '',
    ].join(':');
    const recent = await auditRepository.queryLogs({
      companyId: input.companyId,
      actorId: input.actorId,
      action: ALERT_ACTION,
      outcome: 'failure',
      limit: 20,
    });
    const now = Date.now();
    const duplicate = recent.some((entry) => {
      const metadata = entry.metadata as Record<string, unknown> | null;
      return metadata?.dedupeKey === dedupeKey && now - entry.createdAt.getTime() < DEDUPE_WINDOW_MS;
    });

    await auditService.recordLog({
      actorId: input.actorId,
      companyId: input.companyId,
      action: 'zoho.security.denied_access',
      outcome: 'failure',
      metadata: {
        reason: input.reason,
        operation: input.operation,
        module: input.module ?? null,
        targetId: input.targetId ?? null,
        preview: sanitizePreview(input.preview) ?? null,
      },
    });

    if (duplicate) {
      return;
    }

    const admins = await channelIdentityRepository.findAdminsByCompany(input.companyId);
    if (admins.length === 0) {
      return;
    }

    const adapter = resolveChannelAdapter('lark');
    const text = [
      '**Zoho access blocked**',
      `Requester: ${input.requesterLabel ?? input.actorId}`,
      `Reason: ${input.reason === 'bulk_request' ? 'bulk or company-wide access attempt' : 'cross-user record access attempt'}`,
      `Operation: ${input.operation}`,
      input.module ? `Module: ${input.module}` : undefined,
      input.targetId ? `Target: ${input.targetId}` : undefined,
      sanitizePreview(input.preview) ? `Preview: ${sanitizePreview(input.preview)}` : undefined,
    ].filter((line): line is string => Boolean(line)).join('\n');

    await Promise.allSettled(admins.map((admin) => adapter.sendMessage({
      chatId: admin.larkOpenId,
      text,
      correlationId: dedupeKey,
    })));

    await auditService.recordLog({
      actorId: input.actorId,
      companyId: input.companyId,
      action: ALERT_ACTION,
      outcome: 'failure',
      metadata: {
        dedupeKey,
        reason: input.reason,
        operation: input.operation,
        module: input.module ?? null,
        targetId: input.targetId ?? null,
      },
    });
  }
}

export const zohoSecurityAlertService = new ZohoSecurityAlertService();
