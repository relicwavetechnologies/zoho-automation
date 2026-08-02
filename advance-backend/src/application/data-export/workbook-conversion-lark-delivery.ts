import type { Logger } from '../../shared/logger';
import { buildFinalCard } from '../../infrastructure/channels/lark/lark-card.builder';
import type { GoogleDriveXlsxConversionCompletion } from './google-drive-xlsx-conversion.worker';

const PROGRESS_DELIVERY_PREFIX = 'wbc-progress';

const FAILURE_COPY =
  'Divo could not convert this Excel workbook. The original file was not changed. Please try again shortly.';
const RECOVERY_COPY =
  'The Google Sheet was created, but Divo could not finish sharing its link. Retry to restore the link and conversation context; no second Sheet will be created.';

export interface WorkbookConversionLarkDeliveryJob {
  readonly jobKey: string;
  readonly chatId: string;
  readonly sourceMessageId: string;
  readonly replyInThread: boolean;
}

export interface WorkbookConversionLarkDeliveryState {
  readonly job: WorkbookConversionLarkDeliveryJob;
  readonly progressMessageId?: string;
}

/**
 * Durable state belongs to the worker adapter, not the source card. The store
 * must atomically reserve a tracker and allow a stale reservation to be
 * reclaimed after a worker crash.
 */
export interface WorkbookConversionLarkDeliveryStore {
  register(job: WorkbookConversionLarkDeliveryJob): Promise<void>;
  reserveProgressMessage(jobKey: string): Promise<
    | { readonly status: 'claimed'; readonly job: WorkbookConversionLarkDeliveryJob }
    | { readonly status: 'sending' }
    | { readonly status: 'ready'; readonly state: WorkbookConversionLarkDeliveryState }
  >;
  completeProgressMessage(input: {
    readonly jobKey: string;
    readonly progressMessageId: string;
  }): Promise<WorkbookConversionLarkDeliveryState>;
}

export interface WorkbookConversionLarkMessenger {
  sendToChatId(
    chatId: string,
    content: string,
    replyToMessageId?: string,
    idempotencyKey?: string,
    replyInThread?: boolean,
  ): Promise<{ readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: Error }>;
  updateMessageById(
    messageId: string,
    content: string,
  ): Promise<{ readonly ok: true; readonly value: void } | { readonly ok: false; readonly error: Error }>;
}

/**
 * Lark delivery adapter for workbook conversions. It always creates and edits
 * a separate status card; the user's confirmation card is never a target.
 */
export class WorkbookConversionLarkDelivery {
  private readonly log: Logger;

  constructor(private readonly deps: {
    readonly store: WorkbookConversionLarkDeliveryStore;
    readonly lark: WorkbookConversionLarkMessenger;
    readonly logger: Logger;
  }) {
    this.log = deps.logger.child({ service: 'workbook-conversion-lark-delivery' });
  }

  async register(job: WorkbookConversionLarkDeliveryJob): Promise<void> {
    await this.deps.store.register(job);
  }

  async progress(input: { readonly jobKey: string; readonly content: string }): Promise<void> {
    const messageId = await this.ensureProgressMessage(input.jobKey, input.content);
    if (!messageId) return;
    await this.update(messageId, progressCard(input.content), input.jobKey, 'progress');
  }

  async completed(input: {
    readonly jobKey: string;
    readonly completion: GoogleDriveXlsxConversionCompletion;
  }): Promise<void> {
    const messageId = await this.ensureProgressMessage(
      input.jobKey,
      'Divo is creating a new Google Sheets copy. Your original Excel file will not be changed.',
    );
    if (!messageId) return;
    await this.update(messageId, completionCard(input.completion), input.jobKey, 'completed');
  }

  async failed(input: {
    readonly jobKey: string;
    readonly content: string;
    readonly retryable: boolean;
  }): Promise<void> {
    const messageId = await this.ensureProgressMessage(input.jobKey, FAILURE_COPY);
    if (!messageId) return;
    await this.update(messageId, failureCard(input.jobKey, input.retryable), input.jobKey, 'failed');
  }

  private async ensureProgressMessage(jobKey: string, initialContent: string): Promise<string | null> {
    const reserved = await this.deps.store.reserveProgressMessage(jobKey);
    if (reserved.status === 'ready') return reserved.state.progressMessageId ?? null;
    if (reserved.status === 'sending') {
      this.log.info('workbook_conversion.delivery.tracker_pending', { jobKey });
      return null;
    }
    const sent = await this.deps.lark.sendToChatId(
      reserved.job.chatId,
      progressCard(initialContent),
      reserved.job.sourceMessageId,
      deliveryKey(PROGRESS_DELIVERY_PREFIX, jobKey),
      reserved.job.replyInThread,
    );
    if (!sent.ok) throw sent.error;
    const state = await this.deps.store.completeProgressMessage({
      jobKey,
      progressMessageId: sent.value,
    });
    return state.progressMessageId ?? sent.value;
  }

  private async update(
    messageId: string,
    card: string,
    jobKey: string,
    stage: 'progress' | 'completed' | 'failed',
  ): Promise<void> {
    const updated = await this.deps.lark.updateMessageById(messageId, card);
    if (updated.ok) return;
    this.log.warn('workbook_conversion.delivery.update_failed', {
      jobKey,
      stage,
      error: updated.error.message,
    });
    throw updated.error;
  }
}

function progressCard(content: string): string {
  return buildFinalCard({
    markdown: `# Google Sheet copy in progress\n${content}\n\nThe original Excel workbook will not be changed.`,
  });
}

function completionCard(completion: GoogleDriveXlsxConversionCompletion): string {
  return buildFinalCard({
    markdown: [
      '# Google Sheet copy ready',
      'Divo created and verified a new Google Sheets copy. The original Excel workbook was not changed.',
      `[Open Google Sheet](${completion.artifactUrl})`,
    ].join('\n\n'),
  });
}

function failureCard(jobKey: string, retryable: boolean): string {
  const offerId = retryable ? retryOfferId(jobKey) : null;
  return buildFinalCard({
    markdown: `# Google Sheet copy could not finish\n${offerId ? RECOVERY_COPY : FAILURE_COPY}`,
    ...(offerId ? {
      actions: [{
        label: 'Retry handoff',
        value: JSON.stringify({ kind: 'workbook_conversion_confirm', offerId }),
        style: 'primary',
      }],
    } : {}),
  });
}

function retryOfferId(jobKey: string): string | null {
  const offerId = jobKey.startsWith('wbc_') ? jobKey.slice(4) : '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(offerId)
    ? offerId
    : null;
}

function deliveryKey(prefix: string, jobKey: string): string {
  return `${prefix}_${jobKey}`.slice(0, 50);
}
