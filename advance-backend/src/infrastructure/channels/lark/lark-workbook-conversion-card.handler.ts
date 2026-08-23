import type { WorkbookConversionConfirmationService } from '../../../application/artifacts/workbook-conversion.service';
import type { Logger } from '../../../shared/logger';

export interface LarkAuthenticatedCardActor {
  readonly tenantKey: string;
  readonly openId: string;
  readonly userId: string;
  readonly companyId: string;
  readonly aiRole: string;
  readonly displayName?: string;
}

interface WorkbookConversionCardAction {
  readonly kind: 'workbook_conversion_confirm';
  readonly offerId: string;
}

type ParsedAction = WorkbookConversionCardAction | 'invalid' | null;

export function isWorkbookConversionCardAction(rawEvent: unknown): boolean {
  const event = asRecord(rawEvent);
  const action = parseAction(asRecord(event?.['action'])?.['value']);
  return typeof action === 'object' && action !== null;
}

export class LarkWorkbookConversionCardHandler {
  private readonly log: Logger;

  constructor(
    private readonly conversions: Pick<WorkbookConversionConfirmationService, 'confirmForActor'>,
    logger: Logger,
  ) {
    this.log = logger.child({ handler: 'lark-workbook-conversion-card' });
  }

  async handle(
    rawEvent: unknown,
    actor: LarkAuthenticatedCardActor,
  ): Promise<{ handled: boolean; responseBody?: unknown }> {
    const event = asRecord(rawEvent);
    const action = parseAction(asRecord(event?.['action'])?.['value']);
    if (!action) return { handled: false };
    if (action === 'invalid') return failure('This workbook conversion action is invalid. Ask Divo to prepare it again.');

    const context = asRecord(event?.['context']);
    const chatId = asNonEmptyString(context?.['open_chat_id']);
    if (!chatId) return failure('Divo could not verify which conversation opened this workbook conversion. Please try again.');
    const sourceMessageId = asNonEmptyString(context?.['open_message_id'] ?? event?.['open_message_id']);
    if (!sourceMessageId) return failure('Divo could not verify which card opened this workbook conversion. Please try again.');

    try {
      await this.conversions.confirmForActor({
        offerId: action.offerId,
        companyId: actor.companyId,
        userId: actor.userId,
        chatId,
        sourceMessageId,
      });
      return {
        handled: true,
        responseBody: {
          toast: { type: 'success', content: 'Workbook copy accepted. Divo is creating a new Google Sheet.' },
          delivery: 'replace_source_card',
          card: { type: 'raw', data: buildLockedWorkbookCard() },
        },
      };
    } catch (error) {
      this.log.warn('workbook_conversion_card.confirm_failed', {
        offerId: action.offerId,
        companyId: actor.companyId,
        userId: actor.userId,
        error: String(error),
      });
      return failure(error instanceof Error && /^This workbook conversion /.test(error.message)
        ? error.message
        : 'Divo could not start this workbook copy. Please try again.');
    }
  }
}

function buildLockedWorkbookCard(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      update_multi: true,
      enable_forward: false,
      summary: { content: 'Google Sheet copy started' },
    },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: 'Google Sheet copy started' },
    },
    body: {
      padding: '12px',
      elements: [{
        tag: 'markdown',
        content: 'Divo accepted the workbook conversion. Progress and the new Google Sheet will arrive in a separate card.\n\nThe original Excel workbook will not change.',
      }],
    },
  };
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
  if (payload?.['kind'] !== 'workbook_conversion_confirm') return null;
  if (Object.keys(payload).length !== 2 || !isUuid(payload['offerId'])) return 'invalid';
  return { kind: 'workbook_conversion_confirm', offerId: payload['offerId'] };
}

function failure(content: string): { handled: true; responseBody: unknown } {
  return { handled: true, responseBody: { toast: { type: 'error', content } } };
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
