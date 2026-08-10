import type {
  OfferedWorkbookConversionEffect,
  RunEffectReceiptStore,
} from '../runtime/run-effect-receipt.store';
import type {
  WorkbookConversionJobPayload,
  WorkbookConversionQueuePort,
} from './workbook-conversion.queue';

export class WorkbookConversionConfirmationService {
  constructor(private readonly deps: {
    readonly offers: Pick<RunEffectReceiptStore, 'getWorkbookConversionOfferForActor'>;
    readonly queue: WorkbookConversionQueuePort;
  }) {}

  async confirmForActor(input: {
    readonly offerId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly sourceMessageId: string;
  }): Promise<{ readonly disposition: 'queued'; readonly jobId: string }> {
    const offer = await this.deps.offers.getWorkbookConversionOfferForActor(input);
    if (!offer) {
      throw new Error('This workbook conversion has expired or belongs to another Divo conversation.');
    }
    const payload = jobPayload(offer, input.sourceMessageId);
    return { disposition: 'queued', jobId: await this.deps.queue.enqueue(payload) };
  }
}

function jobPayload(
  offer: OfferedWorkbookConversionEffect,
  sourceMessageId: string,
): WorkbookConversionJobPayload {
  return {
    version: 1,
    offerId: offer.offerId,
    companyId: offer.companyId,
    userId: offer.userId,
    ...(offer.departmentId ? { departmentId: offer.departmentId } : {}),
    chatId: offer.chatId,
    sourceMessageId,
    conversationKey: offer.threadId,
    replyInThread: offer.replyInThread === true,
    connectionId: offer.connectionId,
    fileId: offer.fileId,
    ...(offer.fileName ? { fileName: offer.fileName } : {}),
  };
}
