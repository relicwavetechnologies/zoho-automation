import type { CachePort } from '../../shared/cache';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import type { Logger } from '../../shared/logger';
import type { KnowledgeShareService, ShareRequest } from './knowledge-share.service';
import { SHARE_CACHE_PREFIX } from './knowledge-share.service';
import { buildShareApprovedCard, buildShareRejectedCard } from './share-card-builder';

export interface ShareResolveResult {
  ok: boolean;
  responseBody: Record<string, unknown>;
}

export class ShareResolverService {
  private readonly log: Logger;

  constructor(
    private readonly shareService: KnowledgeShareService,
    private readonly cache: CachePort,
    private readonly larkAdapter: LarkChannelAdapter,
    logger: Logger,
  ) {
    this.log = logger.child({ service: 'share-resolver' });
  }

  /** Returns true if this event looks like a share approval card action. */
  isShareAction(cardEvent: unknown): boolean {
    try {
      const event = cardEvent as Record<string, unknown>;
      const action = this.extractAction(event);
      return action === 'share_approve' || action === 'share_reject';
    } catch { return false; }
  }

  async handle(cardEvent: unknown): Promise<ShareResolveResult> {
    const event = cardEvent as Record<string, unknown>;

    // Extract action metadata
    const { action, shareId, adminOpenId, adminName } = this.parseEvent(event);

    if (!shareId) {
      return { ok: false, responseBody: { ok: false, reason: 'missing_share_id' } };
    }

    const cacheResult = await this.cache.get<ShareRequest>(`${SHARE_CACHE_PREFIX}${shareId}`);
    if (!cacheResult.ok || !cacheResult.value) {
      return { ok: false, responseBody: { toast: { type: 'warning', content: 'Share request expired or not found.' } } };
    }

    const request = cacheResult.value;
    const approved = action === 'share_approve';

    this.log.info('share-resolver.handle', { shareId, approved, fileAssetId: request.fileAssetId, adminOpenId });

    if (approved) {
      await this.shareService.promoteToShared(request.fileAssetId, request.companyId, request.requesterUserId);
    }

    // Delete the share request from cache regardless of outcome
    await this.cache.del(`${SHARE_CACHE_PREFIX}${shareId}`);

    // Update all admin approval cards in-place
    const resolvedCard = approved
      ? buildShareApprovedCard(request.fileName, adminName)
      : buildShareRejectedCard(request.fileName, adminName);

    for (const msgId of request.cardMessageIds) {
      try {
        await this.larkAdapter.updateMessageById(msgId, resolvedCard);
      } catch { /* non-fatal */ }
    }

    // Notify the requester
    if (request.requesterOpenId) {
      const notifyText = approved
        ? `✅ Your share request for **${request.fileName}** was approved. It's now available to your team.`
        : `❌ Your share request for **${request.fileName}** was rejected by an admin.`;
      try {
        await this.larkAdapter.sendDirectCard(
          request.requesterOpenId,
          JSON.stringify({
            msg_type: 'interactive',
            card: JSON.stringify({
              elements: [{ tag: 'div', text: { tag: 'lark_md', content: notifyText } }],
            }),
          }),
        );
      } catch { /* non-fatal */ }
    }

    return {
      ok: true,
      responseBody: {
        toast: {
          type:    approved ? 'success' : 'info',
          content: approved ? `Approved — ${request.fileName} is now shared.` : 'Rejected.',
        },
      },
    };
  }

  private extractAction(event: Record<string, unknown>): string {
    // Card 2.0 shape: event.action.value is a JSON string
    const eventInner = event['event'] as Record<string, unknown> | undefined;
    const target = eventInner ?? event;
    const action = target['action'] as Record<string, unknown> | undefined;
    const valueRaw = action?.['value'];
    if (typeof valueRaw === 'string') {
      const parsed = JSON.parse(valueRaw) as Record<string, unknown>;
      return String(parsed['action'] ?? '');
    }
    if (typeof valueRaw === 'object' && valueRaw !== null) {
      return String((valueRaw as Record<string, unknown>)['action'] ?? '');
    }
    return '';
  }

  private parseEvent(event: Record<string, unknown>): {
    action: string;
    shareId: string;
    adminOpenId: string;
    adminName: string;
  } {
    const eventInner = event['event'] as Record<string, unknown> | undefined;
    const target = eventInner ?? event;

    const actionObj = target['action'] as Record<string, unknown> | undefined;
    const valueRaw = actionObj?.['value'];
    let parsed: Record<string, unknown> = {};
    if (typeof valueRaw === 'string') {
      try { parsed = JSON.parse(valueRaw) as Record<string, unknown>; } catch { /* ignore */ }
    } else if (typeof valueRaw === 'object' && valueRaw !== null) {
      parsed = valueRaw as Record<string, unknown>;
    }

    const operator = target['operator'] as Record<string, unknown> | undefined;
    const adminOpenId = String(operator?.['open_id'] ?? '');
    const adminName   = String(operator?.['name'] ?? 'Admin');

    return {
      action:      String(parsed['action'] ?? ''),
      shareId:     String(parsed['shareId'] ?? ''),
      adminOpenId,
      adminName,
    };
  }
}
