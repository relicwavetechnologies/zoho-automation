import { tool } from 'ai';
import { z } from 'zod';

import type { ToolActionGroup } from '../../../../tools/tool-action-groups';
import type { VercelRuntimeRequestContext, VercelRuntimeToolHooks, VercelToolEnvelope } from '../../types';

export const buildZohoBooksRuntimeTools = (
  runtime: VercelRuntimeRequestContext,
  hooks: VercelRuntimeToolHooks,
  helpers: Record<string, any>,
): Record<string, any> => {
  const {
    withLifecycle,
    buildEnvelope,
    ensureAnyActionPermission,
    toCanonicalToolId,
    loadZohoGatewayService,
    buildZohoGatewayRequester,
    asRecord,
    asString,
    inferErrorKind,
    withBooksReadAuthorizationRetry,
    buildZohoGatewayDeniedEnvelope,
    loadZohoBooksClient,
    isZohoBooksContactStatementModuleAlias,
    resolveZohoBooksRecordIdFromRuntime,
    buildBooksWriteRepairHints,
    resolveZohoBooksModuleFromRuntime,
    resolveZohoBooksModuleScopedExplicitRecordId,
    loadZohoFinanceOpsService,
    asNumber,
    loadOutboundArtifactService,
    asArray,
    contextSearchBrokerService,
    buildBooksReadRecordsEnvelope,
    resolvePendingBooksWriteBodyFromRuntime,
    createPendingRemoteApproval,
  } = helpers;

  const tools = {
    booksRead: tool({
      description:
        'Read Zoho Books organizations, finance records, reports, comments, templates, attachments, record documents, bank data, raw email/report metadata, and materialize sendable document artifacts. For overdue invoice lists, aging summaries, or requests like "all overdue customers/payments", prefer operation=buildOverdueReport instead of listRecords. If the user specifies a period such as this year, this month, or a custom range, pass invoiceDateFrom and invoiceDateTo so the overdue report is time-bounded before synthesis. Use operation=getReport only for actual Zoho Books report requests; for record-specific email, reminder, or statement content, prefer the dedicated get*EmailContent operation for that record type instead of getReport. For search/find/look-up requests in Zoho Books, especially customer or company lookups, this tool should prefer the broker-backed live Books search path before falling back to raw record listing.',
      inputSchema: z.object({
        operation: z.enum([
          'listOrganizations',
          'listRecords',
          'getRecord',
          'getRecordDocument',
          'materializeRecordDocumentArtifact',
          'summarizeModule',
          'getReport',
          'listTemplates',
          'listComments',
          'getBooksAttachment',
          'materializeBooksAttachmentArtifact',
          'buildOverdueReport',
          'mapCustomerPayments',
          'reconcileVendorStatement',
          'reconcileBankClosing',
          'getLastImportedStatement',
          'getMatchingBankTransactions',
          'getInvoiceEmailContent',
          'getInvoicePaymentReminderContent',
          'getEstimateEmailContent',
          'getCreditNoteEmailContent',
          'getSalesOrderEmailContent',
          'getPurchaseOrderEmailContent',
          'getContactStatementEmailContent',
          'getVendorPaymentEmailContent',
        ]),
        module: z.string().optional(),
        recordId: z.string().optional(),
        organizationId: z.string().optional(),
        accountId: z.string().optional(),
        transactionId: z.string().optional(),
        invoiceId: z.string().optional(),
        creditNoteId: z.string().optional(),
        salesOrderId: z.string().optional(),
        purchaseOrderId: z.string().optional(),
        estimateId: z.string().optional(),
        contactId: z.string().optional(),
        vendorPaymentId: z.string().optional(),
        commentId: z.string().optional(),
        reportName: z.string().optional(),
        templateId: z.string().optional(),
        documentFormat: z.enum(['pdf', 'html']).optional(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        asOfDate: z.string().optional(),
        invoiceDateFrom: z.string().optional(),
        invoiceDateTo: z.string().optional(),
        minOverdueDays: z.number().int().min(0).max(3650).optional(),
        amountTolerance: z.number().min(0).max(1_000_000).optional(),
        dateToleranceDays: z.number().int().min(0).max(3650).optional(),
        customerId: z.string().optional(),
        vendorId: z.string().optional(),
        vendorName: z.string().optional(),
        statementRows: z
          .array(
            z.object({
              rowId: z.string().optional(),
              date: z.string().optional(),
              description: z.string().optional(),
              reference: z.string().optional(),
              amount: z.number().optional(),
              debit: z.number().optional(),
              credit: z.number().optional(),
              balance: z.number().optional(),
              invoiceNumber: z.string().optional(),
              vendorName: z.string().optional(),
              customerName: z.string().optional(),
            }),
          )
          .optional(),
        filters: z.record(z.unknown()).optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'booksRead', 'Running Zoho Books read workflow', async () => {
          const readPermissionError = ensureAnyActionPermission(
            runtime,
            [toCanonicalToolId('zoho-books-read')],
            'read',
            'booksRead',
          );
          if (readPermissionError) {
            return readPermissionError;
          }
          const zohoGateway = loadZohoGatewayService();
          const gatewayRequester = buildZohoGatewayRequester(runtime);
          const requireBooksCompanyScope = async (
            operation: string,
          ): Promise<VercelToolEnvelope | null> => {
            const scope =
              asRecord(
                await zohoGateway.resolveScopeContext({
                  companyId: runtime.companyId,
                  requesterEmail: runtime.requesterEmail,
                  requesterAiRole: runtime.requesterAiRole,
                  departmentZohoReadScope: runtime.departmentZohoReadScope,
                  domain: 'books',
                }),
              ) ?? {};
            if (scope.scopeMode === 'company_scoped') {
              return null;
            }
            return buildEnvelope({
              success: false,
              summary: `${operation} requires company-scoped Zoho Books access.`,
              errorKind: 'permission',
              retryable: false,
            });
          };

          if (input.operation === 'listOrganizations') {
            const companyScopeError = await requireBooksCompanyScope('listOrganizations');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const organizations = await loadZohoBooksClient().listOrganizations({
                companyId: runtime.companyId,
              });
              return buildEnvelope({
                success: true,
                summary:
                  organizations.length > 0
                    ? `Found ${organizations.length} Zoho Books organization(s).`
                    : 'No Zoho Books organizations were returned by the current connection.',
                keyData: {
                  organizationId: asString(organizations[0]?.organizationId),
                  organizations,
                },
                fullPayload: {
                  organizations,
                },
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to list Zoho Books organizations.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (
            ['listRecords', 'getRecord'].includes(input.operation)
            && isZohoBooksContactStatementModuleAlias(input.module)
          ) {
            const statementContactId = resolveZohoBooksRecordIdFromRuntime(
              runtime,
              'contacts',
              input.contactId?.trim() ?? input.customerId?.trim(),
            );
            if (!statementContactId) {
              return buildEnvelope({
                success: false,
                summary: 'Contact statements require contactId or customerId.',
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['contactId'],
                repairHints: buildBooksWriteRepairHints(['contactId']),
              });
            }
            try {
              const auth = await withBooksReadAuthorizationRetry(runtime, async (requester) =>
                zohoGateway.getAuthorizedChildResource({
                  domain: 'books',
                  module: 'contacts',
                  recordId: statementContactId,
                  childType: 'statement_email_content',
                  requester,
                  organizationId: input.organizationId?.trim(),
                }),
              );
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this contact statement email content.',
                );
              }
              const result = await loadZohoBooksClient().getContactStatementEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                contactId: statementContactId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched contact statement email content for ${statementContactId}.`,
                keyData: {
                  contactId: statementContactId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch contact statement email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          const moduleName = resolveZohoBooksModuleFromRuntime(
            runtime,
            input.module,
            input.operation,
          );
          const invoiceId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'invoices',
            input.invoiceId,
          );
          const estimateId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'estimates',
            input.estimateId,
          );
          const creditNoteId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'creditnotes',
            input.creditNoteId,
          );
          const salesOrderId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'salesorders',
            input.salesOrderId,
          );
          const purchaseOrderId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'purchaseorders',
            input.purchaseOrderId,
          );
          const contactId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'contacts',
            input.contactId,
          );
          const vendorPaymentId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'vendorpayments',
            input.vendorPaymentId,
          );
          const recordId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            moduleName,
            resolveZohoBooksModuleScopedExplicitRecordId({
              moduleName,
              recordId: input.recordId,
              invoiceId,
              estimateId,
              creditNoteId,
              salesOrderId,
              purchaseOrderId,
              billId: input.billId,
              contactId,
              vendorPaymentId,
              accountId: input.accountId,
              transactionId: input.transactionId,
            }),
          );
          if (
            input.operation !== 'getLastImportedStatement' &&
            input.operation !== 'getMatchingBankTransactions' &&
            input.operation !== 'getInvoiceEmailContent' &&
            input.operation !== 'getInvoicePaymentReminderContent' &&
            input.operation !== 'getEstimateEmailContent' &&
            input.operation !== 'getContactStatementEmailContent' &&
            input.operation !== 'getVendorPaymentEmailContent' &&
            input.operation !== 'getReport' &&
            input.operation !== 'buildOverdueReport' &&
            input.operation !== 'mapCustomerPayments' &&
            input.operation !== 'reconcileVendorStatement' &&
            input.operation !== 'reconcileBankClosing' &&
            !moduleName
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires a supported Zoho Books module such as contacts, invoices, estimates, creditnotes, bills, salesorders, purchaseorders, customerpayments, vendorpayments, bankaccounts, or banktransactions.`,
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['module'],
              repairHints: buildBooksWriteRepairHints(['module']),
            });
          }

          if (input.operation === 'buildOverdueReport') {
            try {
              const report = await loadZohoFinanceOpsService().buildOverdueReport({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                requesterEmail: runtime.requesterEmail,
                requesterAiRole: runtime.requesterAiRole,
                departmentZohoReadScope: runtime.departmentZohoReadScope,
                asOfDate: input.asOfDate?.trim(),
                invoiceDateFrom: input.invoiceDateFrom?.trim(),
                invoiceDateTo: input.invoiceDateTo?.trim(),
                limit: input.limit,
                minOverdueDays: input.minOverdueDays,
              });
              return buildEnvelope({
                success: true,
                summary: asString(report.summary) ?? 'Built Zoho overdue report.',
                keyData: {
                  organizationId: asString(report.organizationId),
                  scopeMode: asString(report.scopeMode),
                  invoiceCount: asNumber(report.invoiceCount),
                  totalOutstanding: asNumber(report.totalOutstanding),
                },
                fullPayload: report,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to build overdue report.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'mapCustomerPayments') {
            const companyScopeError = await requireBooksCompanyScope('mapCustomerPayments');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const mapping = await loadZohoFinanceOpsService().mapCustomerPayments({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                requesterEmail: runtime.requesterEmail,
                requesterAiRole: runtime.requesterAiRole,
                departmentZohoReadScope: runtime.departmentZohoReadScope,
                amountTolerance: input.amountTolerance,
                dateToleranceDays: input.dateToleranceDays,
                limit: input.limit,
                customerId: input.customerId?.trim(),
              });
              return buildEnvelope({
                success: true,
                summary: asString(mapping.summary) ?? 'Mapped customer payments.',
                keyData: {
                  organizationId: asString(mapping.organizationId),
                  exactMatchCount: Array.isArray(mapping.exactMatches)
                    ? mapping.exactMatches.length
                    : undefined,
                  probableMatchCount: Array.isArray(mapping.probableMatches)
                    ? mapping.probableMatches.length
                    : undefined,
                },
                fullPayload: mapping,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to map customer payments.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'reconcileVendorStatement') {
            if (!input.statementRows || input.statementRows.length === 0) {
              return buildEnvelope({
                success: false,
                summary: 'reconcileVendorStatement requires statementRows.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope('reconcileVendorStatement');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const reconciliation = await loadZohoFinanceOpsService().reconcileVendorStatement({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                requesterEmail: runtime.requesterEmail,
                requesterAiRole: runtime.requesterAiRole,
                departmentZohoReadScope: runtime.departmentZohoReadScope,
                statementRows: input.statementRows,
                vendorId: input.vendorId?.trim(),
                vendorName: input.vendorName?.trim(),
                amountTolerance: input.amountTolerance,
                dateToleranceDays: input.dateToleranceDays,
                limit: input.limit,
              });
              return buildEnvelope({
                success: true,
                summary: asString(reconciliation.summary) ?? 'Reconciled vendor statement.',
                keyData: {
                  organizationId: asString(reconciliation.organizationId),
                  matchedCount: Array.isArray(reconciliation.matched)
                    ? reconciliation.matched.length
                    : undefined,
                  probableMatchCount: Array.isArray(reconciliation.probableMatches)
                    ? reconciliation.probableMatches.length
                    : undefined,
                },
                fullPayload: reconciliation,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to reconcile vendor statement.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'reconcileBankClosing') {
            if (!input.statementRows || input.statementRows.length === 0) {
              return buildEnvelope({
                success: false,
                summary: 'reconcileBankClosing requires statementRows.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope('reconcileBankClosing');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const reconciliation = await loadZohoFinanceOpsService().reconcileBankClosing({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                requesterEmail: runtime.requesterEmail,
                requesterAiRole: runtime.requesterAiRole,
                departmentZohoReadScope: runtime.departmentZohoReadScope,
                accountId: input.accountId?.trim(),
                statementRows: input.statementRows,
                amountTolerance: input.amountTolerance,
                dateToleranceDays: input.dateToleranceDays,
                limit: input.limit,
              });
              return buildEnvelope({
                success: true,
                summary: asString(reconciliation.summary) ?? 'Reconciled bank closing.',
                keyData: {
                  organizationId: asString(reconciliation.organizationId),
                  matchedCount: Array.isArray(reconciliation.matched)
                    ? reconciliation.matched.length
                    : undefined,
                  probableMatchCount: Array.isArray(reconciliation.probableMatches)
                    ? reconciliation.probableMatches.length
                    : undefined,
                },
                fullPayload: reconciliation,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to reconcile bank closing.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getLastImportedStatement') {
            if (!input.accountId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getLastImportedStatement requires accountId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope('getLastImportedStatement');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const result = await loadZohoBooksClient().getLastImportedBankStatement({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                accountId: input.accountId.trim(),
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched last imported statement for bank account ${input.accountId.trim()}.`,
                keyData: {
                  accountId: input.accountId.trim(),
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch last imported bank statement.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getMatchingBankTransactions') {
            if (!input.transactionId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getMatchingBankTransactions requires transactionId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope('getMatchingBankTransactions');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const result = await loadZohoBooksClient().getMatchingBankTransactions({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                transactionId: input.transactionId.trim(),
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho Books match suggestions for bank transaction ${input.transactionId.trim()}.`,
                keyData: {
                  transactionId: input.transactionId.trim(),
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch matching bank transactions.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getInvoiceEmailContent') {
            if (!invoiceId) {
              return buildEnvelope({
                success: false,
                summary: 'getInvoiceEmailContent requires invoiceId.',
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['invoiceId'],
              });
            }
            try {
              const auth = await withBooksReadAuthorizationRetry(runtime, async (requester) =>
                zohoGateway.getAuthorizedChildResource({
                  domain: 'books',
                  module: 'invoices',
                  recordId: invoiceId,
                  childType: 'email_content',
                  requester,
                  organizationId: input.organizationId?.trim(),
                }),
              );
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this invoice email content.',
                );
              }
              const result = await loadZohoBooksClient().getInvoiceEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                invoiceId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched invoice email content for ${invoiceId}.`,
                keyData: {
                  invoiceId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch invoice email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getInvoicePaymentReminderContent') {
            if (!invoiceId) {
              return buildEnvelope({
                success: false,
                summary: 'getInvoicePaymentReminderContent requires invoiceId.',
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['invoiceId'],
              });
            }
            try {
              const auth = await withBooksReadAuthorizationRetry(runtime, async (requester) =>
                zohoGateway.getAuthorizedChildResource({
                  domain: 'books',
                  module: 'invoices',
                  recordId: invoiceId,
                  childType: 'payment_reminder_content',
                  requester,
                  organizationId: input.organizationId?.trim(),
                }),
              );
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this invoice reminder content.',
                );
              }
              const result = await loadZohoBooksClient().getInvoicePaymentReminderContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                invoiceId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched payment reminder email content for invoice ${invoiceId}.`,
                keyData: {
                  invoiceId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch invoice payment reminder content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getEstimateEmailContent') {
            if (!estimateId) {
              return buildEnvelope({
                success: false,
                summary: 'getEstimateEmailContent requires estimateId.',
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['estimateId'],
              });
            }
            try {
              const auth = await withBooksReadAuthorizationRetry(runtime, async (requester) =>
                zohoGateway.getAuthorizedChildResource({
                  domain: 'books',
                  module: 'estimates',
                  recordId: estimateId,
                  childType: 'email_content',
                  requester,
                  organizationId: input.organizationId?.trim(),
                }),
              );
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this estimate email content.',
                );
              }
              const result = await loadZohoBooksClient().getEstimateEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                estimateId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched estimate email content for ${estimateId}.`,
                keyData: {
                  estimateId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch estimate email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getCreditNoteEmailContent') {
            if (!creditNoteId) {
              return buildEnvelope({
                success: false,
                summary: 'getCreditNoteEmailContent requires creditNoteId.',
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['creditNoteId'],
              });
            }
            try {
              const auth = await withBooksReadAuthorizationRetry(runtime, async (requester) =>
                zohoGateway.getAuthorizedChildResource({
                  domain: 'books',
                  module: 'creditnotes',
                  recordId: creditNoteId,
                  childType: 'email_content',
                  requester,
                  organizationId: input.organizationId?.trim(),
                }),
              );
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this credit note email content.',
                );
              }
              const result = await loadZohoBooksClient().getCreditNoteEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                creditNoteId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched credit note email content for ${creditNoteId}.`,
                keyData: {
                  creditNoteId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch credit note email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getSalesOrderEmailContent') {
            if (!salesOrderId) {
              return buildEnvelope({
                success: false,
                summary: 'getSalesOrderEmailContent requires salesOrderId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            try {
              const auth =
                asRecord(
                  await zohoGateway.getAuthorizedChildResource({
                    domain: 'books',
                    module: 'salesorders',
                    recordId: salesOrderId,
                    childType: 'email_content',
                    requester: gatewayRequester,
                    organizationId: input.organizationId?.trim(),
                  }),
                ) ?? {};
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this sales order email content.',
                );
              }
              const result = await loadZohoBooksClient().getSalesOrderEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                salesOrderId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched sales order email content for ${salesOrderId}.`,
                keyData: {
                  salesOrderId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch sales order email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getPurchaseOrderEmailContent') {
            if (!purchaseOrderId) {
              return buildEnvelope({
                success: false,
                summary: 'getPurchaseOrderEmailContent requires purchaseOrderId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope(
              'getPurchaseOrderEmailContent',
            );
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const result = await loadZohoBooksClient().getPurchaseOrderEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                purchaseOrderId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched purchase order email content for ${purchaseOrderId}.`,
                keyData: {
                  purchaseOrderId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch purchase order email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'listTemplates') {
            if (!moduleName) {
              return buildEnvelope({
                success: false,
                summary: 'listTemplates requires a supported Zoho Books module.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope('listTemplates');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const result = await loadZohoBooksClient().listTemplates?.({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                moduleName,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho Books templates for ${moduleName}.`,
                keyData: {
                  module: moduleName,
                  organizationId: result?.organizationId,
                },
                fullPayload: result?.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho Books templates.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getBooksAttachment') {
            if (!moduleName || !recordId) {
              return buildEnvelope({
                success: false,
                summary: 'getBooksAttachment requires a supported module and recordId.',
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['module', 'recordId'],
              });
            }
            try {
              const auth = await withBooksReadAuthorizationRetry(runtime, async (requester) =>
                zohoGateway.getAuthorizedChildResource({
                  domain: 'books',
                  module: moduleName,
                  recordId,
                  childType: 'attachments',
                  requester,
                  organizationId: input.organizationId?.trim(),
                }),
              );
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this Zoho Books attachment.',
                );
              }
              const result = await loadZohoBooksClient().getAttachment?.({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                moduleName,
                recordId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho Books attachment for ${moduleName} ${recordId}.`,
                keyData: {
                  module: moduleName,
                  recordId,
                  organizationId: result?.organizationId,
                  sizeBytes: asNumber(asRecord(result?.payload)?.sizeBytes),
                  contentType: asString(asRecord(result?.payload)?.contentType),
                },
                fullPayload: result?.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho Books attachment.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'materializeBooksAttachmentArtifact') {
            if (!moduleName || !recordId) {
              return buildEnvelope({
                success: false,
                summary: 'materializeBooksAttachmentArtifact requires a supported module and recordId.',
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['module', 'recordId'],
                userAction:
                  'Please provide the Zoho Books module and recordId before materializing the attachment artifact.',
              });
            }
            try {
              const artifact = await loadOutboundArtifactService().materializeFromZohoBooksDocument({
                companyId: runtime.companyId,
                requesterUserId: runtime.userId,
                requesterAiRole: runtime.requesterAiRole,
                requesterEmail: runtime.requesterEmail,
                organizationId: input.organizationId?.trim(),
                moduleName,
                recordId,
                kind: 'attachment',
              });
              return buildEnvelope({
                success: true,
                summary: `Created outbound attachment artifact for Zoho Books ${moduleName} ${recordId}.`,
                keyData: {
                  artifactId: asString(artifact.id),
                  module: moduleName,
                  recordId,
                  fileName: asString(artifact.fileName),
                  mimeType: asString(artifact.mimeType),
                },
                fullPayload: {
                  artifact,
                },
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to materialize Zoho Books attachment artifact.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getRecordDocument') {
            if (!moduleName || !recordId) {
              return buildEnvelope({
                success: false,
                summary: 'getRecordDocument requires a supported module and recordId.',
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['module', 'recordId'],
              });
            }
            try {
              const auth = await withBooksReadAuthorizationRetry(runtime, async (requester) =>
                zohoGateway.getAuthorizedChildResource({
                  domain: 'books',
                  module: moduleName,
                  recordId,
                  childType: 'record_document',
                  requester,
                  organizationId: input.organizationId?.trim(),
                }),
              );
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this Zoho Books document.',
                );
              }
              const result = await loadZohoBooksClient().getRecordDocument?.({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                moduleName,
                recordId,
                accept: input.documentFormat ?? 'pdf',
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho Books ${input.documentFormat ?? 'pdf'} document for ${moduleName} ${recordId}.`,
                keyData: {
                  module: moduleName,
                  recordId,
                  organizationId: result?.organizationId,
                  format: input.documentFormat ?? 'pdf',
                  sizeBytes: asNumber(asRecord(result?.payload)?.sizeBytes),
                  contentType: asString(asRecord(result?.payload)?.contentType),
                },
                fullPayload: result?.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch Zoho Books record document.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'materializeRecordDocumentArtifact') {
            if (!moduleName || !recordId) {
              return buildEnvelope({
                success: false,
                summary: 'materializeRecordDocumentArtifact requires a supported module and recordId.',
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['module', 'recordId'],
                userAction:
                  'Please provide the Zoho Books module and recordId before materializing the document artifact.',
              });
            }
            try {
              const artifact = await loadOutboundArtifactService().materializeFromZohoBooksDocument({
                companyId: runtime.companyId,
                requesterUserId: runtime.userId,
                requesterAiRole: runtime.requesterAiRole,
                requesterEmail: runtime.requesterEmail,
                organizationId: input.organizationId?.trim(),
                moduleName,
                recordId,
                kind: 'record_document',
                accept: input.documentFormat ?? 'pdf',
              });
              return buildEnvelope({
                success: true,
                summary: `Created outbound document artifact for Zoho Books ${moduleName} ${recordId}.`,
                keyData: {
                  artifactId: asString(artifact.id),
                  module: moduleName,
                  recordId,
                  fileName: asString(artifact.fileName),
                  mimeType: asString(artifact.mimeType),
                },
                fullPayload: {
                  artifact,
                },
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to materialize Zoho Books document artifact.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getContactStatementEmailContent') {
            if (!contactId) {
              return buildEnvelope({
                success: false,
                summary: 'getContactStatementEmailContent requires contactId.',
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['contactId'],
              });
            }
            try {
              const auth = await withBooksReadAuthorizationRetry(runtime, async (requester) =>
                zohoGateway.getAuthorizedChildResource({
                  domain: 'books',
                  module: 'contacts',
                  recordId: contactId,
                  childType: 'statement_email_content',
                  requester,
                  organizationId: input.organizationId?.trim(),
                }),
              );
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access this contact statement email content.',
                );
              }
              const result = await loadZohoBooksClient().getContactStatementEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                contactId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched contact statement email content for ${contactId}.`,
                keyData: {
                  contactId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch contact statement email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getVendorPaymentEmailContent') {
            if (!vendorPaymentId) {
              return buildEnvelope({
                success: false,
                summary: 'getVendorPaymentEmailContent requires vendorPaymentId.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope(
              'getVendorPaymentEmailContent',
            );
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const result = await loadZohoBooksClient().getVendorPaymentEmailContent({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                vendorPaymentId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched vendor payment email content for ${vendorPaymentId}.`,
                keyData: {
                  vendorPaymentId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error
                  ? error.message
                  : 'Failed to fetch vendor payment email content.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'listComments') {
            if (!moduleName || !recordId) {
              return buildEnvelope({
                success: false,
                summary: 'listComments requires a supported module and recordId.',
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['module', 'recordId'],
              });
            }
            try {
              const auth = await withBooksReadAuthorizationRetry(runtime, async (requester) =>
                zohoGateway.getAuthorizedChildResource({
                  domain: 'books',
                  module: moduleName,
                  recordId,
                  childType: 'comments',
                  requester,
                  organizationId: input.organizationId?.trim(),
                }),
              );
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  'You are not allowed to access these Zoho Books comments.',
                );
              }
              const result = await loadZohoBooksClient().listComments({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                moduleName: moduleName as
                  | 'invoices'
                  | 'estimates'
                  | 'creditnotes'
                  | 'bills'
                  | 'salesorders'
                  | 'purchaseorders',
                recordId,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched comments for Zoho Books ${moduleName} ${recordId}.`,
                keyData: {
                  module: moduleName,
                  recordId,
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho Books comments.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getReport') {
            if (!input.reportName?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'getReport requires reportName.',
                errorKind: 'missing_input',
                retryable: false,
              });
            }
            const companyScopeError = await requireBooksCompanyScope('getReport');
            if (companyScopeError) {
              return companyScopeError;
            }
            try {
              const result = await loadZohoBooksClient().getReport({
                companyId: runtime.companyId,
                organizationId: input.organizationId?.trim(),
                reportName: input.reportName.trim(),
                filters: input.filters,
              });
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho Books report ${input.reportName.trim()}.`,
                keyData: {
                  reportName: input.reportName.trim(),
                  organizationId: result.organizationId,
                },
                fullPayload: result.payload,
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho Books report.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          if (input.operation === 'getRecord') {
            if (!recordId) {
              return buildEnvelope({
                success: false,
                summary: 'getRecord requires recordId.',
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['recordId'],
              });
            }
            try {
              const auth = await withBooksReadAuthorizationRetry(runtime, async (requester) =>
                zohoGateway.getAuthorizedRecord({
                  domain: 'books',
                  module: moduleName,
                  recordId,
                  requester,
                  organizationId: input.organizationId?.trim(),
                }),
              );
              if (auth.allowed !== true) {
                return buildZohoGatewayDeniedEnvelope(
                  auth,
                  `You are not allowed to access Zoho Books ${moduleName} ${recordId}.`,
                );
              }
              return buildEnvelope({
                success: true,
                summary: `Fetched Zoho Books ${moduleName} record ${recordId}.`,
                keyData: {
                  module: moduleName,
                  recordId,
                  organizationId: asString(auth.organizationId),
                },
                fullPayload: {
                  organizationId: asString(auth.organizationId),
                  record: asRecord(auth.payload) ?? {},
                },
                citations: [
                  {
                    id: `books-${moduleName}-${recordId}`,
                    title: `${moduleName}:${recordId}`,
                    kind: 'record',
                    sourceType: moduleName,
                    sourceId: recordId,
                  },
                ],
              });
            } catch (error) {
              const summary =
                error instanceof Error ? error.message : 'Failed to fetch Zoho Books record.';
              return buildEnvelope({
                success: false,
                summary,
                errorKind: inferErrorKind(summary),
                retryable: true,
              });
            }
          }

          try {
            const normalizedQuery = input.query?.trim();
            const shouldUseBooksBrokerSearch =
              input.operation === 'listRecords'
              && moduleName === 'contacts'
              && Boolean(normalizedQuery)
              && !recordId
              && !input.filters;

            if (shouldUseBooksBrokerSearch && normalizedQuery) {
              const brokerResult = await contextSearchBrokerService.search({
                runtime,
                query: normalizedQuery,
                limit: Math.max(1, Math.min(input.limit ?? 5, 5)),
                sources: {
                  personalHistory: false,
                  files: false,
                  larkContacts: false,
                  zohoCrmContext: false,
                  zohoBooksLive: true,
                  workspace: false,
                  web: false,
                  skills: false,
                },
              });
              const brokerCitations = contextSearchBrokerService.toVercelCitationsFromSearch(brokerResult);
              if (brokerResult.results.length > 0) {
                return buildEnvelope({
                  success: true,
                  summary: brokerResult.searchSummary,
                  keyData: {
                    module: moduleName,
                    organizationId: brokerResult.results.find((result) => asString(result.organizationId))?.organizationId,
                    recordCount: brokerResult.results.length,
                    resultCount: brokerResult.results.length,
                    brokerSearch: true,
                    resolvedEntities: brokerResult.resolvedEntities,
                  },
                  fullPayload: {
                    organizationId: brokerResult.results.find((result) => asString(result.organizationId))?.organizationId,
                    records: [],
                    brokerSearch: {
                      results: brokerResult.results,
                      matches: brokerResult.matches,
                      resolvedEntities: brokerResult.resolvedEntities,
                      sourceCoverage: brokerResult.sourceCoverage,
                      searchSummary: brokerResult.searchSummary,
                    },
                  },
                  citations: brokerCitations,
                });
              }
            }

            const auth = await withBooksReadAuthorizationRetry(runtime, async (requester) =>
              zohoGateway.listAuthorizedRecords({
                domain: 'books',
                module: moduleName,
                requester,
                organizationId: input.organizationId?.trim(),
                filters: input.filters,
                limit: input.limit,
                query: input.query?.trim(),
              }),
            );
            if (auth.allowed !== true) {
              return buildZohoGatewayDeniedEnvelope(
                auth,
                `You are not allowed to read Zoho Books ${moduleName}.`,
              );
            }
            const resultPayload = asRecord(auth.payload) ?? {};
            const resultItems = asArray(resultPayload.records)
              .map((entry) => asRecord(entry))
              .filter((entry): entry is Record<string, unknown> => Boolean(entry));
            const organizationId = asString(auth.organizationId);

            if (input.operation === 'summarizeModule') {
              return buildBooksReadRecordsEnvelope({
                moduleName,
                organizationId,
                resultItems,
                raw: asRecord(resultPayload.raw) ?? undefined,
                summarizeOnly: true,
              });
            }

            return buildBooksReadRecordsEnvelope({
              moduleName,
              organizationId,
              resultItems,
              raw: asRecord(resultPayload.raw) ?? undefined,
            });
          } catch (error) {
            const summary =
              error instanceof Error ? error.message : 'Failed to read Zoho Books records.';
            return buildEnvelope({
              success: false,
              summary,
              errorKind: inferErrorKind(summary),
              retryable: true,
            });
          }
        }),
    }),

    booksWrite: tool({
      description:
        'Create, update, delete, reconcile, categorize, email, attach files, apply templates, remind, and status-change Zoho Books records through approval-gated actions.',
      inputSchema: z.object({
        operation: z.enum([
          'createRecord',
          'updateRecord',
          'deleteRecord',
          'importBankStatement',
          'activateBankAccount',
          'deactivateBankAccount',
          'matchBankTransaction',
          'unmatchBankTransaction',
          'excludeBankTransaction',
          'restoreBankTransaction',
          'uncategorizeBankTransaction',
          'categorizeBankTransaction',
          'categorizeBankTransactionAsExpense',
          'categorizeBankTransactionAsVendorPayment',
          'categorizeBankTransactionAsCustomerPayment',
          'categorizeBankTransactionAsCreditNoteRefund',
          'emailInvoice',
          'remindInvoice',
          'enableInvoicePaymentReminder',
          'disableInvoicePaymentReminder',
          'writeOffInvoice',
          'cancelInvoiceWriteOff',
          'markInvoiceSent',
          'voidInvoice',
          'markInvoiceDraft',
          'submitInvoice',
          'approveInvoice',
          'emailEstimate',
          'emailCreditNote',
          'openCreditNote',
          'voidCreditNote',
          'refundCreditNote',
          'emailSalesOrder',
          'openSalesOrder',
          'voidSalesOrder',
          'submitSalesOrder',
          'approveSalesOrder',
          'createInvoiceFromSalesOrder',
          'emailPurchaseOrder',
          'openPurchaseOrder',
          'billPurchaseOrder',
          'cancelPurchaseOrder',
          'rejectPurchaseOrder',
          'submitPurchaseOrder',
          'approvePurchaseOrder',
          'enableContactPaymentReminder',
          'disableContactPaymentReminder',
          'markEstimateSent',
          'acceptEstimate',
          'declineEstimate',
          'submitEstimate',
          'approveEstimate',
          'voidBill',
          'openBill',
          'submitBill',
          'approveBill',
          'emailContact',
          'emailContactStatement',
          'emailVendorPayment',
          'applyBooksTemplate',
          'uploadBooksAttachment',
          'deleteBooksAttachment',
          'addBooksComment',
          'updateBooksComment',
          'deleteBooksComment',
        ]),
        module: z.string().optional(),
        recordId: z.string().optional(),
        organizationId: z.string().optional(),
        accountId: z.string().optional(),
        transactionId: z.string().optional(),
        invoiceId: z.string().optional(),
        creditNoteId: z.string().optional(),
        salesOrderId: z.string().optional(),
        purchaseOrderId: z.string().optional(),
        billId: z.string().optional(),
        estimateId: z.string().optional(),
        contactId: z.string().optional(),
        vendorPaymentId: z.string().optional(),
        commentId: z.string().optional(),
        templateId: z.string().optional(),
        fileName: z.string().optional(),
        contentType: z.string().optional(),
        contentBase64: z.string().optional(),
        body: z.record(z.unknown()).optional(),
      }),
      execute: async (input) =>
        withLifecycle(hooks, 'booksWrite', 'Running Zoho Books write workflow', async () => {
          const moduleName = resolveZohoBooksModuleFromRuntime(
            runtime,
            input.module,
            input.operation,
          );
          const recordId = resolveZohoBooksRecordIdFromRuntime(runtime, moduleName, input.recordId);
          const invoiceId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'invoices',
            input.invoiceId,
          );
          const estimateId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'estimates',
            input.estimateId,
          );
          const creditNoteId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'creditnotes',
            input.creditNoteId,
          );
          const salesOrderId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'salesorders',
            input.salesOrderId,
          );
          const purchaseOrderId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'purchaseorders',
            input.purchaseOrderId,
          );
          const billId = resolveZohoBooksRecordIdFromRuntime(runtime, 'bills', input.billId);
          const contactId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'contacts',
            input.contactId,
          );
          const vendorPaymentId = resolveZohoBooksRecordIdFromRuntime(
            runtime,
            'vendorpayments',
            input.vendorPaymentId,
          );
          const body = resolvePendingBooksWriteBodyFromRuntime({
            runtime,
            operation: input.operation,
            moduleName,
            recordId,
            explicitBody: input.body,
          });
          const isRecordCrudOperation = ['createRecord', 'updateRecord', 'deleteRecord'].includes(
            input.operation,
          );
          if (isRecordCrudOperation && !moduleName) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires a supported Zoho Books module such as contacts, invoices, estimates, creditnotes, bills, salesorders, purchaseorders, customerpayments, vendorpayments, bankaccounts, or banktransactions.`,
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['module'],
              repairHints: buildBooksWriteRepairHints(['module']),
            });
          }

          const actionGroup: ToolActionGroup =
            input.operation === 'createRecord' || input.operation === 'importBankStatement'
              ? 'create'
              : input.operation === 'updateRecord' ||
                  input.operation === 'activateBankAccount' ||
                  input.operation === 'deactivateBankAccount' ||
                  input.operation === 'matchBankTransaction' ||
                  input.operation === 'unmatchBankTransaction' ||
                  input.operation === 'excludeBankTransaction' ||
                  input.operation === 'restoreBankTransaction' ||
                  input.operation === 'uncategorizeBankTransaction' ||
                  input.operation === 'categorizeBankTransaction' ||
                  input.operation === 'categorizeBankTransactionAsExpense' ||
                  input.operation === 'categorizeBankTransactionAsVendorPayment' ||
                  input.operation === 'categorizeBankTransactionAsCustomerPayment' ||
                  input.operation === 'categorizeBankTransactionAsCreditNoteRefund' ||
                  input.operation === 'enableInvoicePaymentReminder' ||
                  input.operation === 'disableInvoicePaymentReminder' ||
                  input.operation === 'writeOffInvoice' ||
                  input.operation === 'cancelInvoiceWriteOff' ||
                  input.operation === 'markInvoiceSent' ||
                  input.operation === 'voidInvoice' ||
                  input.operation === 'markInvoiceDraft' ||
                  input.operation === 'submitInvoice' ||
                  input.operation === 'approveInvoice' ||
                  input.operation === 'openCreditNote' ||
                  input.operation === 'voidCreditNote' ||
                  input.operation === 'refundCreditNote' ||
                  input.operation === 'openSalesOrder' ||
                  input.operation === 'voidSalesOrder' ||
                  input.operation === 'submitSalesOrder' ||
                  input.operation === 'approveSalesOrder' ||
                  input.operation === 'createInvoiceFromSalesOrder' ||
                  input.operation === 'openPurchaseOrder' ||
                  input.operation === 'billPurchaseOrder' ||
                  input.operation === 'cancelPurchaseOrder' ||
                  input.operation === 'rejectPurchaseOrder' ||
                  input.operation === 'submitPurchaseOrder' ||
                  input.operation === 'approvePurchaseOrder' ||
                  input.operation === 'enableContactPaymentReminder' ||
                  input.operation === 'disableContactPaymentReminder' ||
                  input.operation === 'markEstimateSent' ||
                  input.operation === 'acceptEstimate' ||
                  input.operation === 'declineEstimate' ||
                  input.operation === 'submitEstimate' ||
                  input.operation === 'approveEstimate' ||
                  input.operation === 'voidBill' ||
                  input.operation === 'openBill' ||
                  input.operation === 'submitBill' ||
                  input.operation === 'approveBill' ||
                  input.operation === 'applyBooksTemplate' ||
                  input.operation === 'updateBooksComment'
                ? 'update'
                : input.operation === 'deleteRecord' ||
                    input.operation === 'deleteBooksAttachment' ||
                    input.operation === 'deleteBooksComment'
                  ? 'delete'
                  : 'send';
          const permissionError = ensureAnyActionPermission(
            runtime,
            [toCanonicalToolId('zoho-books-write')],
            actionGroup,
            'booksWrite',
          );
          if (permissionError) {
            return permissionError;
          }

          if (input.operation === 'updateRecord' || input.operation === 'deleteRecord') {
            if (!recordId) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires recordId.`,
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['recordId'],
                repairHints: buildBooksWriteRepairHints(['recordId']),
              });
            }
          }
          if (
            (input.operation === 'createRecord' ||
              input.operation === 'updateRecord' ||
              input.operation === 'importBankStatement' ||
              input.operation === 'matchBankTransaction' ||
              input.operation === 'categorizeBankTransaction' ||
              input.operation === 'categorizeBankTransactionAsExpense' ||
              input.operation === 'categorizeBankTransactionAsVendorPayment' ||
              input.operation === 'categorizeBankTransactionAsCustomerPayment' ||
              input.operation === 'categorizeBankTransactionAsCreditNoteRefund' ||
              input.operation === 'emailCreditNote' ||
              input.operation === 'refundCreditNote' ||
              input.operation === 'createInvoiceFromSalesOrder' ||
              input.operation === 'addBooksComment' ||
              input.operation === 'updateBooksComment') &&
            !body
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires body.`,
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['body'],
              repairHints: buildBooksWriteRepairHints(['body']),
            });
          }
          if (
            (input.operation === 'activateBankAccount' ||
              input.operation === 'deactivateBankAccount' ||
              input.operation === 'importBankStatement') &&
            !input.accountId?.trim()
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires accountId.`,
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['accountId'],
              repairHints: buildBooksWriteRepairHints(['accountId']),
            });
          }
          if (
            [
              'matchBankTransaction',
              'unmatchBankTransaction',
              'excludeBankTransaction',
              'restoreBankTransaction',
              'uncategorizeBankTransaction',
              'categorizeBankTransaction',
              'categorizeBankTransactionAsExpense',
              'categorizeBankTransactionAsVendorPayment',
              'categorizeBankTransactionAsCustomerPayment',
              'categorizeBankTransactionAsCreditNoteRefund',
            ].includes(input.operation) &&
            !input.transactionId?.trim()
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires transactionId.`,
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['transactionId'],
              repairHints: buildBooksWriteRepairHints(['transactionId']),
            });
          }
          if (
            [
              'emailInvoice',
              'remindInvoice',
              'enableInvoicePaymentReminder',
              'disableInvoicePaymentReminder',
              'writeOffInvoice',
              'cancelInvoiceWriteOff',
              'markInvoiceSent',
              'voidInvoice',
              'markInvoiceDraft',
              'submitInvoice',
              'approveInvoice',
            ].includes(input.operation) &&
            !invoiceId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires invoiceId.`,
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['invoiceId'],
              repairHints: {
                ...buildBooksWriteRepairHints(['invoiceId']),
                invoiceId: 'Use the most recent invoice read context or current invoice entity before asking the user.',
              },
            });
          }
          if (
            [
              'emailEstimate',
              'markEstimateSent',
              'acceptEstimate',
              'declineEstimate',
              'submitEstimate',
              'approveEstimate',
            ].includes(input.operation) &&
            !estimateId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires estimateId.`,
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['estimateId'],
              repairHints: buildBooksWriteRepairHints(['estimateId']),
            });
          }
          if (
            ['emailCreditNote', 'openCreditNote', 'voidCreditNote', 'refundCreditNote'].includes(
              input.operation,
            ) &&
            !creditNoteId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires creditNoteId.`,
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['creditNoteId'],
              repairHints: buildBooksWriteRepairHints(['creditNoteId']),
            });
          }
          if (
            [
              'emailSalesOrder',
              'openSalesOrder',
              'voidSalesOrder',
              'submitSalesOrder',
              'approveSalesOrder',
              'createInvoiceFromSalesOrder',
            ].includes(input.operation) &&
            !salesOrderId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires salesOrderId.`,
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['salesOrderId'],
              repairHints: buildBooksWriteRepairHints(['salesOrderId']),
            });
          }
          if (
            [
              'emailPurchaseOrder',
              'openPurchaseOrder',
              'billPurchaseOrder',
              'cancelPurchaseOrder',
              'rejectPurchaseOrder',
              'submitPurchaseOrder',
              'approvePurchaseOrder',
            ].includes(input.operation) &&
            !purchaseOrderId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires purchaseOrderId.`,
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['purchaseOrderId'],
              repairHints: buildBooksWriteRepairHints(['purchaseOrderId']),
            });
          }
          if (
            ['voidBill', 'openBill', 'submitBill', 'approveBill'].includes(input.operation) &&
            !billId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires billId.`,
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['billId'],
              repairHints: buildBooksWriteRepairHints(['billId']),
            });
          }
          if (
            (input.operation === 'emailContact' || input.operation === 'emailContactStatement') &&
            !contactId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires contactId.`,
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['contactId'],
              repairHints: buildBooksWriteRepairHints(['contactId']),
            });
          }
          if (
            ['enableContactPaymentReminder', 'disableContactPaymentReminder'].includes(
              input.operation,
            ) &&
            !contactId
          ) {
            return buildEnvelope({
              success: false,
              summary: `${input.operation} requires contactId.`,
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['contactId'],
              repairHints: buildBooksWriteRepairHints(['contactId']),
            });
          }
          if (input.operation === 'emailVendorPayment' && !vendorPaymentId) {
            return buildEnvelope({
              success: false,
              summary: 'emailVendorPayment requires vendorPaymentId.',
              errorKind: 'missing_input',
              retryable: false,
              missingFields: ['vendorPaymentId'],
              repairHints: buildBooksWriteRepairHints(['vendorPaymentId']),
            });
          }
          if (
            ['addBooksComment', 'updateBooksComment', 'deleteBooksComment'].includes(
              input.operation,
            )
          ) {
            if (!moduleName || !recordId) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires a supported module and recordId.`,
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['module', 'recordId'],
                repairHints: buildBooksWriteRepairHints(['module', 'recordId']),
              });
            }
            if (
              (input.operation === 'updateBooksComment' ||
                input.operation === 'deleteBooksComment') &&
              !input.commentId?.trim()
            ) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires commentId.`,
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['commentId'],
                repairHints: buildBooksWriteRepairHints(['commentId']),
              });
            }
          }
          if (
            ['applyBooksTemplate', 'uploadBooksAttachment', 'deleteBooksAttachment'].includes(
              input.operation,
            )
          ) {
            if (!moduleName || !recordId) {
              return buildEnvelope({
                success: false,
                summary: `${input.operation} requires a supported module and recordId.`,
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['module', 'recordId'],
                repairHints: buildBooksWriteRepairHints(['module', 'recordId']),
              });
            }
            if (input.operation === 'applyBooksTemplate' && !input.templateId?.trim()) {
              return buildEnvelope({
                success: false,
                summary: 'applyBooksTemplate requires templateId.',
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['templateId'],
                repairHints: buildBooksWriteRepairHints(['templateId']),
              });
            }
            if (
              input.operation === 'uploadBooksAttachment' &&
              (!input.fileName?.trim() || !input.contentBase64?.trim())
            ) {
              return buildEnvelope({
                success: false,
                summary: 'uploadBooksAttachment requires fileName and contentBase64.',
                errorKind: 'missing_input',
                retryable: false,
                missingFields: ['fileName', 'contentBase64'],
                repairHints: buildBooksWriteRepairHints(['fileName', 'contentBase64']),
              });
            }
          }

          const booksMutationAuth =
            asRecord(
              await loadZohoGatewayService().executeAuthorizedMutation({
                ...buildBooksMutationAuthorizationTarget({
                  operation: input.operation,
                  moduleName,
                  recordId,
                  accountId: input.accountId?.trim(),
                  transactionId: input.transactionId?.trim(),
                  invoiceId,
                  estimateId,
                  creditNoteId,
                  salesOrderId,
                  purchaseOrderId,
                  billId,
                  contactId,
                  vendorPaymentId,
                  organizationId: input.organizationId?.trim(),
                }),
                requester: buildZohoGatewayRequester(runtime),
              }),
            ) ?? {};
          if (booksMutationAuth.allowed !== true) {
            return buildZohoGatewayDeniedEnvelope(
              booksMutationAuth,
              `You are not allowed to mutate Zoho Books ${moduleName ?? input.operation}.`,
            );
          }

          let subject =
            input.operation === 'createRecord'
              ? `Create Zoho Books ${moduleName}`
              : input.operation === 'updateRecord'
                ? `Update Zoho Books ${moduleName} ${recordId ?? ''}`.trim()
                : input.operation === 'deleteRecord'
                  ? `Delete Zoho Books ${moduleName} ${recordId ?? ''}`.trim()
                  : input.operation === 'importBankStatement'
                    ? `Import bank statement for account ${input.accountId?.trim() ?? ''}`.trim()
                    : input.operation === 'activateBankAccount'
                      ? `Activate Zoho Books bank account ${input.accountId?.trim() ?? ''}`.trim()
                      : input.operation === 'deactivateBankAccount'
                        ? `Deactivate Zoho Books bank account ${input.accountId?.trim() ?? ''}`.trim()
                        : input.operation === 'matchBankTransaction'
                          ? `Match Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}`.trim()
                          : input.operation === 'unmatchBankTransaction'
                            ? `Unmatch Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}`.trim()
                            : input.operation === 'excludeBankTransaction'
                              ? `Exclude Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}`.trim()
                              : input.operation === 'restoreBankTransaction'
                                ? `Restore Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}`.trim()
                                : input.operation === 'uncategorizeBankTransaction'
                                  ? `Uncategorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}`.trim()
                                  : input.operation === 'categorizeBankTransaction'
                                    ? `Categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}`.trim()
                                    : input.operation === 'categorizeBankTransactionAsExpense'
                                      ? `Categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as expense`.trim()
                                      : input.operation ===
                                          'categorizeBankTransactionAsVendorPayment'
                                        ? `Categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as vendor payment`.trim()
                                        : input.operation ===
                                            'categorizeBankTransactionAsCustomerPayment'
                                          ? `Categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as customer payment`.trim()
                                          : input.operation ===
                                              'categorizeBankTransactionAsCreditNoteRefund'
                                            ? `Categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as credit note refund`.trim()
                                            : input.operation === 'emailInvoice'
                                              ? `Email Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                              : input.operation === 'remindInvoice'
                                                ? `Send payment reminder for Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                                : input.operation === 'enableInvoicePaymentReminder'
                                                  ? `Enable payment reminder for Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                                  : input.operation ===
                                                      'disableInvoicePaymentReminder'
                                                    ? `Disable payment reminder for Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                                    : input.operation === 'writeOffInvoice'
                                                      ? `Write off Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                                      : input.operation === 'cancelInvoiceWriteOff'
                                                        ? `Cancel write off for Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                                        : input.operation === 'markInvoiceSent'
                                                          ? `Mark Zoho Books invoice ${invoiceId ?? ''} as sent`.trim()
                                                          : input.operation === 'voidInvoice'
                                                            ? `Void Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                                            : input.operation === 'markInvoiceDraft'
                                                              ? `Mark Zoho Books invoice ${invoiceId ?? ''} as draft`.trim()
                                                              : input.operation === 'submitInvoice'
                                                                ? `Submit Zoho Books invoice ${invoiceId ?? ''} for approval`.trim()
                                                                : input.operation ===
                                                                    'approveInvoice'
                                                                  ? `Approve Zoho Books invoice ${invoiceId ?? ''}`.trim()
                                                                  : input.operation ===
                                                                      'emailEstimate'
                                                                    ? `Email Zoho Books estimate ${estimateId ?? ''}`.trim()
                                                                    : input.operation ===
                                                                        'enableContactPaymentReminder'
                                                                      ? `Enable payment reminders for Zoho Books contact ${contactId ?? ''}`.trim()
                                                                      : input.operation ===
                                                                          'disableContactPaymentReminder'
                                                                        ? `Disable payment reminders for Zoho Books contact ${contactId ?? ''}`.trim()
                                                                        : input.operation ===
                                                                            'markEstimateSent'
                                                                          ? `Mark Zoho Books estimate ${estimateId ?? ''} as sent`.trim()
                                                                          : input.operation ===
                                                                              'acceptEstimate'
                                                                            ? `Mark Zoho Books estimate ${estimateId ?? ''} as accepted`.trim()
                                                                            : input.operation ===
                                                                                'declineEstimate'
                                                                              ? `Mark Zoho Books estimate ${estimateId ?? ''} as declined`.trim()
                                                                              : input.operation ===
                                                                                  'submitEstimate'
                                                                                ? `Submit Zoho Books estimate ${estimateId ?? ''} for approval`.trim()
                                                                                : input.operation ===
                                                                                    'approveEstimate'
                                                                                  ? `Approve Zoho Books estimate ${estimateId ?? ''}`.trim()
                                                                                  : input.operation ===
                                                                                      'voidBill'
                                                                                    ? `Void Zoho Books bill ${billId ?? ''}`.trim()
                                                                                    : input.operation ===
                                                                                        'openBill'
                                                                                      ? `Mark Zoho Books bill ${billId ?? ''} as open`.trim()
                                                                                      : input.operation ===
                                                                                          'submitBill'
                                                                                        ? `Submit Zoho Books bill ${billId ?? ''} for approval`.trim()
                                                                                        : input.operation ===
                                                                                            'approveBill'
                                                                                          ? `Approve Zoho Books bill ${billId ?? ''}`.trim()
                                                                                          : input.operation ===
                                                                                              'emailContact'
                                                                                            ? `Email Zoho Books contact ${contactId ?? ''}`.trim()
                                                                                            : input.operation ===
                                                                                                'emailContactStatement'
                                                                                              ? `Email Zoho Books contact statement ${contactId ?? ''}`.trim()
                                                                                              : `Email Zoho Books vendor payment ${vendorPaymentId ?? ''}`.trim();
          let summary =
            input.operation === 'createRecord'
              ? `Approval required to create a Zoho Books ${moduleName} record.`
              : input.operation === 'updateRecord'
                ? `Approval required to update Zoho Books ${moduleName} ${recordId ?? ''}.`.trim()
                : input.operation === 'deleteRecord'
                  ? `Approval required to delete Zoho Books ${moduleName} ${recordId ?? ''}.`.trim()
                  : input.operation === 'importBankStatement'
                    ? `Approval required to import a bank statement into account ${input.accountId?.trim() ?? ''}.`.trim()
                    : input.operation === 'activateBankAccount'
                      ? `Approval required to activate Zoho Books bank account ${input.accountId?.trim() ?? ''}.`.trim()
                      : input.operation === 'deactivateBankAccount'
                        ? `Approval required to deactivate Zoho Books bank account ${input.accountId?.trim() ?? ''}.`.trim()
                        : input.operation === 'matchBankTransaction'
                          ? `Approval required to match Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}.`.trim()
                          : input.operation === 'unmatchBankTransaction'
                            ? `Approval required to unmatch Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}.`.trim()
                            : input.operation === 'excludeBankTransaction'
                              ? `Approval required to exclude Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}.`.trim()
                              : input.operation === 'restoreBankTransaction'
                                ? `Approval required to restore Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}.`.trim()
                                : input.operation === 'uncategorizeBankTransaction'
                                  ? `Approval required to uncategorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}.`.trim()
                                  : input.operation === 'categorizeBankTransaction'
                                    ? `Approval required to categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''}.`.trim()
                                    : input.operation === 'categorizeBankTransactionAsExpense'
                                      ? `Approval required to categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as an expense.`.trim()
                                      : input.operation ===
                                          'categorizeBankTransactionAsVendorPayment'
                                        ? `Approval required to categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as a vendor payment.`.trim()
                                        : input.operation ===
                                            'categorizeBankTransactionAsCustomerPayment'
                                          ? `Approval required to categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as a customer payment.`.trim()
                                          : input.operation ===
                                              'categorizeBankTransactionAsCreditNoteRefund'
                                            ? `Approval required to categorize Zoho Books bank transaction ${input.transactionId?.trim() ?? ''} as a credit note refund.`.trim()
                                            : input.operation === 'emailInvoice'
                                              ? `Approval required to email Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                              : input.operation === 'remindInvoice'
                                                ? `Approval required to send a payment reminder for Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                                : input.operation === 'enableInvoicePaymentReminder'
                                                  ? `Approval required to enable payment reminders for Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                                  : input.operation ===
                                                      'disableInvoicePaymentReminder'
                                                    ? `Approval required to disable payment reminders for Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                                    : input.operation === 'writeOffInvoice'
                                                      ? `Approval required to write off Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                                      : input.operation === 'cancelInvoiceWriteOff'
                                                        ? `Approval required to cancel the write off for Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                                        : input.operation === 'markInvoiceSent'
                                                          ? `Approval required to mark Zoho Books invoice ${invoiceId ?? ''} as sent.`.trim()
                                                          : input.operation === 'voidInvoice'
                                                            ? `Approval required to void Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                                            : input.operation === 'markInvoiceDraft'
                                                              ? `Approval required to mark Zoho Books invoice ${invoiceId ?? ''} as draft.`.trim()
                                                              : input.operation === 'submitInvoice'
                                                                ? `Approval required to submit Zoho Books invoice ${invoiceId ?? ''} for approval.`.trim()
                                                                : input.operation ===
                                                                    'approveInvoice'
                                                                  ? `Approval required to approve Zoho Books invoice ${invoiceId ?? ''}.`.trim()
                                                                  : input.operation ===
                                                                      'emailEstimate'
                                                                    ? `Approval required to email Zoho Books estimate ${estimateId ?? ''}.`.trim()
                                                                    : input.operation ===
                                                                        'enableContactPaymentReminder'
                                                                      ? `Approval required to enable payment reminders for Zoho Books contact ${contactId ?? ''}.`.trim()
                                                                      : input.operation ===
                                                                          'disableContactPaymentReminder'
                                                                        ? `Approval required to disable payment reminders for Zoho Books contact ${contactId ?? ''}.`.trim()
                                                                        : input.operation ===
                                                                            'markEstimateSent'
                                                                          ? `Approval required to mark Zoho Books estimate ${estimateId ?? ''} as sent.`.trim()
                                                                          : input.operation ===
                                                                              'acceptEstimate'
                                                                            ? `Approval required to mark Zoho Books estimate ${estimateId ?? ''} as accepted.`.trim()
                                                                            : input.operation ===
                                                                                'declineEstimate'
                                                                              ? `Approval required to mark Zoho Books estimate ${estimateId ?? ''} as declined.`.trim()
                                                                              : input.operation ===
                                                                                  'submitEstimate'
                                                                                ? `Approval required to submit Zoho Books estimate ${estimateId ?? ''} for approval.`.trim()
                                                                                : input.operation ===
                                                                                    'approveEstimate'
                                                                                  ? `Approval required to approve Zoho Books estimate ${estimateId ?? ''}.`.trim()
                                                                                  : input.operation ===
                                                                                      'voidBill'
                                                                                    ? `Approval required to void Zoho Books bill ${billId ?? ''}.`.trim()
                                                                                    : input.operation ===
                                                                                        'openBill'
                                                                                      ? `Approval required to mark Zoho Books bill ${billId ?? ''} as open.`.trim()
                                                                                      : input.operation ===
                                                                                          'submitBill'
                                                                                        ? `Approval required to submit Zoho Books bill ${billId ?? ''} for approval.`.trim()
                                                                                        : input.operation ===
                                                                                            'approveBill'
                                                                                          ? `Approval required to approve Zoho Books bill ${billId ?? ''}.`.trim()
                                                                                          : input.operation ===
                                                                                              'emailContact'
                                                                                            ? `Approval required to email Zoho Books contact ${contactId ?? ''}.`.trim()
                                                                                            : input.operation ===
                                                                                                'emailContactStatement'
                                                                                              ? `Approval required to email a statement to Zoho Books contact ${contactId ?? ''}.`.trim()
                                                                                              : `Approval required to email Zoho Books vendor payment ${vendorPaymentId ?? ''}.`.trim();

          if (input.operation === 'emailCreditNote') {
            subject = `Email Zoho Books credit note ${creditNoteId ?? ''}`.trim();
            summary =
              `Approval required to email Zoho Books credit note ${creditNoteId ?? ''}.`.trim();
          } else if (input.operation === 'openCreditNote') {
            subject = `Mark Zoho Books credit note ${creditNoteId ?? ''} as open`.trim();
            summary =
              `Approval required to mark Zoho Books credit note ${creditNoteId ?? ''} as open.`.trim();
          } else if (input.operation === 'voidCreditNote') {
            subject = `Void Zoho Books credit note ${creditNoteId ?? ''}`.trim();
            summary =
              `Approval required to void Zoho Books credit note ${creditNoteId ?? ''}.`.trim();
          } else if (input.operation === 'refundCreditNote') {
            subject = `Refund Zoho Books credit note ${creditNoteId ?? ''}`.trim();
            summary =
              `Approval required to refund Zoho Books credit note ${creditNoteId ?? ''}.`.trim();
          } else if (input.operation === 'emailSalesOrder') {
            subject = `Email Zoho Books sales order ${salesOrderId ?? ''}`.trim();
            summary =
              `Approval required to email Zoho Books sales order ${salesOrderId ?? ''}.`.trim();
          } else if (input.operation === 'openSalesOrder') {
            subject = `Mark Zoho Books sales order ${salesOrderId ?? ''} as open`.trim();
            summary =
              `Approval required to mark Zoho Books sales order ${salesOrderId ?? ''} as open.`.trim();
          } else if (input.operation === 'voidSalesOrder') {
            subject = `Void Zoho Books sales order ${salesOrderId ?? ''}`.trim();
            summary =
              `Approval required to void Zoho Books sales order ${salesOrderId ?? ''}.`.trim();
          } else if (input.operation === 'submitSalesOrder') {
            subject = `Submit Zoho Books sales order ${salesOrderId ?? ''} for approval`.trim();
            summary =
              `Approval required to submit Zoho Books sales order ${salesOrderId ?? ''} for approval.`.trim();
          } else if (input.operation === 'approveSalesOrder') {
            subject = `Approve Zoho Books sales order ${salesOrderId ?? ''}`.trim();
            summary =
              `Approval required to approve Zoho Books sales order ${salesOrderId ?? ''}.`.trim();
          } else if (input.operation === 'createInvoiceFromSalesOrder') {
            subject = `Create invoice from Zoho Books sales order ${salesOrderId ?? ''}`.trim();
            summary =
              `Approval required to create an invoice from Zoho Books sales order ${salesOrderId ?? ''}.`.trim();
          } else if (input.operation === 'emailPurchaseOrder') {
            subject = `Email Zoho Books purchase order ${purchaseOrderId ?? ''}`.trim();
            summary =
              `Approval required to email Zoho Books purchase order ${purchaseOrderId ?? ''}.`.trim();
          } else if (input.operation === 'openPurchaseOrder') {
            subject = `Mark Zoho Books purchase order ${purchaseOrderId ?? ''} as open`.trim();
            summary =
              `Approval required to mark Zoho Books purchase order ${purchaseOrderId ?? ''} as open.`.trim();
          } else if (input.operation === 'billPurchaseOrder') {
            subject = `Mark Zoho Books purchase order ${purchaseOrderId ?? ''} as billed`.trim();
            summary =
              `Approval required to mark Zoho Books purchase order ${purchaseOrderId ?? ''} as billed.`.trim();
          } else if (input.operation === 'cancelPurchaseOrder') {
            subject = `Cancel Zoho Books purchase order ${purchaseOrderId ?? ''}`.trim();
            summary =
              `Approval required to cancel Zoho Books purchase order ${purchaseOrderId ?? ''}.`.trim();
          } else if (input.operation === 'rejectPurchaseOrder') {
            subject = `Reject Zoho Books purchase order ${purchaseOrderId ?? ''}`.trim();
            summary =
              `Approval required to reject Zoho Books purchase order ${purchaseOrderId ?? ''}.`.trim();
          } else if (input.operation === 'submitPurchaseOrder') {
            subject =
              `Submit Zoho Books purchase order ${purchaseOrderId ?? ''} for approval`.trim();
            summary =
              `Approval required to submit Zoho Books purchase order ${purchaseOrderId ?? ''} for approval.`.trim();
          } else if (input.operation === 'approvePurchaseOrder') {
            subject = `Approve Zoho Books purchase order ${purchaseOrderId ?? ''}`.trim();
            summary =
              `Approval required to approve Zoho Books purchase order ${purchaseOrderId ?? ''}.`.trim();
          } else if (input.operation === 'addBooksComment') {
            subject = `Add Zoho Books comment on ${moduleName} ${recordId ?? ''}`.trim();
            summary =
              `Approval required to add a comment to Zoho Books ${moduleName} ${recordId ?? ''}.`.trim();
          } else if (input.operation === 'updateBooksComment') {
            subject = `Update Zoho Books comment ${input.commentId?.trim() ?? ''}`.trim();
            summary =
              `Approval required to update Zoho Books comment ${input.commentId?.trim() ?? ''}.`.trim();
          } else if (input.operation === 'deleteBooksComment') {
            subject = `Delete Zoho Books comment ${input.commentId?.trim() ?? ''}`.trim();
            summary =
              `Approval required to delete Zoho Books comment ${input.commentId?.trim() ?? ''}.`.trim();
          } else if (input.operation === 'applyBooksTemplate') {
            subject =
              `Apply Zoho Books template ${input.templateId?.trim() ?? ''} to ${moduleName} ${recordId ?? ''}`.trim();
            summary =
              `Approval required to apply Zoho Books template ${input.templateId?.trim() ?? ''} to ${moduleName} ${recordId ?? ''}.`.trim();
          } else if (input.operation === 'uploadBooksAttachment') {
            subject = `Upload attachment to Zoho Books ${moduleName} ${recordId ?? ''}`.trim();
            summary =
              `Approval required to upload an attachment to Zoho Books ${moduleName} ${recordId ?? ''}.`.trim();
          } else if (input.operation === 'deleteBooksAttachment') {
            subject = `Delete attachment from Zoho Books ${moduleName} ${recordId ?? ''}`.trim();
            summary =
              `Approval required to delete the attachment from Zoho Books ${moduleName} ${recordId ?? ''}.`.trim();
          }

          return createPendingRemoteApproval({
            runtime,
            toolId: 'zoho-books-write',
            actionGroup,
            operation: input.operation,
            summary,
            subject,
            explanation:
              'Zoho Books mutations are approval-gated. Review the module, organization, record target, and payload before proceeding.',
            payload: {
              operation: input.operation,
              module: moduleName,
              recordId,
              organizationId: input.organizationId?.trim(),
              accountId: input.accountId?.trim(),
              transactionId: input.transactionId?.trim(),
              invoiceId,
              billId,
              estimateId,
              creditNoteId,
              salesOrderId,
              purchaseOrderId,
              contactId,
              vendorPaymentId,
              commentId: input.commentId?.trim(),
              templateId: input.templateId?.trim(),
              fileName: input.fileName?.trim(),
              contentType: input.contentType?.trim(),
              contentBase64: input.contentBase64?.trim(),
              body,
            },
          });
        }),
    }),
  };

  return tools;
};
