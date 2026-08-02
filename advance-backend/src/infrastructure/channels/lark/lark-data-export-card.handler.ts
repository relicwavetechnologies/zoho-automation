import type { DataExportOfferService } from '../../../application/data-export/data-export-offer.service';
import type { GoogleConnectionAuthorizationService } from '../../../application/connections/google-connection-authorization.service';
import type { Logger } from '../../../shared/logger';
import type { LarkAuthenticatedCardActor } from './lark-approval-card.handler';
import { buildGoogleConnectCardData } from './lark-google-connect';
import type { WorkbookConversionConfirmationService } from '../../../application/data-export/workbook-conversion.service';

interface DataExportCardAction {
  readonly kind: 'data_export_confirm';
  readonly offerId: string;
  readonly format?: 'google_sheet' | 'csv' | 'xlsx';
  readonly connectionId?: string;
}

interface WorkbookConversionCardAction {
  readonly kind: 'workbook_conversion_confirm';
  readonly offerId: string;
}

type ParsedAction = DataExportCardAction | WorkbookConversionCardAction | 'invalid' | null;

export function isDataExportCardAction(rawEvent: unknown): boolean {
  const event = asRecord(rawEvent);
  const action = parseAction(asRecord(event?.['action'])?.['value']);
  return typeof action === 'object' && action !== null;
}

export class LarkDataExportCardHandler {
  private readonly log: Logger;

