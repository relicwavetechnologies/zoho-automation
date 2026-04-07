import { tool } from 'ai';
import { z } from 'zod';

import type { ToolActionGroup } from '../../../../../tools/tool-action-groups';
import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';

type GoogleRuntimeHelpers = {
  buildEnvelope: (input: Record<string, unknown>) => any;
  withLifecycle: (
    hooks: VercelRuntimeToolHooks,
    toolName: string,
    title: string,
    run: () => Promise<any>,
  ) => Promise<any>;
  ensureActionPermission: (
    runtime: VercelRuntimeRequestContext,
    toolId: string,
    actionGroup: ToolActionGroup,
  ) => any;
  toCanonicalToolId: (toolId: string) => string;
  resolveGoogleAccess: (
    runtime: VercelRuntimeRequestContext,
    requiredScopes: string[],
  ) => Promise<{ accessToken: string } | { error: any }>;
  fetchGoogleApiJsonWithRetry: <T = Record<string, unknown>>(
    accessToken: string,
    url: string | URL,
  ) => Promise<{ payload: T }>;
  fetchGoogleApiResponseWithRetry: (
    accessToken: string,
    url: string | URL,
  ) => Promise<Response>;
  createPendingRemoteApproval: (input: Record<string, unknown>) => Promise<any>;
  normalizeEmailHeaderField: (value: unknown) => string | undefined;
  normalizeGmailMessage: (rawMessage: Record<string, unknown>) => Record<string, unknown>;
  loadOutboundArtifactService: () => {
    getArtifactForSend: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  loadEmailComposeService: () => {
    composeEmail: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  asArray: <T = unknown>(value: unknown) => T[];
  asRecord: (value: unknown) => Record<string, unknown> | null;
  asString: (value: unknown) => string | undefined;
};

export const buildGoogleRuntimeTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
  helpers: GoogleRuntimeHelpers,
): Record<string, any> => ({
  googleMail: tool({
    description:
      'Use the connected Google account to list, read, draft, and send Gmail messages. For outbound email, prefer giving purpose, audience, tone, templateFamily, facts, and a clear subject so the composer can generate a polished message.',
    inputSchema: z.discriminatedUnion('operation', [
      z.object({
        operation: z.literal('listMessages'),
        query: z.string().optional(),
        maxResults: z.number().int().min(1).max(50).optional(),
      }),
      z.object({
        operation: z.literal('searchMessages'),
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(50).optional(),
      }),
      z.object({
        operation: z.literal('getMessage'),
        messageId: z.string().min(1),
        format: z.enum(['metadata', 'full', 'minimal', 'raw']).optional(),
      }),
      z.object({
        operation: z.literal('getThread'),
        threadId: z.string().min(1),
        format: z.enum(['metadata', 'full', 'minimal', 'raw']).optional(),
      }),
      z.object({
        operation: z.literal('sendDraft'),
        draftId: z.string().min(1),
      }),
      z.object({
        operation: z.literal('createDraft'),
        to: z.union([z.string().min(1), z.array(z.string().email()).min(1)]),
        subject: z.string().optional().describe('Clear final subject line for the email. Prefer specific, action-oriented subjects.'),
        body: z.string().optional().describe('Optional raw draft body. Use this when the user provided exact wording to preserve.'),
        cc: z.union([z.string().min(1), z.array(z.string().email()).min(1)]).optional(),
        bcc: z.union([z.string().min(1), z.array(z.string().email()).min(1)]).optional(),
        isHtml: z.boolean().optional().describe('Set true when the email should be presentation-ready HTML instead of plain text.'),
        purpose: z.string().optional().describe('What the email is trying to accomplish. This is the best primary input for the email composer.'),
        audience: z.string().optional().describe('Who the email is for, used to personalize greeting and framing.'),
        tone: z.string().optional().describe('Desired tone such as professional, warm, concise, executive, or friendly.'),
        templateFamily: z.string().optional().describe('Optional style hint like invoice_followup, audit_delivery, proposal, reminder, or thank_you.'),
        facts: z.array(z.string()).optional().describe('Key facts, dates, amounts, names, and next steps that must appear in the email.'),
        preserveUserWording: z.boolean().optional(),
        attachments: z.array(z.object({ artifactId: z.string().min(1) })).optional(),
        threadId: z.string().optional(),
      }),
      z.object({
        operation: z.literal('sendMessage'),
        to: z.union([z.string().min(1), z.array(z.string().email()).min(1)]),
        subject: z.string().min(1),
        body: z.string().min(1),
        cc: z.union([z.string().min(1), z.array(z.string().email()).min(1)]).optional(),
        bcc: z.union([z.string().min(1), z.array(z.string().email()).min(1)]).optional(),
        isHtml: z.boolean().optional().describe('Set true when the email should be presentation-ready HTML instead of plain text.'),
        purpose: z.string().optional().describe('What the email is trying to accomplish. This is the best primary input for the email composer.'),
        audience: z.string().optional().describe('Who the email is for, used to personalize greeting and framing.'),
        tone: z.string().optional().describe('Desired tone such as professional, warm, concise, executive, or friendly.'),
        templateFamily: z.string().optional().describe('Optional style hint like invoice_followup, audit_delivery, proposal, reminder, or thank_you.'),
        facts: z.array(z.string()).optional().describe('Key facts, dates, amounts, names, and next steps that must appear in the email.'),
        preserveUserWording: z.boolean().optional(),
        attachments: z.array(z.object({ artifactId: z.string().min(1) })).optional(),
        threadId: z.string().optional(),
      }),
    ]),
    execute: async (input) =>
      helpers.withLifecycle(hooks, 'googleMail', 'Running Gmail workflow', async () => {
        const VALID_GMAIL_OPERATIONS = [
          'listMessages',
          'searchMessages',
          'getMessage',
          'getThread',
          'createDraft',
          'sendMessage',
          'sendDraft',
        ] as const;
        const operation = input?.operation;
        if (
          !operation
          || operation === 'gmail'
          || !VALID_GMAIL_OPERATIONS.includes(operation as (typeof VALID_GMAIL_OPERATIONS)[number])
        ) {
          return {
            success: false,
            status: 'error' as const,
            errorKind: 'unsupported',
            error: `Invalid Gmail operation "${operation ?? 'undefined'}". Valid operations: listMessages, searchMessages (requires: query), getMessage, getThread, createDraft, sendMessage, sendDraft (requires: draftId).`,
            retryable: false,
            data: null,
            confirmedAction: false,
          } as const;
        }
        const actionGroup: ToolActionGroup =
          input.operation === 'createDraft'
            ? 'create'
            : input.operation === 'sendMessage' || input.operation === 'sendDraft'
              ? 'send'
              : 'read';
        const permissionError = helpers.ensureActionPermission(
          runtime,
          helpers.toCanonicalToolId('google-gmail'),
          actionGroup,
        );
        if (permissionError) {
          return permissionError;
        }
        const requiresSend = input.operation === 'sendMessage';
        const requiresDraft =
          input.operation === 'createDraft' || input.operation === 'sendDraft';
        const requiredScopes = requiresSend
          ? ['https://www.googleapis.com/auth/gmail.send']
          : requiresDraft
            ? ['https://www.googleapis.com/auth/gmail.compose']
            : ['https://www.googleapis.com/auth/gmail.readonly'];

        const access = await helpers.resolveGoogleAccess(runtime, requiredScopes);
        if ('error' in access) {
          return access.error;
        }

        const baseUrl = 'https://gmail.googleapis.com/gmail/v1/users/me';
        const normalizedTo = helpers.normalizeEmailHeaderField((input as { to?: unknown }).to);
        const normalizedCc = helpers.normalizeEmailHeaderField((input as { cc?: unknown }).cc);
        const normalizedBcc = helpers.normalizeEmailHeaderField((input as { bcc?: unknown }).bcc);
        const buildGmailEnvelope = (envelope: Parameters<typeof helpers.buildEnvelope>[0]): any =>
          helpers.buildEnvelope({
            toolId: 'googleWorkspace',
            ...envelope,
          });

        if (input.operation === 'listMessages' || input.operation === 'searchMessages') {
          const url = new URL(`${baseUrl}/messages`);
          url.searchParams.set('maxResults', String(input.maxResults ?? 10));
          const query =
            input.operation === 'searchMessages'
              ? input.query.trim()
              : input.query?.trim() || 'in:inbox';
          url.searchParams.set('q', query);
          try {
            const { payload } = await helpers.fetchGoogleApiJsonWithRetry(access.accessToken, url);
            const items = helpers.asArray(payload.messages)
              .map((entry) => helpers.asRecord(entry))
              .filter(Boolean);
            const metadataHeaders = ['From', 'To', 'Subject', 'Date', 'In-Reply-To', 'References'];
            const normalizedMessages = await Promise.all(items.map(async (entry) => {
              const messageId = helpers.asString(entry.id);
              if (!messageId) {
                return helpers.normalizeGmailMessage(entry);
              }
              const detailUrl = new URL(`${baseUrl}/messages/${encodeURIComponent(messageId)}`);
              detailUrl.searchParams.set('format', 'metadata');
              metadataHeaders.forEach((header) => {
                detailUrl.searchParams.append('metadataHeaders', header);
              });
              try {
                const { payload: messagePayload } = await helpers.fetchGoogleApiJsonWithRetry(
                  access.accessToken,
                  detailUrl,
                );
                return helpers.normalizeGmailMessage(messagePayload);
              } catch {
                return helpers.normalizeGmailMessage(entry);
              }
            }));
            return buildGmailEnvelope({
              success: true,
              summary:
                input.operation === 'searchMessages'
                  ? `Found ${items.length} message(s) for "${query}".`
                  : `Found ${items.length} message(s).`,
              data: {
                count: items.length,
                messages: normalizedMessages,
              },
              keyData: {
                messages: normalizedMessages,
                resultCount: items.length,
              },
              fullPayload: {
                query,
                count: items.length,
                messages: normalizedMessages,
                resultSizeEstimate: payload.resultSizeEstimate ?? items.length,
              },
            });
          } catch (error) {
            const payload = ((error as any)?.payload ?? {}) as Record<string, unknown>;
            return buildGmailEnvelope({
              success: false,
              summary:
                input.operation === 'searchMessages'
                  ? `Gmail search failed: ${(payload as any)?.error?.message ?? (error as Error)?.message ?? 'request failed'}`
                  : `Gmail list failed: ${(payload as any)?.error?.message ?? (error as Error)?.message ?? 'request failed'}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: (error as any)?.status, payload },
            });
          }
        }

        if (input.operation === 'getMessage') {
          const messageId = input.messageId?.trim();
          if (!messageId) {
            return buildGmailEnvelope({
              success: false,
              summary: 'getMessage requires messageId.',
              errorKind: 'missing_input',
            });
          }
          const url = new URL(`${baseUrl}/messages/${messageId}`);
          url.searchParams.set('format', input.format ?? 'metadata');
          try {
            const { payload } = await helpers.fetchGoogleApiJsonWithRetry(access.accessToken, url);
            const normalizedMessage = helpers.normalizeGmailMessage(payload);
            const fromLabel = helpers.asString(normalizedMessage.from) ?? 'unknown sender';
            const subjectLabel = helpers.asString(normalizedMessage.subject) ?? 'No subject';
            return buildGmailEnvelope({
              success: true,
              summary: `Fetched message from ${fromLabel} — "${subjectLabel}".`,
              data: normalizedMessage,
              keyData: normalizedMessage,
              fullPayload: normalizedMessage,
            });
          } catch (error) {
            const payload = ((error as any)?.payload ?? {}) as Record<string, unknown>;
            return buildGmailEnvelope({
              success: false,
              summary: `Gmail getMessage failed: ${(payload as any)?.error?.message ?? (error as Error)?.message ?? 'request failed'}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: (error as any)?.status, payload },
            });
          }
        }

        if (input.operation === 'getThread') {
          const threadId = input.threadId?.trim();
          if (!threadId) {
            return buildGmailEnvelope({
              success: false,
              summary: 'getThread requires threadId.',
              errorKind: 'missing_input',
            });
          }
          const url = new URL(`${baseUrl}/threads/${threadId}`);
          url.searchParams.set('format', input.format ?? 'metadata');
          try {
            const { payload } = await helpers.fetchGoogleApiJsonWithRetry(access.accessToken, url);
            return buildGmailEnvelope({
              success: true,
              summary: `Fetched thread ${threadId}.`,
              keyData: {
                threadId,
                messages: helpers.asArray(payload.messages)
                  .map((entry) => helpers.asRecord(entry))
                  .filter((entry): entry is Record<string, unknown> => Boolean(entry))
                  .map((entry) => helpers.normalizeGmailMessage(entry)),
              },
              fullPayload: {
                threadId,
                messages: helpers.asArray(payload.messages)
                  .map((entry) => helpers.asRecord(entry))
                  .filter((entry): entry is Record<string, unknown> => Boolean(entry))
                  .map((entry) => helpers.normalizeGmailMessage(entry)),
              },
            });
          } catch (error) {
            const payload = ((error as any)?.payload ?? {}) as Record<string, unknown>;
            return buildGmailEnvelope({
              success: false,
              summary: `Gmail getThread failed: ${(payload as any)?.error?.message ?? (error as Error)?.message ?? 'request failed'}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: (error as any)?.status, payload },
            });
          }
        }

        if (input.operation === 'createDraft') {
          if (!normalizedTo || (!input.body && !(input.facts?.length) && !input.purpose && !input.subject)) {
            const missingFields = [
              !input.to ? 'to' : null,
              !input.body && !(input.facts?.length) && !input.purpose && !input.subject
                ? 'body_or_facts_or_purpose_or_subject'
                : null,
            ].filter((value): value is string => Boolean(value));
            return buildGmailEnvelope({
              success: false,
              summary: 'createDraft requires to plus enough content to compose the email.',
              errorKind: 'missing_input',
              missingFields,
              userAction: 'Please provide the recipient plus enough content to compose the email.',
            });
          }
          const attachmentEntries = input.attachments
            ? await Promise.all(
              input.attachments.map(async (attachment) => {
                const artifact = await helpers.loadOutboundArtifactService().getArtifactForSend({
                  artifactId: attachment.artifactId,
                  companyId: runtime.companyId,
                  requesterUserId: runtime.userId,
                  requesterAiRole: runtime.requesterAiRole,
                });
                return {
                  artifactId: helpers.asString(artifact.id) ?? attachment.artifactId,
                  fileName: helpers.asString(artifact.fileName) ?? 'attachment',
                  mimeType: helpers.asString(artifact.mimeType) ?? 'application/octet-stream',
                };
              }),
            )
            : [];
          const composed = await helpers.loadEmailComposeService().composeEmail({
            purpose: input.purpose ?? input.subject,
            audience: input.audience ?? normalizedTo,
            tone: input.tone,
            templateFamily: input.templateFamily,
            subject: input.subject,
            body: input.body,
            facts: input.facts,
            attachments: attachmentEntries.map((entry) => ({
              fileName: entry.fileName,
              mimeType: entry.mimeType,
            })),
            preserveUserWording: input.preserveUserWording,
            preferHtml: input.isHtml,
          });
          return helpers.createPendingRemoteApproval({
            runtime,
            toolId: 'googleWorkspace',
            actionGroup: 'create',
            operation: 'createDraft',
            canonicalOperation: {
              provider: 'google',
              product: 'gmail',
              operation: 'createDraft',
              actionGroup: 'create',
            },
            summary: `Approval required to create Gmail draft "${composed.subject}"${attachmentEntries.length > 0 ? ` with ${attachmentEntries.length} attachment(s)` : ''}.`,
            subject: composed.subject,
            explanation: `Create a draft to ${normalizedTo}.`,
            payload: {
              to: normalizedTo,
              subject: composed.subject,
              body: composed.body,
              cc: normalizedCc,
              bcc: normalizedBcc,
              isHtml: composed.isHtml,
              threadId: input.threadId,
              attachments: attachmentEntries.map((entry) => ({
                artifactId: entry.artifactId,
              })),
              composeMeta: {
                purpose: input.purpose,
                audience: input.audience,
                tone: input.tone,
                templateFamily: input.templateFamily,
                facts: input.facts,
                composedBy: composed.composedBy,
              },
            },
          });
        }

        if (input.operation === 'sendDraft') {
          const draftId = input.draftId?.trim();
          if (!draftId) {
            return buildGmailEnvelope({
              success: false,
              summary: 'sendDraft requires draftId.',
              errorKind: 'missing_input',
              missingFields: ['draftId'],
              userAction: 'Please provide the Gmail draftId to send.',
            });
          }
          return helpers.createPendingRemoteApproval({
            runtime,
            toolId: 'googleWorkspace',
            actionGroup: 'send',
            operation: 'sendDraft',
            canonicalOperation: {
              provider: 'google',
              product: 'gmail',
              operation: 'sendDraft',
              actionGroup: 'send',
            },
            summary: `Approval required to send Gmail draft ${draftId}.`,
            subject: draftId,
            explanation: 'Send the selected Gmail draft.',
            payload: { draftId },
          });
        }

        if (input.operation === 'sendMessage') {
          if (!normalizedTo || (!input.body && !(input.facts?.length) && !input.purpose && !input.subject)) {
            const missingFields = [
              !input.to ? 'to' : null,
              !input.body && !(input.facts?.length) && !input.purpose && !input.subject
                ? 'body_or_facts_or_purpose_or_subject'
                : null,
            ].filter((value): value is string => Boolean(value));
            return buildGmailEnvelope({
              success: false,
              summary: 'sendMessage requires to plus enough content to compose the email.',
              errorKind: 'missing_input',
              missingFields,
              userAction: 'Please provide the recipient plus enough content to compose the email.',
            });
          }
          const attachmentEntries = input.attachments
            ? await Promise.all(
              input.attachments.map(async (attachment) => {
                const artifact = await helpers.loadOutboundArtifactService().getArtifactForSend({
                  artifactId: attachment.artifactId,
                  companyId: runtime.companyId,
                  requesterUserId: runtime.userId,
                  requesterAiRole: runtime.requesterAiRole,
                });
                return {
                  artifactId: helpers.asString(artifact.id) ?? attachment.artifactId,
                  fileName: helpers.asString(artifact.fileName) ?? 'attachment',
                  mimeType: helpers.asString(artifact.mimeType) ?? 'application/octet-stream',
                };
              }),
            )
            : [];
          const composed = await helpers.loadEmailComposeService().composeEmail({
            purpose: input.purpose ?? input.subject,
            audience: input.audience ?? normalizedTo,
            tone: input.tone,
            templateFamily: input.templateFamily,
            subject: input.subject,
            body: input.body,
            facts: input.facts,
            attachments: attachmentEntries.map((entry) => ({
              fileName: entry.fileName,
              mimeType: entry.mimeType,
            })),
            preserveUserWording: input.preserveUserWording,
            preferHtml: input.isHtml,
          });
          return helpers.createPendingRemoteApproval({
            runtime,
            toolId: 'googleWorkspace',
            actionGroup: 'send',
            operation: 'sendMessage',
            canonicalOperation: {
              provider: 'google',
              product: 'gmail',
              operation: 'sendMessage',
              actionGroup: 'send',
            },
            summary: `Approval required to send Gmail message "${composed.subject}"${attachmentEntries.length > 0 ? ` with ${attachmentEntries.length} attachment(s)` : ''}.`,
            subject: composed.subject,
            explanation: `Send email to ${normalizedTo}.`,
            payload: {
              to: normalizedTo,
              subject: composed.subject,
              body: composed.body,
              cc: normalizedCc,
              bcc: normalizedBcc,
              isHtml: composed.isHtml,
              threadId: input.threadId,
              attachments: attachmentEntries.map((entry) => ({
                artifactId: entry.artifactId,
              })),
              composeMeta: {
                purpose: input.purpose,
                audience: input.audience,
                tone: input.tone,
                templateFamily: input.templateFamily,
                facts: input.facts,
                composedBy: composed.composedBy,
              },
            },
          });
        }

        return buildGmailEnvelope({
          success: false,
          summary: `Unsupported Gmail operation: ${input.operation}`,
          errorKind: 'unsupported',
          retryable: false,
        });
      }),
  }),

  googleDrive: tool({
    description:
      'Use the connected Google account to list, read, download, and upload Drive files. Do not use this as the first path for uploaded/company documents when the internal document tools can handle the request. If a desktop workspace is connected, ambiguous file and folder requests should go to the LOCAL workspace instead of Google Drive unless the user explicitly says "Drive" or otherwise names Google Drive.',
    inputSchema: z.object({
      operation: z.enum([
        'listFiles',
        'getFile',
        'downloadFile',
        'createFolder',
        'uploadFile',
        'updateFile',
        'deleteFile',
      ]),
      query: z.string().optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
      orderBy: z.string().optional(),
      fileId: z.string().optional(),
      fields: z.string().optional(),
      fileName: z.string().optional(),
      parentId: z.string().optional(),
      mimeType: z.string().optional(),
      contentBase64: z.string().optional(),
      contentText: z.string().optional(),
      maxBytes: z.number().int().min(1).max(5_000_000).optional(),
      preferLink: z.boolean().optional(),
    }),
    execute: async (input) =>
      helpers.withLifecycle(hooks, 'googleDrive', 'Running Google Drive workflow', async () => {
        const actionGroup: ToolActionGroup =
          input.operation === 'createFolder' || input.operation === 'uploadFile'
            ? 'create'
            : input.operation === 'updateFile'
              ? 'update'
              : input.operation === 'deleteFile'
                ? 'delete'
                : 'read';
        const permissionError = helpers.ensureActionPermission(
          runtime,
          helpers.toCanonicalToolId('google-drive'),
          actionGroup,
        );
        if (permissionError) {
          return permissionError;
        }
        const writeOps = actionGroup !== 'read';
        const requiredScopes = writeOps
          ? ['https://www.googleapis.com/auth/drive.file']
          : ['https://www.googleapis.com/auth/drive.readonly'];

        const access = await helpers.resolveGoogleAccess(runtime, requiredScopes);
        if ('error' in access) {
          return access.error;
        }

        const baseUrl = 'https://www.googleapis.com/drive/v3/files';
        const defaultFields =
          'files(id,name,mimeType,modifiedTime,webViewLink,webContentLink,size,owners(emailAddress,displayName))';

        if (input.operation === 'listFiles') {
          const url = new URL(baseUrl);
          url.searchParams.set('pageSize', String(input.pageSize ?? 20));
          url.searchParams.set('fields', input.fields ?? defaultFields);
          if (input.query) url.searchParams.set('q', input.query);
          if (input.orderBy) url.searchParams.set('orderBy', input.orderBy);
          try {
            const { payload } = await helpers.fetchGoogleApiJsonWithRetry(access.accessToken, url);
            const items = helpers.asArray(payload.files)
              .map((entry) => helpers.asRecord(entry))
              .filter(Boolean);
            return helpers.buildEnvelope({
              success: true,
              summary: `Found ${items.length} file(s).`,
              keyData: { items },
              fullPayload: payload,
            });
          } catch (error) {
            const payload = ((error as any)?.payload ?? {}) as Record<string, unknown>;
            return helpers.buildEnvelope({
              success: false,
              summary: `Drive list failed: ${(payload as any)?.error?.message ?? (error as Error)?.message ?? 'request failed'}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: (error as any)?.status, payload },
            });
          }
        }

        if (input.operation === 'getFile') {
          const fileId = input.fileId?.trim();
          if (!fileId) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'getFile requires fileId.',
              errorKind: 'missing_input',
            });
          }
          const url = new URL(`${baseUrl}/${fileId}`);
          url.searchParams.set(
            'fields',
            input.fields ??
              'id,name,mimeType,modifiedTime,webViewLink,webContentLink,size,owners(emailAddress,displayName)',
          );
          try {
            const { payload } = await helpers.fetchGoogleApiJsonWithRetry(access.accessToken, url);
            return helpers.buildEnvelope({
              success: true,
              summary: `Fetched file ${fileId}.`,
              keyData: { fileId },
              fullPayload: payload,
            });
          } catch (error) {
            const payload = ((error as any)?.payload ?? {}) as Record<string, unknown>;
            return helpers.buildEnvelope({
              success: false,
              summary: `Drive getFile failed: ${(payload as any)?.error?.message ?? (error as Error)?.message ?? 'request failed'}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: (error as any)?.status, payload },
            });
          }
        }

        if (input.operation === 'downloadFile') {
          const fileId = input.fileId?.trim();
          if (!fileId) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'downloadFile requires fileId.',
              errorKind: 'missing_input',
            });
          }
          if (input.preferLink) {
            const metaUrl = new URL(`${baseUrl}/${fileId}`);
            metaUrl.searchParams.set(
              'fields',
              'id,name,webContentLink,webViewLink,mimeType,size',
            );
            try {
              const { payload: metaPayload } = await helpers.fetchGoogleApiJsonWithRetry(access.accessToken, metaUrl);
              return helpers.buildEnvelope({
                success: true,
                summary: 'Generated Drive download link.',
                keyData: {
                  fileId,
                  name: helpers.asString(metaPayload.name),
                  webContentLink: helpers.asString(metaPayload.webContentLink),
                  webViewLink: helpers.asString(metaPayload.webViewLink),
                },
                fullPayload: metaPayload,
              });
            } catch (error) {
              const metaPayload = ((error as any)?.payload ?? {}) as Record<string, unknown>;
              return helpers.buildEnvelope({
                success: false,
                summary: `Drive metadata failed: ${(metaPayload as any)?.error?.message ?? (error as Error)?.message ?? 'request failed'}`,
                errorKind: 'api_failure',
                retryable: true,
                fullPayload: { status: (error as any)?.status, payload: metaPayload },
              });
            }
          }

          const url = new URL(`${baseUrl}/${fileId}`);
          url.searchParams.set('alt', 'media');
          try {
            const response = await helpers.fetchGoogleApiResponseWithRetry(access.accessToken, url);
            const buffer = Buffer.from(await response.arrayBuffer());
            const maxBytes = input.maxBytes ?? 2_000_000;
            if (buffer.length > maxBytes) {
              return helpers.buildEnvelope({
                success: false,
                summary: `Drive file is too large (${buffer.length} bytes).`,
                errorKind: 'validation',
                retryable: false,
                userAction: `Reduce size or increase maxBytes (<= 5,000,000).`,
              });
            }
            return helpers.buildEnvelope({
              success: true,
              summary: `Downloaded file ${fileId} (${buffer.length} bytes).`,
              keyData: { fileId, size: buffer.length },
              fullPayload: { fileId, base64: buffer.toString('base64') },
            });
          } catch (error) {
            const payload = ((error as any)?.payload ?? {}) as Record<string, unknown>;
            return helpers.buildEnvelope({
              success: false,
              summary: `Drive download failed: ${(payload as any)?.error?.message ?? (error as Error)?.message ?? 'request failed'}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: (error as any)?.status, payload },
            });
          }
        }

        if (input.operation === 'createFolder') {
          const name = input.fileName?.trim();
          if (!name) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'createFolder requires fileName.',
              errorKind: 'missing_input',
            });
          }
          return helpers.createPendingRemoteApproval({
            runtime,
            toolId: 'google-drive',
            actionGroup: 'create',
            operation: 'createFolder',
            summary: `Approval required to create Drive folder "${name}".`,
            subject: name,
            explanation: 'Create a Google Drive folder.',
            payload: {
              fileName: name,
              parentId: input.parentId,
            },
          });
        }

        if (input.operation === 'uploadFile') {
          const name = input.fileName?.trim();
          if (!name) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'uploadFile requires fileName.',
              errorKind: 'missing_input',
            });
          }
          const content = input.contentBase64
            ? input.contentBase64
            : typeof input.contentText === 'string'
              ? Buffer.from(input.contentText, 'utf8').toString('base64')
              : undefined;
          if (!content) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'uploadFile requires contentBase64 or contentText.',
              errorKind: 'missing_input',
            });
          }
          return helpers.createPendingRemoteApproval({
            runtime,
            toolId: 'google-drive',
            actionGroup: 'create',
            operation: 'uploadFile',
            summary: `Approval required to upload Drive file "${name}".`,
            subject: name,
            explanation: 'Upload a file to Google Drive.',
            payload: {
              fileName: name,
              parentId: input.parentId,
              mimeType: input.mimeType ?? 'application/octet-stream',
              contentBase64: content,
            },
          });
        }

        if (input.operation === 'updateFile') {
          const fileId = input.fileId?.trim();
          if (!fileId) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'updateFile requires fileId.',
              errorKind: 'missing_input',
            });
          }
          const hasContent = Boolean(input.contentBase64 || input.contentText);
          const hasName = Boolean(input.fileName?.trim());
          if (!hasContent && !hasName) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'updateFile requires contentBase64/contentText or fileName.',
              errorKind: 'missing_input',
            });
          }
          const content = input.contentBase64
            ? input.contentBase64
            : typeof input.contentText === 'string'
              ? Buffer.from(input.contentText, 'utf8').toString('base64')
              : undefined;
          return helpers.createPendingRemoteApproval({
            runtime,
            toolId: 'google-drive',
            actionGroup: 'update',
            operation: 'updateFile',
            summary: `Approval required to update Drive file ${fileId}.`,
            subject: input.fileName?.trim() ?? fileId,
            explanation: 'Update a Google Drive file name or contents.',
            payload: {
              fileId,
              fileName: input.fileName?.trim(),
              mimeType: input.mimeType,
              parentId: input.parentId,
              ...(content ? { contentBase64: content } : {}),
            },
          });
        }

        if (input.operation === 'deleteFile') {
          const fileId = input.fileId?.trim();
          if (!fileId) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'deleteFile requires fileId.',
              errorKind: 'missing_input',
            });
          }
          return helpers.createPendingRemoteApproval({
            runtime,
            toolId: 'google-drive',
            actionGroup: 'delete',
            operation: 'deleteFile',
            summary: `Approval required to delete Drive file ${fileId}.`,
            subject: fileId,
            explanation: 'Delete a Google Drive file.',
            payload: { fileId },
          });
        }

        return helpers.buildEnvelope({
          success: false,
          summary: `Unsupported Drive operation: ${input.operation}`,
          errorKind: 'unsupported',
          retryable: false,
        });
      }),
  }),

  googleCalendar: tool({
    description:
      'Use the connected Google account to list, read, create, update, and delete Google Calendar events.',
    inputSchema: z.object({
      operation: z.enum([
        'listCalendars',
        'listEvents',
        'getEvent',
        'createEvent',
        'updateEvent',
        'deleteEvent',
      ]),
      calendarId: z.string().optional(),
      eventId: z.string().optional(),
      query: z.string().optional(),
      timeMin: z.string().optional(),
      timeMax: z.string().optional(),
      summary: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
      attendees: z.array(z.string()).optional(),
    }),
    execute: async (input) =>
      helpers.withLifecycle(hooks, 'googleCalendar', 'Running Google Calendar workflow', async () => {
        const actionGroup: ToolActionGroup =
          input.operation === 'createEvent'
            ? 'create'
            : input.operation === 'updateEvent'
              ? 'update'
              : input.operation === 'deleteEvent'
                ? 'delete'
                : 'read';
        const permissionError = helpers.ensureActionPermission(
          runtime,
          helpers.toCanonicalToolId('google-calendar'),
          actionGroup,
        );
        if (permissionError) {
          return permissionError;
        }

        const access = await helpers.resolveGoogleAccess(
          runtime,
          actionGroup === 'read'
            ? ['https://www.googleapis.com/auth/calendar.readonly']
            : ['https://www.googleapis.com/auth/calendar.events'],
        );
        if ('error' in access) {
          return access.error;
        }

        const calendarId = encodeURIComponent(input.calendarId?.trim() || 'primary');

        if (input.operation === 'listCalendars') {
          try {
            const { payload } = await helpers.fetchGoogleApiJsonWithRetry(
              access.accessToken,
              'https://www.googleapis.com/calendar/v3/users/me/calendarList',
            );
            const items = helpers.asArray(payload.items)
              .map((entry) => helpers.asRecord(entry))
              .filter(Boolean);
            return helpers.buildEnvelope({
              success: true,
              summary: `Found ${items.length} Google calendar(s).`,
              keyData: { calendars: items },
              fullPayload: payload,
            });
          } catch (error) {
            const payload = ((error as any)?.payload ?? {}) as Record<string, unknown>;
            return helpers.buildEnvelope({
              success: false,
              summary: `Google Calendar list failed: ${(payload as any)?.error?.message ?? (error as Error)?.message ?? 'request failed'}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: (error as any)?.status, payload },
            });
          }
        }

        if (input.operation === 'listEvents') {
          const url = new URL(
            `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
          );
          if (input.query?.trim()) url.searchParams.set('q', input.query.trim());
          if (input.timeMin?.trim()) url.searchParams.set('timeMin', input.timeMin.trim());
          if (input.timeMax?.trim()) url.searchParams.set('timeMax', input.timeMax.trim());
          url.searchParams.set('singleEvents', 'true');
          url.searchParams.set('maxResults', '50');
          url.searchParams.set('orderBy', 'startTime');
          try {
            const { payload } = await helpers.fetchGoogleApiJsonWithRetry(access.accessToken, url);
            const items = helpers.asArray(payload.items)
              .map((entry) => helpers.asRecord(entry))
              .filter(Boolean);
            return helpers.buildEnvelope({
              success: true,
              summary: `Found ${items.length} Google Calendar event(s).`,
              keyData: { events: items },
              fullPayload: payload,
            });
          } catch (error) {
            const payload = ((error as any)?.payload ?? {}) as Record<string, unknown>;
            return helpers.buildEnvelope({
              success: false,
              summary: `Google Calendar event list failed: ${(payload as any)?.error?.message ?? (error as Error)?.message ?? 'request failed'}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: (error as any)?.status, payload },
            });
          }
        }

        if (input.operation === 'getEvent') {
          const eventId = input.eventId?.trim();
          if (!eventId) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'getEvent requires eventId.',
              errorKind: 'missing_input',
            });
          }
          try {
            const { payload } = await helpers.fetchGoogleApiJsonWithRetry(
              access.accessToken,
              `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`,
            );
            return helpers.buildEnvelope({
              success: true,
              summary: `Fetched Google Calendar event ${eventId}.`,
              keyData: { event: payload },
              fullPayload: payload,
            });
          } catch (error) {
            const payload = ((error as any)?.payload ?? {}) as Record<string, unknown>;
            return helpers.buildEnvelope({
              success: false,
              summary: `Google Calendar getEvent failed: ${(payload as any)?.error?.message ?? (error as Error)?.message ?? 'request failed'}`,
              errorKind: 'api_failure',
              retryable: true,
              fullPayload: { status: (error as any)?.status, payload },
            });
          }
        }

        if (input.operation === 'createEvent') {
          if (!input.summary?.trim() || !input.startTime?.trim() || !input.endTime?.trim()) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'createEvent requires summary, startTime, and endTime.',
              errorKind: 'missing_input',
            });
          }
          return helpers.createPendingRemoteApproval({
            runtime,
            toolId: 'google-calendar',
            actionGroup: 'create',
            operation: 'createEvent',
            summary: `Approval required to create Google Calendar event "${input.summary.trim()}".`,
            subject: input.summary.trim(),
            explanation: 'Create a Google Calendar event.',
            payload: {
              calendarId: input.calendarId?.trim() || 'primary',
              body: {
                summary: input.summary.trim(),
                ...(input.description?.trim() ? { description: input.description.trim() } : {}),
                ...(input.location?.trim() ? { location: input.location.trim() } : {}),
                start: { dateTime: input.startTime.trim() },
                end: { dateTime: input.endTime.trim() },
                ...(input.attendees?.length
                  ? { attendees: input.attendees.map((email) => ({ email })) }
                  : {}),
              },
            },
          });
        }

        if (input.operation === 'updateEvent') {
          const eventId = input.eventId?.trim();
          if (!eventId) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'updateEvent requires eventId.',
              errorKind: 'missing_input',
            });
          }
          const body: Record<string, unknown> = {
            ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
            ...(input.description?.trim() ? { description: input.description.trim() } : {}),
            ...(input.location?.trim() ? { location: input.location.trim() } : {}),
            ...(input.startTime?.trim() ? { start: { dateTime: input.startTime.trim() } } : {}),
            ...(input.endTime?.trim() ? { end: { dateTime: input.endTime.trim() } } : {}),
            ...(input.attendees?.length
              ? { attendees: input.attendees.map((email) => ({ email })) }
              : {}),
          };
          if (Object.keys(body).length === 0) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'updateEvent requires at least one field to change.',
              errorKind: 'missing_input',
            });
          }
          return helpers.createPendingRemoteApproval({
            runtime,
            toolId: 'google-calendar',
            actionGroup: 'update',
            operation: 'updateEvent',
            summary: `Approval required to update Google Calendar event ${eventId}.`,
            subject: input.summary?.trim() ?? eventId,
            explanation: 'Update a Google Calendar event.',
            payload: {
              calendarId: input.calendarId?.trim() || 'primary',
              eventId,
              body,
            },
          });
        }

        if (input.operation === 'deleteEvent') {
          const eventId = input.eventId?.trim();
          if (!eventId) {
            return helpers.buildEnvelope({
              success: false,
              summary: 'deleteEvent requires eventId.',
              errorKind: 'missing_input',
            });
          }
          return helpers.createPendingRemoteApproval({
            runtime,
            toolId: 'google-calendar',
            actionGroup: 'delete',
            operation: 'deleteEvent',
            summary: `Approval required to delete Google Calendar event ${eventId}.`,
            subject: eventId,
            explanation: 'Delete a Google Calendar event.',
            payload: {
              calendarId: input.calendarId?.trim() || 'primary',
              eventId,
            },
          });
        }

        return helpers.buildEnvelope({
          success: false,
          summary: `Unsupported Google Calendar operation: ${input.operation}`,
          errorKind: 'unsupported',
          retryable: false,
        });
      }),
  }),
});
