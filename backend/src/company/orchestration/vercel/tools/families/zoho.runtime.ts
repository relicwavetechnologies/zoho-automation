import { tool } from 'ai';
import { z } from 'zod';

import type { ToolActionGroup } from '../../../../tools/tool-action-groups';
import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks } from '../../types';

export const buildZohoCrmRuntimeTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
  helpers: Record<string, any>,
): Record<string, any> => {
  const {
    withLifecycle,
    buildEnvelope,
    ensureAnyActionPermission,
    toCanonicalToolId,
    normalizeZohoSourceType,
    normalizeZohoCrmModuleName,
    loadZohoGatewayService,
    buildZohoGatewayRequester,
    asRecord,
    asArray,
    asString,
    buildZohoGatewayDeniedEnvelope,
    inferErrorKind,
    loadZohoDataClient,
    asNumber,
    loadCompanyContextResolver,
    buildCrmMutationAuthorizationTarget,
    createPendingRemoteApproval,
    loadZohoReadAgent,
    buildAgentInvokeInput,
    toEnvelopeFromAgentResult,
  } = helpers;

  const tools = {
    zoho: tool({
      description:
        'Comprehensive Zoho CRM tool for context search, grounded reads, field metadata, attachment content reads, and approval-gated mutations.',
      inputSchema: z.object({
        operation: z.enum([
          'searchContext',
          'readRecords',
          'summarizePipeline',
          'getRecord',
          'listNotes',
          'getNote',
          'listAttachments',
          'getAttachmentContent',
          'listFields',
          'createRecord',
          'updateRecord',
          'deleteRecord',
          'createNote',
          'updateNote',
          'deleteNote',
          'uploadAttachment',
          'deleteAttachment',
        ]),
        query: z.string().optional(),
        module: z.string().optional(),
        recordId: z.string().optional(),
        noteId: z.string().optional(),
        attachmentId: z.string().optional(),
        filters: z.record(z.unknown()).optional(),
        fields: z.record(z.unknown()).optional(),
        trigger: z.array(z.string()).optional(),
        fileName: z.string().optional(),
        contentType: z.string().optional(),
        contentBase64: z.string().optional(),
        attachmentUrl: z.string().optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'zoho', 'Running Zoho workflow', async () => {
          const readPermissionError = ensureAnyActionPermission(
            runtime,
            [toCanonicalToolId('search-zoho-context')],
            'read',
            'zoho',
          );
          const sourceType = normalizeZohoSourceType(input.module);
          const crmModuleName = normalizeZohoCrmModuleName(input.module);

          if (input.operation === 'searchContext') {
            if (readPermissionError) {
              return readPermissionError;
            }
            if (!input.query?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'searchContext requires query.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const zohoGateway = loadZohoGatewayService();
              const requester = buildZohoGatewayRequester(runtime);
              const modules = crmModuleName
                ? [crmModuleName]
                : ['Leads', 'Contacts', 'Accounts', 'Deals', 'Cases'];
              const normalizedMatches: Array<{
                type?: string;
                id?: string;
                score?: number;
                data: Record<string, unknown>;
              }> = [];
              let denialReason: string | undefined;

              for (const moduleName of modules) {
                const auth =
                  asRecord(
                    await zohoGateway.listAuthorizedRecords({
                      domain: 'crm',
                      module: moduleName,
                      requester,
                      filters: input.filters,
                      query: input.query.trim(),
                      limit: 5,
                    }),
                  ) ?? {};
                if (auth.allowed !== true) {
                  denialReason = asString(auth.denialReason) ?? denialReason;
                  continue;
                }
                const records = asArray(asRecord(auth.payload)?.records)
                  .map((entry) => asRecord(entry))
                  .filter((entry): entry is Record<string, unknown> => Boolean(entry));
                for (const record of records) {
                  normalizedMatches.push({
                    type: moduleName,
                    id: asString(record.id),
                    data: record,
                  });
                  if (normalizedMatches.length >= 5) {
                    break;
                  }
                }
                if (normalizedMatches.length >= 5) {
                  break;
                }
              }
              if (normalizedMatches.length === 0 && denialReason) {
                return buildZohoGatewayDeniedEnvelope(
                  { denialReason },
                  'You are not allowed to search Zoho CRM records.',
                );
              }
              const citations = normalizedMatches.flatMap((entry, index) => {
                const sourceType = entry.type;
                const sourceId = entry.id;
                if (!sourceType || !sourceId) return [];
                return [
                  {
                    id: `zoho-${index + 1}`,
                    title: `${sourceType}:${sourceId}`,
                    kind: 'record',
                    sourceType,
                    sourceId,
                  },
                ];
              });
              return buildEnvelope({
                success: true,
                summary:
                  normalizedMatches.length > 0
                    ? `Found ${normalizedMatches.length} relevant Zoho record(s).`
                    : 'No Zoho records matched the context search.',
                keyData: {
                  recordId: normalizedMatches[0]?.id,
                  recordType: normalizedMatches[0]?.type ?? input.module,
                },
                fullPayload: {
                  records: normalizedMatches,
                },
                citations,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Zoho context search failed.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getRecord') {
            if (readPermissionError) {
              return readPermissionError;
            }
            if (!crmModuleName || !input.recordId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getRecord requires module and recordId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await loadZohoGatewayService().getAuthorizedRecord({
                    domain: 'crm',
                    module: crmModuleName,
                    recordId: input.recordId.trim(),
                    requester: buildZohoGatewayRequester(runtime),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  `You are not allowed to access Zoho ${crmModuleName} ${input.recordId.trim()}.`,
                );
              }
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho ${input.module?.trim() ?? 'record'} ${input.recordId.trim()}.`,
                keyData: {
                  recordId: input.recordId.trim(),
                  recordType: sourceType ?? crmModuleName,
                },
                fullPayload: {
                  record: asRecord(auth.payload) ?? {},
                },
                citations: [
                  {
                    id: `zoho-record-${input.recordId.trim()}`,
                    title: `${sourceType ?? crmModuleName}:${input.recordId.trim()}`,
                    kind: 'record',
                    sourceType: sourceType ?? crmModuleName,
                    sourceId: input.recordId.trim(),
                  },
                ],
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho record.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'listNotes') {
            if (readPermissionError) {
              return readPermissionError;
            }
            if (!crmModuleName || !input.recordId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'listNotes requires module and recordId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await loadZohoGatewayService().getAuthorizedChildResource({
                    domain: 'crm',
                    module: crmModuleName,
                    recordId: input.recordId.trim(),
                    childType: 'notes',
                    requester: buildZohoGatewayRequester(runtime),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  `You are not allowed to access notes for ${crmModuleName} ${input.recordId.trim()}.`,
                );
              }
              const notes = sourceType
                ? ((await loadZohoDataClient().listNotes?.({
                    companyId: runtime.companyId,
                    sourceType,
                    sourceId: input.recordId.trim(),
                  })) ?? [])
                : await loadZohoDataClient().listModuleNotes({
                    companyId: runtime.companyId,
                    moduleName: crmModuleName,
                    recordId: input.recordId.trim(),
                  });
              return buildEnvelope({
                success: true,
                summary:
                  notes.length > 0
                    ? `Found ${notes.length} Zoho note(s) for ${input.module?.trim() ?? sourceType} ${input.recordId.trim()}.`
                    : `No Zoho notes were found for ${input.module?.trim() ?? sourceType} ${input.recordId.trim()}.`,
                keyData: {
                  recordId: input.recordId.trim(),
                  noteCount: notes.length,
                  recordType: sourceType ?? crmModuleName,
                },
                fullPayload: {
                  notes,
                },
              });
            } catch (error) {
              const summary = error instanceof Error ? error.message : 'Failed to list Zoho notes.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getNote') {
            if (readPermissionError) {
              return readPermissionError;
            }
            if (!input.noteId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getNote requires noteId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyId = await loadCompanyContextResolver().resolveCompanyId({
              companyId: runtime.companyId,
              larkTenantKey: runtime.larkTenantKey,
            });
            if (runtime.departmentZohoReadScope !== 'show_all') {
              return buildEnvelope({
                success: false,
                summary: 'getNote requires company-scoped Zoho CRM access.',
                errorKind: 'permission',
                retryable: false,
              });
            }
            try {
              const note = await loadZohoDataClient().getNote?.({
                companyId: runtime.companyId,
                noteId: input.noteId.trim(),
              });
              if (!note) {
                return buildEnvelope({
                  success: false,
                  summary: `No Zoho note was found for ${input.noteId.trim()}.`,
                  errorKind: 'validation',
                  retryable: false,
                });
              }
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho note ${input.noteId.trim()}.`,
                keyData: {
                  noteId: input.noteId.trim(),
                },
                fullPayload: {
                  note,
                },
              });
            } catch (error) {
              const summary = error instanceof Error ? error.message : 'Failed to fetch Zoho note.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'listAttachments') {
            if (readPermissionError) {
              return readPermissionError;
            }
            if (!crmModuleName || !input.recordId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'listAttachments requires module and recordId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await loadZohoGatewayService().getAuthorizedChildResource({
                    domain: 'crm',
                    module: crmModuleName,
                    recordId: input.recordId.trim(),
                    childType: 'attachments',
                    requester: buildZohoGatewayRequester(runtime),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  `You are not allowed to access attachments for ${crmModuleName} ${input.recordId.trim()}.`,
                );
              }
              const attachments = sourceType
                ? ((await loadZohoDataClient().listAttachments?.({
                    companyId: runtime.companyId,
                    sourceType,
                    sourceId: input.recordId.trim(),
                  })) ?? [])
                : await loadZohoDataClient().listModuleAttachments({
                    companyId: runtime.companyId,
                    moduleName: crmModuleName,
                    recordId: input.recordId.trim(),
                  });
              return buildEnvelope({
                success: true,
                summary:
                  attachments.length > 0
                    ? `Found ${attachments.length} Zoho attachment(s) for ${input.module?.trim() ?? sourceType} ${input.recordId.trim()}.`
                    : `No Zoho attachments were found for ${input.module?.trim() ?? sourceType} ${input.recordId.trim()}.`,
                keyData: {
                  recordId: input.recordId.trim(),
                  attachmentCount: attachments.length,
                  recordType: sourceType ?? crmModuleName,
                },
                fullPayload: {
                  attachments,
                },
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to list Zoho attachments.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getAttachmentContent') {
            if (readPermissionError) {
              return readPermissionError;
            }
            if (!crmModuleName || !input.recordId?.trim() || !input.attachmentId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getAttachmentContent requires module, recordId, and attachmentId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await loadZohoGatewayService().getAuthorizedChildResource({
                    domain: 'crm',
                    module: crmModuleName,
                    recordId: input.recordId.trim(),
                    childType: 'attachment_content',
                    requester: buildZohoGatewayRequester(runtime),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  `You are not allowed to access attachment content for ${crmModuleName} ${input.recordId.trim()}.`,
                );
              }
              const attachment = sourceType
                ? ((await loadZohoDataClient().getAttachmentContent?.({
                    companyId: runtime.companyId,
                    sourceType,
                    sourceId: input.recordId.trim(),
                    attachmentId: input.attachmentId.trim(),
                  })) ?? {})
                : ((await loadZohoDataClient().getModuleAttachmentContent?.({
                    companyId: runtime.companyId,
                    moduleName: crmModuleName,
                    recordId: input.recordId.trim(),
                    attachmentId: input.attachmentId.trim(),
                  })) ?? {});
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho attachment content ${input.attachmentId.trim()} for ${input.module?.trim() ?? sourceType} ${input.recordId.trim()}.`,
                keyData: {
                  recordId: input.recordId.trim(),
                  attachmentId: input.attachmentId.trim(),
                  recordType: sourceType ?? crmModuleName,
                  sizeBytes: asNumber(asRecord(attachment)?.sizeBytes),
                  contentType: asString(asRecord(attachment)?.contentType),
                },
                fullPayload: attachment,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho attachment content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'listFields') {
            if (readPermissionError) {
              return readPermissionError;
            }
            if (!crmModuleName) {
              return buildEnvelope({
                success: false,
                summary: 'listFields requires a supported Zoho CRM module.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const fields =
                (await loadZohoDataClient().listModuleFields?.({
                  companyId: runtime.companyId,
                  moduleName: crmModuleName,
                })) ?? [];
              return buildEnvelope({
                success: true,
                summary:
                  fields.length > 0
                    ? `Fetched ${fields.length} Zoho field definition(s) for ${crmModuleName}.`
                    : `No Zoho field definitions were returned for ${crmModuleName}.`,
                keyData: {
                  module: crmModuleName,
                  fieldCount: fields.length,
                },
                fullPayload: {
                  module: crmModuleName,
                  fields,
                },
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho field metadata.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'readRecords' || input.operation === 'summarizePipeline') {
            if (readPermissionError) {
              return readPermissionError;
            }
            if (!crmModuleName) {
              return buildEnvelope({
                success: false,
                summary: 'readRecords requires a supported Zoho CRM module.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await loadZohoGatewayService().listAuthorizedRecords({
                    domain: 'crm',
                    module: crmModuleName,
                    requester: buildZohoGatewayRequester(runtime),
                    filters: input.filters,
                    query: input.query?.trim(),
                    limit: 50,
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  `You are not allowed to read Zoho ${crmModuleName}.`,
                );
              }
              const filtered = asArray(asRecord(auth.payload)?.records)
                .map((entry) => asRecord(entry))
                .filter((entry): entry is Record<string, unknown> => Boolean(entry));
              if (input.operation === 'summarizePipeline') {
                const statusCounts = filtered.reduce<Record<string, number>>((acc, record) => {
                  const status =
                    asString(record.Stage) ??
                    asString(record.stage) ??
                    asString(record.Status) ??
                    asString(record.status) ??
                    'unknown';
                  acc[status] = (acc[status] ?? 0) + 1;
                  return acc;
                }, {});
                return buildEnvelope({
                  success: true,
                  summary:
                    filtered.length > 0
                      ? `Summarized ${filtered.length} Zoho ${crmModuleName} record(s).`
                      : `No Zoho ${crmModuleName} records matched the current filters.`,
                  keyData: {
                    module: crmModuleName,
                    recordCount: filtered.length,
                    statusCounts,
                  },
                  fullPayload: {
                    module: crmModuleName,
                    statusCounts,
                    records: filtered,
                  },
                });
              }
              return buildEnvelope({
                success: true,
                summary:
                  filtered.length > 0
                    ? `Found ${filtered.length} Zoho ${crmModuleName} record(s).`
                    : `No Zoho ${crmModuleName} records matched the current filters.`,
                keyData: {
                  module: crmModuleName,
                  recordCount: filtered.length,
                },
                fullPayload: {
                  module: crmModuleName,
                  records: filtered,
                },
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : `Failed to read Zoho ${crmModuleName} records.`;
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (
            input.operation === 'createRecord' ||
            input.operation === 'updateRecord' ||
            input.operation === 'deleteRecord' ||
            input.operation === 'createNote' ||
            input.operation === 'updateNote' ||
            input.operation === 'deleteNote' ||
            input.operation === 'uploadAttachment' ||
            input.operation === 'deleteAttachment'
          ) {
            const actionGroup: ToolActionGroup =
              input.operation === 'createRecord' ||
              input.operation === 'createNote' ||
              input.operation === 'uploadAttachment'
                ? 'create'
                : input.operation === 'updateRecord' || input.operation === 'updateNote'
                  ? 'update'
                  : 'delete';
            const permissionError = ensureAnyActionPermission(
              runtime,
              [toCanonicalToolId('zoho-write')],
              actionGroup,
              'zoho',
            );
            if (permissionError) {
              return permissionError;
            }
            if (
              (input.operation === 'createRecord' ||
                input.operation === 'updateRecord' ||
                input.operation === 'deleteRecord' ||
                input.operation === 'createNote' ||
                input.operation === 'uploadAttachment' ||
                input.operation === 'deleteAttachment') &&
              !crmModuleName
            ) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires a supported Zoho CRM module such as Leads, Contacts, Accounts, Deals, Cases, Tasks, Events, Calls, Products, Quotes, or Sales_Orders.`,
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (
              (input.operation === 'updateRecord' ||
                input.operation === 'deleteRecord' ||
                input.operation === 'createNote' ||
                input.operation === 'uploadAttachment' ||
                input.operation === 'deleteAttachment') &&
              !input.recordId?.trim()
            ) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires recordId.`,
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (
              (input.operation === 'createRecord' ||
                input.operation === 'updateRecord' ||
                input.operation === 'createNote' ||
                input.operation === 'updateNote') &&
              !input.fields
            ) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires fields.`,
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (
              (input.operation === 'updateNote' || input.operation === 'deleteNote') &&
              !input.noteId?.trim()
            ) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires noteId.`,
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (input.operation === 'deleteAttachment' && !input.attachmentId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'deleteAttachment requires attachmentId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            if (
              input.operation === 'uploadAttachment' &&
              !input.attachmentUrl?.trim() &&
              (!input.fileName?.trim() || !input.contentBase64?.trim())
            ) {
              return buildEnvelope({
                success: false,
                summary:
                  'uploadAttachment requires either attachmentUrl or both fileName and contentBase64.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const crmMutationAuth =
              asRecord(
                await loadZohoGatewayService().executeAuthorizedMutation({
                  ...buildCrmMutationAuthorizationTarget({
                    operation: input.operation,
                    moduleName: crmModuleName,
                    recordId: input.recordId?.trim(),
                  }),
                  requester: buildZohoGatewayRequester(runtime),
                }),
              ) ?? {};
            if (crmMutationAuth.allowed !== true) {
              return buildZohoGatewayDeniedEnvelope(
                crmMutationAuth,
                `You are not allowed to mutate Zoho ${crmModuleName ?? input.module?.trim() ?? input.operation}.`,
              );
            }
            const subject =
              input.operation === 'createRecord'
                ? `Create Zoho ${input.module?.trim() ?? sourceType}`
                : input.operation === 'updateRecord'
                  ? `Update Zoho ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}`.trim()
                  : input.operation === 'deleteRecord'
                    ? `Delete Zoho ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}`.trim()
                    : input.operation === 'createNote'
                      ? `Create Zoho note on ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}`.trim()
                      : input.operation === 'updateNote'
                        ? `Update Zoho note ${input.noteId?.trim() ?? ''}`.trim()
                        : input.operation === 'deleteNote'
                          ? `Delete Zoho note ${input.noteId?.trim() ?? ''}`.trim()
                          : input.operation === 'uploadAttachment'
                            ? `Upload Zoho attachment to ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}`.trim()
                            : `Delete Zoho attachment ${input.attachmentId?.trim() ?? ''}`.trim();
            const summary =
              input.operation === 'createRecord'
                ? `Approval required to create a Zoho ${input.module?.trim() ?? sourceType}.`
                : input.operation === 'updateRecord'
                  ? `Approval required to update Zoho ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}.`.trim()
                  : input.operation === 'deleteRecord'
                    ? `Approval required to delete Zoho ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}.`.trim()
                    : input.operation === 'createNote'
                      ? `Approval required to create a Zoho note on ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}.`.trim()
                      : input.operation === 'updateNote'
                        ? `Approval required to update Zoho note ${input.noteId?.trim() ?? ''}.`.trim()
                        : input.operation === 'deleteNote'
                          ? `Approval required to delete Zoho note ${input.noteId?.trim() ?? ''}.`.trim()
                          : input.operation === 'uploadAttachment'
                            ? `Approval required to upload an attachment to Zoho ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}.`.trim()
                            : `Approval required to delete Zoho attachment ${input.attachmentId?.trim() ?? ''} from ${input.module?.trim() ?? sourceType} ${input.recordId?.trim() ?? ''}.`.trim();
            return createPendingRemoteApproval({
              runtime,
              toolId: 'zoho-write',
              actionGroup,
              operation: input.operation,
              summary,
              subject,
              explanation:
                'Zoho CRM mutations are approval-gated. Review the module, record target, and field payload before proceeding.',
              payload: {
                operation: input.operation,
                module: input.module?.trim(),
                sourceType,
                recordId: input.recordId?.trim(),
                noteId: input.noteId?.trim(),
                attachmentId: input.attachmentId?.trim(),
                fields: input.fields,
                trigger: input.trigger,
                fileName: input.fileName?.trim(),
                contentType: input.contentType?.trim(),
                contentBase64: input.contentBase64?.trim(),
                attachmentUrl: input.attachmentUrl?.trim(),
              },
            });
          }

          if (readPermissionError) {
            return readPermissionError;
          }
          if (!input.query?.trim()) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires query.`,
              errorKind: 'missing_input',
              retryable: false,
            });
          }

          const objectiveParts = [input.query.trim()];
          if (input.module?.trim()) objectiveParts.push(`Module: ${input.module.trim()}`);
          if (input.recordId?.trim()) objectiveParts.push(`Record ID: ${input.recordId.trim()}`);
          if (input.filters && Object.keys(input.filters).length > 0) {
            objectiveParts.push(`Filters: ${JSON.stringify(input.filters)}`);
          }
          const agentResult = await loadZohoReadAgent().invoke(
            buildAgentInvokeInput(runtime, 'zoho-read', objectiveParts.join('\n'), {
              filters: input.filters,
            }),
          );
          const result = asRecord(asRecord(agentResult)?.result);
          const sourceRefs = asArray(result?.sourceRefs)
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => Boolean(entry));
          const citations = sourceRefs.flatMap((entry, index) => {
            const id = asString(entry.id);
            if (!id) return [];
            const [sourceType, rest] = id.split(':', 2);
            return [
              {
                id: `zoho-read-${index + 1}`,
                title: id,
                kind: 'record',
                sourceType,
                sourceId: rest ?? id,
              },
            ];
          });
          return toEnvelopeFromAgentResult(agentResult, {
            keyData: {
              recordId: input.recordId,
              recordType: input.module,
            },
            fullPayload: result,
            citations,
          });
        }),
    }),
  };

  return tools;
};
