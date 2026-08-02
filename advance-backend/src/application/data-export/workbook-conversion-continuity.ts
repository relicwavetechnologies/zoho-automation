import { randomUUID } from 'node:crypto';
import type { ConversationRepoPort } from '../../infrastructure/persistence/conversation.repository';
import {
  DATA_EXPORT_RESOURCE_TOOL,
  DATA_EXPORT_RESOURCE_TTL_MS,
  type DataExportResourceRecord,
} from './data-export-continuity';
import type {
  GoogleDriveXlsxConversionCompletion,
  GoogleDriveXlsxConversionJob,
} from './google-drive-xlsx-conversion.worker';

export class WorkbookConversionContinuityRecorder {
  constructor(private readonly conversations: Pick<ConversationRepoPort, 'appendTurn'>) {}

  async record(input: {
    readonly job: GoogleDriveXlsxConversionJob;
    readonly completion: GoogleDriveXlsxConversionCompletion;
  }): Promise<void> {
    const createdAt = new Date();
    const resource: DataExportResourceRecord = {
      version: 1,
      kind: 'data_export_resource',
      resourceRef: randomUUID(),
      ownerUserId: input.job.userId,
      artifactId: input.completion.spreadsheetId,
      artifactUrl: input.completion.artifactUrl,
      artifactType: 'google_sheet',
      connectionId: input.job.sourceConnectionId,
      spreadsheetId: input.completion.spreadsheetId,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + DATA_EXPORT_RESOURCE_TTL_MS).toISOString(),
    };
    const appended = await this.conversations.appendTurn(
      input.job.conversationKey,
      {
        role: 'tool',
        content: `Verified converted Google Sheet: ${input.completion.artifactUrl}`,
        timestamp: createdAt.toISOString(),
        toolName: DATA_EXPORT_RESOURCE_TOOL,
        toolOutcome: resource,
      },
      { companyId: input.job.companyId, channel: 'lark' },
      { dedupeKey: `workbook-conversion:${input.job.jobKey}:resource` },
    );
    if (!appended.ok) throw appended.error;
  }
}
