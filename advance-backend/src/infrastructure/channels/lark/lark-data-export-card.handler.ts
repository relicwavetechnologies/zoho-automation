import type { DataExportOfferService } from '../../../application/data-export/data-export-offer.service';
import type { Logger } from '../../../shared/logger';
import type { LarkAuthenticatedCardActor } from './lark-approval-card.handler';

interface DataExportCardAction {
  readonly kind: 'data_export_confirm';
  readonly offerId: string;
  readonly format?: 'google_sheet' | 'csv';
}

type ParsedAction = DataExportCardAction | 'invalid' | null;

export class LarkDataExportCardHandler {
  private readonly log: Logger;

  constructor(
    private readonly offers: Pick<DataExportOfferService, 'confirmForActor'>,
    logger: Logger,
  ) {
    this.log = logger.child({ handler: 'lark-data-export-card' });
  }

  async handle(
    rawEvent: unknown,
    actor: LarkAuthenticatedCardActor,
  ): Promise<{ handled: boolean; responseBody?: unknown }> {
    const event = asRecord(rawEvent);
    const action = parseAction(asRecord(event?.['action'])?.['value']);
    if (!action) return { handled: false };
    if (action === 'invalid') {
      return failure('This export action is invalid. Ask Divo to prepare the export again.');
    }

    const context = asRecord(event?.['context']);
    const chatId = asNonEmptyString(context?.['open_chat_id']);
    if (!chatId) {
      return failure('Divo could not verify which conversation opened this export. Please try again.');
    }
    const progressMessageId = asNonEmptyString(
      context?.['open_message_id'] ?? event?.['open_message_id'],
    );
    if (!progressMessageId) {
      return failure('Divo could not verify which card opened this export. Please try again.');
    }

    try {
      const result = await this.offers.confirmForActor({
        offerId: action.offerId,
        companyId: actor.companyId,
        userId: actor.userId,
        chatId,
        progressMessageId,
        ...(action.format ? { destinationFormat: action.format } : {}),
      });
      if (result.disposition === 'in_progress') {
        return {
          handled: true,
          responseBody: {
            toast: {
              type: 'info',
              content: 'This export confirmation is already being processed. Try again in a minute if no update appears.',
            },
          },
        };
      }

      const message = result.disposition === 'queued'
        ? 'Export queued. This card will show its progress and final file.'
        : 'Export already confirmed. Its existing job will deliver to the original Divo conversation.';
      return {
        handled: true,
        responseBody: { toast: { type: 'success', content: message } },
      };
    } catch (error) {
      this.log.warn('data_export_card.confirm_failed', {
        offerId: action.offerId,
        companyId: actor.companyId,
        userId: actor.userId,
        error: String(error),
      });
      return failure(safeConfirmationMessage(error));
    }
  }
}

function parseAction(rawValue: unknown): ParsedAction {
  let candidate = rawValue;
  try {
    for (let i = 0; i < 3; i++) {
      if (typeof candidate === 'string') {
        candidate = JSON.parse(candidate);
        continue;
      }
      const record = asRecord(candidate);
      if (record && Object.keys(record).length === 1 && 'action' in record) {
        candidate = record['action'];
        continue;
      }
      break;
    }
  } catch {
    return null;
  }
  const payload = asRecord(candidate);
  if (payload?.['kind'] === 'data_export_confirm') {
    const format = payload['format'];
    if (
      Object.keys(payload).length !== (format === undefined ? 2 : 3)
      || !isUuid(payload['offerId'])
      || (format !== undefined && format !== 'google_sheet' && format !== 'csv')
    ) return 'invalid';
    return {
      kind: 'data_export_confirm',
      offerId: payload['offerId'],
      ...(format ? { format } : {}),
    };
  }
  return null;
}

function failure(content: string): { handled: true; responseBody: unknown } {
  return {
    handled: true,
    responseBody: { toast: { type: 'error', content } },
  };
}

function safeConfirmationMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return [
    /^This data export offer has expired\./,
    /^This data export offer is no longer available\./,
    /^Confirm this data export in the same Divo conversation/,
    /^The export requester no longer has active company access\./,
    /^Data export permission was revoked/,
    / read permission was revoked before confirmation\.$/,
    /^Complete Zoho exports require full company Zoho read scope\./,
  ].some(pattern => pattern.test(message))
    ? message
    : 'Divo could not confirm this export. Please try again.';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
