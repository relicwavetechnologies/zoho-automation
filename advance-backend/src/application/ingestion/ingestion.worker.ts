import { Worker, type Job } from 'bullmq';
import type { IngestionJobPayload } from './ingestion.queue';
import { INGESTION_QUEUE_NAME } from './ingestion.queue';
import type { IngestionService } from './ingestion.service';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import type { Logger } from '../../shared/logger';
import type { TypedEnv } from '../../config/env';
import type { LarkChatContextService } from '../chat-context/lark-chat-context.service';
import type { GroupChatAttachmentContext } from '../../domain/conversation/group-context';

export interface IngestionWorkerDeps {
  redisUrl:         string;
  ingestionService: IngestionService;
  larkAdapter:      LarkChannelAdapter;
  env:              TypedEnv;
  logger:           Logger;
  chatContext?:     LarkChatContextService;
  concurrency?:     number;
}

export class IngestionWorker {
  private worker?: Worker<IngestionJobPayload>;
  private readonly log: Logger;

  constructor(private readonly deps: IngestionWorkerDeps) {
    this.log = deps.logger.child({ service: 'ingestion-worker' });
  }

  start(): void {
    const { redisUrl, concurrency = 2 } = this.deps;

    this.worker = new Worker<IngestionJobPayload>(
      INGESTION_QUEUE_NAME,
      async (job: Job<IngestionJobPayload>) => this.process(job),
      {
        connection:  { url: redisUrl },
        concurrency,
      },
    );

    this.worker.on('completed', job => {
      this.log.info('ingestion.worker.completed', { jobId: job.id });
    });
    this.worker.on('failed', (job, err) => {
      this.log.error('ingestion.worker.failed', { jobId: job?.id, error: String(err) });
    });

    this.log.info('ingestion.worker.started', { concurrency });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
  }

  private async process(job: Job<IngestionJobPayload>): Promise<void> {
    const payload = job.data;
    this.log.info('ingestion.worker.processing', { jobId: job.id, jobType: payload.jobType, fileName: payload.fileName });

    let buffer: Buffer;

    try {
      if (payload.jobType === 'buffer') {
        if (!payload.bufferBase64) throw new Error('Missing bufferBase64 for buffer job');
        buffer = Buffer.from(payload.bufferBase64, 'base64');
      } else {
        buffer = await this.downloadLarkFile(payload);
      }

      const result = await this.deps.ingestionService.ingestBuffer({
        companyId:       payload.companyId,
        uploaderUserId:  payload.uploaderUserId,
        uploaderChannel: payload.uploaderChannel,
        fileName:        payload.fileName,
        mimeType:        payload.mimeType,
        buffer,
        visibility:      payload.visibility ?? 'personal',
        ...(payload.allowedRoles ? { allowedRoles: payload.allowedRoles } : {}),
      });

      await this.updateGroupAttachment(payload, {
        kind: payload.jobType === 'lark_image' || payload.mimeType.startsWith('image/') ? 'image' : 'file',
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        ...(payload.larkFileKey ? { larkFileKey: payload.larkFileKey } : {}),
        ...(payload.larkMessageId ? { larkMessageId: payload.larkMessageId } : {}),
        fileAssetId: result.fileAssetId,
        cloudinaryUrl: result.cloudinaryUrl,
        ingestionStatus: 'indexed',
        indexedChunkCount: result.chunkCount,
        documentClass: result.documentClass,
        retrievalHint: `For more detail beyond the inline excerpt, use contextSearch or documentRag with fileAssetId="${result.fileAssetId}" or filename "${payload.fileName}".`,
      });

      // Quote-reply to the original file message with success notification
      if (payload.chatId && payload.replyToMessageId) {
        await this.deps.larkAdapter.sendToChatId(
          payload.chatId,
          buildIndexedCard(payload.fileName, result.chunkCount),
          payload.replyToMessageId,
        ).catch(() => { /* non-fatal */ });
      }
    } catch (e) {
      // On the last retry attempt, send a failure reply so the user knows indexing failed
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isLastAttempt && payload.chatId && payload.replyToMessageId) {
        const errMsg = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
        await this.updateGroupAttachment(payload, {
          kind: payload.jobType === 'lark_image' || payload.mimeType.startsWith('image/') ? 'image' : 'file',
          fileName: payload.fileName,
          mimeType: payload.mimeType,
          ...(payload.larkFileKey ? { larkFileKey: payload.larkFileKey } : {}),
          ...(payload.larkMessageId ? { larkMessageId: payload.larkMessageId } : {}),
          ingestionStatus: 'failed',
          error: errMsg,
        });
        await this.deps.larkAdapter.sendToChatId(
          payload.chatId,
          buildFailedCard(payload.fileName, errMsg),
          payload.replyToMessageId,
        ).catch(() => { /* non-fatal */ });
      }
      throw e;
    }
  }

  private async downloadLarkFile(payload: IngestionJobPayload): Promise<Buffer> {
    if (!payload.larkFileKey)    throw new Error('Missing larkFileKey for Lark job');
    if (!payload.larkMessageId)  throw new Error('Missing larkMessageId for Lark job');
    const { LarkFileClient } = await import('../../infrastructure/channels/lark/clients/lark-file.client');
    const client = new LarkFileClient(this.deps.env, this.deps.logger);
    if (payload.jobType === 'lark_image') {
      return client.downloadImage(payload.larkMessageId, payload.larkFileKey);
    }
    return client.downloadFile(payload.larkMessageId, payload.larkFileKey);
  }

  private async updateGroupAttachment(
    payload: IngestionJobPayload,
    attachment: GroupChatAttachmentContext,
  ): Promise<void> {
    if (!this.deps.chatContext || !payload.chatId || !payload.groupContextMessageId) return;

    const result = await this.deps.chatContext.updateMessageAttachments({
      companyId: payload.companyId,
      chatId: payload.chatId,
      messageId: payload.groupContextMessageId,
      attachments: [attachment],
    });

    if (!result.ok) {
      this.log.warn('ingestion.worker.group_context_update_failed', {
        fileName: payload.fileName,
        messageId: payload.groupContextMessageId,
        error: result.error.message,
      });
    }
  }
}

function buildIndexedCard(fileName: string, chunkCount: number): string {
  return JSON.stringify({
    msg_type: 'interactive',
    card: JSON.stringify({
      elements: [{
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `✅ **Indexed** ${fileName} — ${chunkCount} section${chunkCount !== 1 ? 's' : ''}. Ask me anything about it.`,
        },
      }],
    }),
  });
}

function buildFailedCard(fileName: string, reason: string): string {
  return JSON.stringify({
    msg_type: 'interactive',
    card: JSON.stringify({
      elements: [{
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `❌ **Failed to index** ${fileName}.\n${reason}`,
        },
      }],
    }),
  });
}
