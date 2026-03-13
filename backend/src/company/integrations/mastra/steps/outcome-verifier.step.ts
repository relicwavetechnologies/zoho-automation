import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';

import { zohoDataClient, type ZohoSourceType } from '../../zoho';
import { larkDocsService } from '../../../channels/lark/lark-docs.service';

const taskOutcomeSchema = z.object({
  taskId: z.string(),
  claimed: z.string(),
  isWriteOperation: z.boolean(),
  externalRef: z.string().optional(),
  ownerAgent: z.string(),
});

const verifierResultSchema = z.object({
  taskId: z.string(),
  verified: z.boolean(),
  confidence: z.enum(['high', 'low', 'unverifiable']),
  reason: z.string(),
});

export const verifierOutputSchema = z.object({
  allVerified: z.boolean(),
  results: z.array(verifierResultSchema),
  blockers: z.array(z.string()),
});

const extractLarkDocumentId = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  return value.match(/\/docx\/([A-Za-z0-9]+)/i)?.[1]
    ?? value.match(/\b([A-Za-z0-9]{20,})\b/)?.[1];
};

const isLikelyZohoRecordId = (value: string | undefined): value is string => Boolean(value && /^\d{12,}$/.test(value.trim()));

const inferZohoSourceTypes = (task: z.infer<typeof taskOutcomeSchema>): ZohoSourceType[] => {
  const haystack = `${task.claimed} ${task.externalRef ?? ''}`.toLowerCase();
  const prioritized: ZohoSourceType[] = [];

  if (haystack.includes('deal')) prioritized.push('zoho_deal');
  if (haystack.includes('contact')) prioritized.push('zoho_contact');
  if (haystack.includes('lead')) prioritized.push('zoho_lead');
  if (haystack.includes('ticket')) prioritized.push('zoho_ticket');

  for (const fallback of ['zoho_deal', 'zoho_contact', 'zoho_lead', 'zoho_ticket'] as const) {
    if (!prioritized.includes(fallback)) {
      prioritized.push(fallback);
    }
  }

  return prioritized;
};

export const outcomeVerifierStep = createStep({
  id: 'outcome-verifier',
  inputSchema: z.object({
    completedTasks: z.array(taskOutcomeSchema),
    originalSuccessCriteria: z.array(z.object({
      taskId: z.string(),
      criteria: z.string(),
    })),
  }),
  outputSchema: verifierOutputSchema,
  execute: async ({ inputData, requestContext }) => {
    const results: Array<z.infer<typeof verifierResultSchema>> = [];

    for (const task of inputData.completedTasks) {
      if (!task.isWriteOperation) {
        results.push({
          taskId: task.taskId,
          verified: true,
          confidence: 'high',
          reason: 'read-only operation',
        });
        continue;
      }

      try {
        results.push(await verifyWriteByOwnerAgent(task, requestContext));
      } catch (error) {
        results.push({
          taskId: task.taskId,
          verified: false,
          confidence: 'low',
          reason: `Verification threw: ${error instanceof Error ? error.message : 'unknown_error'}`,
        });
      }
    }

    const blockers = results
      .filter((result) => !result.verified && result.confidence !== 'unverifiable')
      .map((result) => result.taskId);

    return {
      allVerified: blockers.length === 0,
      results,
      blockers,
    };
  },
});

async function verifyWriteByOwnerAgent(
  task: z.infer<typeof taskOutcomeSchema>,
  requestContext?: { get: (key: string) => unknown },
): Promise<z.infer<typeof verifierResultSchema>> {
  switch (task.ownerAgent) {
    case 'larkDoc': {
      const documentId = extractLarkDocumentId(task.externalRef);
      if (!documentId) {
        return {
          taskId: task.taskId,
          verified: false,
          confidence: 'unverifiable',
          reason: 'Missing Lark document reference for verification.',
        };
      }

      const credentialMode =
        requestContext?.get('larkAuthMode') === 'user_linked' ? 'user_linked' : 'tenant';
      const document = await larkDocsService.inspectDocument({
        companyId: requestContext?.get('companyId') as string | undefined,
        larkTenantKey: requestContext?.get('larkTenantKey') as string | undefined,
        appUserId: requestContext?.get('userId') as string | undefined,
        credentialMode,
        documentId,
      });

      return {
        taskId: task.taskId,
        verified: document.exists,
        confidence: document.exists ? 'high' : 'low',
        reason: document.exists
          ? `Verified Lark Doc ${document.documentId} with ${document.blockCount} blocks.`
          : `Lark Doc ${document.documentId} was not found.`,
      };
    }
    case 'zoho': {
      const sourceId = task.externalRef?.trim();
      const companyId = requestContext?.get('companyId') as string | undefined;
      if (!sourceId || !companyId) {
        return {
          taskId: task.taskId,
          verified: false,
          confidence: 'unverifiable',
          reason: 'Missing Zoho companyId or record reference for verification.',
        };
      }

      if (!isLikelyZohoRecordId(sourceId)) {
        return {
          taskId: task.taskId,
          verified: false,
          confidence: 'unverifiable',
          reason: `Invalid Zoho record reference for verification: ${sourceId}`,
        };
      }

      const errors: string[] = [];
      for (const sourceType of inferZohoSourceTypes(task)) {
        try {
          const record = await zohoDataClient.fetchRecordBySource({
            companyId,
            sourceType,
            sourceId,
          });
          if (record) {
            return {
              taskId: task.taskId,
              verified: true,
              confidence: 'high',
              reason: `Verified Zoho record ${sourceId} via ${sourceType}.`,
            };
          }
        } catch (error) {
          errors.push(error instanceof Error ? error.message : 'unknown_zoho_verification_error');
        }
      }

      return {
        taskId: task.taskId,
        verified: false,
        confidence: 'low',
        reason: errors.length > 0
          ? `Zoho verification failed: ${errors[0]}`
          : `Zoho record ${sourceId} was not readable after the write attempt.`,
      };
    }
    case 'outreach':
    case 'larkBase':
    case 'larkTask':
    case 'larkCalendar':
    case 'larkMeeting':
    case 'larkApproval':
    case 'workspace':
    case 'terminal':
      return {
        taskId: task.taskId,
        verified: false,
        confidence: 'unverifiable',
        reason: `No direct ${task.ownerAgent} verification adapter exists in the current runtime.`,
      };
    default:
      return {
        taskId: task.taskId,
        verified: false,
        confidence: 'unverifiable',
        reason: `Unsupported verification ownerAgent: ${task.ownerAgent}`,
      };
  }
}