  constructor(
    private readonly offers: Pick<DataExportOfferService, 'confirmForActor'>,
    logger: Logger,
    private readonly authorization?: Pick<GoogleConnectionAuthorizationService, 'issue'>,
    private readonly workbookConversions?: Pick<WorkbookConversionConfirmationService, 'confirmForActor'>,
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
    const sourceMessageId = asNonEmptyString(
      context?.['open_message_id'] ?? event?.['open_message_id'],
    );
    if (!sourceMessageId) {
      return failure('Divo could not verify which card opened this export. Please try again.');
    }

    if (action.kind === 'workbook_conversion_confirm') {
      if (!this.workbookConversions) {
        return failure('Workbook conversion is temporarily unavailable. Please try again.');
      }
      try {
        await this.workbookConversions.confirmForActor({
          offerId: action.offerId,
          companyId: actor.companyId,
          userId: actor.userId,
          chatId,
          sourceMessageId,
        });
        return {
          handled: true,
          responseBody: {
            toast: {
              type: 'success',
              content: 'Workbook copy accepted. Divo is creating a new Google Sheet.',
            },
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

    try {
      const result = await this.offers.confirmForActor({
        offerId: action.offerId,
        companyId: actor.companyId,
        userId: actor.userId,
        chatId,
        ...(action.format ? { destinationFormat: action.format } : {}),
        ...(action.connectionId
          ? {
              destinationConnectionId: action.connectionId,
              rememberExplicitPersonalDestination: true,
            }
          : {}),
      });
      if (result.disposition === 'choose_destination') {
        return {
          handled: true,
          responseBody: {
            card: {
              type: 'raw',
              data: buildDestinationChoiceCard(action, result.connections),
            },
          },
        };
      }
      if (result.disposition === 'connect_required') {
        if (!this.authorization) {
          return failure('Google connection is temporarily unavailable. Please try again.');
        }
        const authorization = await this.authorization.issue({
          companyId: actor.companyId,
          userId: actor.userId,
          larkOpenId: actor.openId,
          larkTenantKey: actor.tenantKey,
          chatId,
          chatType: result.replyInThread ? 'group' : 'p2p',
          originalMessageId: sourceMessageId,
          ...(result.replyToMessageId
            ? { rootMessageId: result.replyToMessageId }
            : {}),
          replyInThread: result.replyInThread,
          ...(result.replyInThread ? { groupReplyMode: 'threaded' } : {}),
          originalRequest: 'Resume the confirmed data export after Google is connected.',
          requestedToolIds: ['dataExport'],
          continuationPayload: {
            kind: 'data_export_confirmation',
            offerId: action.offerId,
            progressMessageId: sourceMessageId,
            ...(action.format ? { format: action.format } : {}),
          },
        });
        if (authorization.outcome === 'already_pending') {
          return {
            handled: true,
            responseBody: {
              toast: {
                type: 'info',
                content: 'Google connection is already awaiting authorization.',
              },
            },
          };
        }
        return {
          handled: true,
          responseBody: {
            card: {
              type: 'raw',
              data: buildGoogleConnectCardData({
                url: authorization.authorizeUrl,
                reason: 'Connect a writable Google account to create this export. Divo will continue automatically.',
              }),
            },
          },
        };
      }
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
        ? 'Export queued. Divo will post progress and the final file in a new card.'
        : 'Export already confirmed. Its existing job will deliver to the original Divo conversation.';
      return {
        handled: true,
        responseBody: {
          toast: { type: 'success', content: message },
          delivery: 'replace_source_card',
          card: {
            type: 'raw',
            data: buildLockedExportCard(
              result.disposition === 'queued' ? action.format : undefined,
              result.disposition,
            ),
          },
        },
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

function buildLockedExportCard(
  format: DataExportCardAction['format'],
  disposition: 'queued' | 'already_confirmed',
): Record<string, unknown> {
  const formatLabel = format === 'google_sheet'
    ? 'Google Sheet'
    : format === 'csv'
      ? 'CSV'
      : format === 'xlsx'
        ? 'Excel'
        : 'Data';
  const detail = disposition === 'queued'
    ? `Divo accepted the **${formatLabel}** export.`
    : 'This export was already accepted.';
  return {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      update_multi: true,
      enable_forward: false,
      summary: { content: `${formatLabel} export started` },
    },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: `${formatLabel} export started` },
    },
    body: {
      padding: '12px',
      elements: [{
        tag: 'markdown',
        content: `${detail}\n\nProgress and the final file will arrive in a separate Divo card.`,
      }],
    },
  };
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
  if (payload?.['kind'] === 'workbook_conversion_confirm') {
    if (Object.keys(payload).length !== 2 || !isUuid(payload['offerId'])) return 'invalid';
    return { kind: 'workbook_conversion_confirm', offerId: payload['offerId'] };
  }
  if (payload?.['kind'] === 'data_export_confirm') {
    const format = payload['format'];
    const connectionId = payload['connectionId'];
    if (
      Object.keys(payload).length !== 2
        + (format === undefined ? 0 : 1)
        + (connectionId === undefined ? 0 : 1)
      || !isUuid(payload['offerId'])
      || (
        format !== undefined
        && format !== 'google_sheet'
        && format !== 'csv'
        && format !== 'xlsx'
      )
      || (connectionId !== undefined && !isUuid(connectionId))
    ) return 'invalid';
    return {
      kind: 'data_export_confirm',
      offerId: payload['offerId'],
      ...(format ? { format } : {}),
      ...(connectionId ? { connectionId } : {}),
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
    /^Connect a writable Google account/,
    /^The selected Google export account is unavailable/,
  ].some(pattern => pattern.test(message))
    ? message
    : 'Divo could not confirm this export. Please try again.';
}

function buildDestinationChoiceCard(
  action: DataExportCardAction,
  connections: readonly {
    readonly connectionId: string;
    readonly label: string;
    readonly accountEmail?: string;
  }[],
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      update_multi: true,
      enable_forward: false,
      summary: { content: 'Choose where Divo should create the export' },
    },
    header: {
      template: 'default',
      title: { tag: 'plain_text', content: 'Choose a Google account' },
    },
    body: {
      vertical_spacing: '8px',
      padding: '12px',
      elements: [
        {
          tag: 'markdown',
          content: 'You have more than one writable Google account. Choose the account that should own this export.',
        },
        {
          tag: 'column_set',
          element_id: 'export_accounts',
          flex_mode: 'flow',
          horizontal_spacing: '8px',
          columns: connections.map((connection, index) => ({
            tag: 'column',
            width: 'auto',
            elements: [{
              tag: 'button',
              element_id: `export_account_${index + 1}`,
              text: {
                tag: 'plain_text',
                content: (connection.accountEmail ?? connection.label).slice(0, 48),
              },
              type: index === 0 ? 'primary' : 'default',
              size: 'small',
              behaviors: [{
                type: 'callback',
                value: {
                  action: JSON.stringify({
                    kind: action.kind,
                    offerId: action.offerId,
                    ...(action.format ? { format: action.format } : {}),
                    connectionId: connection.connectionId,
                  }),
                },
              }],
            }],
          })),
        },
      ],
    },
  };
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
