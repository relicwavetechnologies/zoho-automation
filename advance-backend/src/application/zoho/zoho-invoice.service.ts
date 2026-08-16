import { randomUUID } from 'node:crypto';
import type { ZohoBooksOrganization, ZohoBooksPaginatedClient } from '../../infrastructure/zoho/zoho-books-paginated.client';
import { ToolError } from '../../shared/errors';
import type { Result } from '../../shared/result';
import { err, ok } from '../../shared/result';
import type { ZohoAttachmentSourcePort } from './zoho-attachment.service';
import {
  createZohoBooksWriteRunner,
} from './zoho-books-write';
import { writeZohoDocument, type ZohoDocumentAttachment } from './zoho-document-lifecycle';
import { summarizeZohoWrite, unwrapZohoRecord } from './zoho-books-write-result';
import { mapZohoError } from './zoho-error.utils';
import { normalizeInvoiceFields } from './zoho-invoice-fields';
import {
  checkInvoice,
  hasBlockingFinding,
} from './zoho-invoice-checks';
import { createZohoInvoiceRecovery } from './zoho-invoice-recovery';
import type {
  InvoiceReviewer,
  InvoiceReviewIssue,
  InvoiceReviewUnsourced,
} from './zoho-invoice-reviewer';
import {
  INVOICE_CLAIM_ABSENT,
  INVOICE_CLAIM_PENDING,
  INVOICE_CLAIM_UNRESOLVED,
  INVOICE_WRITE_CEILING_MS,
  MAX_INVOICE_FIX_ATTEMPTS,
  STAGED_INVOICE_TTL_MS,
  compareStagedToStored,
  describePayloadChange,
  matchStagedInvoice,
  renderStagedInvoice,
  type StagedInvoiceStore,
} from './zoho-invoice-staging';

export interface ZohoInvoiceConversationHistory {
  getHistory(
    chatId: string,
    limit?: number,
    scope?: { companyId: string; channel: string },
  ): Promise<{ ok: true; value: Array<{ role: string; content: string }> } | { ok: false; error: unknown }>;
}

export interface ZohoInvoiceDocumentParser {
  parse(input: { buffer: Buffer; fileName: string; mimeType: string; signal: AbortSignal }):
    Promise<{ units: readonly { text: string }[] }>;
}

export interface InvoiceStageOutput {
  readonly success: boolean;
  readonly stagingId: string;
  readonly stagedSummary: string;
  readonly review: {
    readonly outcome: 'pass' | 'fail' | 'unavailable';
    readonly reason: string;
    readonly issues: InvoiceReviewIssue[];
    readonly unsourced: InvoiceReviewUnsourced[];
    readonly attempt: number;
    readonly attemptsRemaining: number;
  };
  readonly message: string;
}

export interface InvoiceCreateOutput {
  readonly id?: string;
  readonly record: Record<string, unknown>;
  readonly recordUrl?: string;
  readonly drift?: { field: string; staged: string; stored: string }[];
  readonly message: string;
}

type CallContext = {
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly organizationId?: string;
  readonly correlationId: string;
  readonly channel: string;
  readonly chatId?: string;
  readonly runtimeThreadId?: string;
  readonly now: Date;
  readonly signal?: AbortSignal;
  readonly onProgress?: (message: string) => void;
};

const TWIN_READ_BACK_LIMIT = 5;

const text = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === 'string' ? (record[key] as string) : '';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const normalizeRecordNumber = (input: string): string => input.trim().toLowerCase().replace(/\s+/g, '');

const connectionAuth = (input: Pick<CallContext, 'userId' | 'connectionId' | 'signal'>) => ({
  userId: input.userId,
  connectionId: input.connectionId,
  ...(input.signal ? { signal: input.signal } : {}),
});

export function createZohoInvoiceService(deps: {
  readonly booksClient: ZohoBooksPaginatedClient;
  readonly staging?: StagedInvoiceStore;
  readonly reviewer?: InvoiceReviewer;
  readonly conversationHistory?: ZohoInvoiceConversationHistory;
  readonly documentParser?: ZohoInvoiceDocumentParser;
  readonly attachmentSource?: ZohoAttachmentSourcePort;
  readonly homeGstStateCode?: string;
  readonly appBaseUrl: string;
}) {
  const getRecord = async (
    input: CallContext,
    moduleName: 'contacts' | 'invoices',
    recordId: string,
    destination?: { connectionId: string; organizationId?: string | undefined },
  ) => {
    const organizationId = destination?.organizationId ?? input.organizationId;
    const payload = await deps.booksClient.getEndpoint({
      companyId: input.companyId,
      userId: input.userId,
      connectionId: destination?.connectionId ?? input.connectionId,
      path: `/${moduleName}/${encodeURIComponent(recordId)}`,
      ...(organizationId ? { organizationId } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return unwrapZohoRecord(payload, moduleName);
  };

  const gatherReviewSources = async (input: CallContext, payload: Record<string, unknown>) => {
    const organizations = await deps.booksClient
      .listOrganizations(input.companyId, connectionAuth(input))
      .catch(() => [] as ZohoBooksOrganization[]);
    const chosenOrg = input.organizationId
      ? organizations.find(org => org.organizationId === input.organizationId)
      : (organizations.find(org => org.isDefault === true) ?? organizations[0]);
    const reviewOrg = input.organizationId ?? chosenOrg?.organizationId;
    const orgScope = reviewOrg ? { organizationId: reviewOrg } : {};

    const customerId = text(payload, 'customer_id');
    const customerName = text(payload, 'customer_name');
    const invoiceNumber = text(payload, 'invoice_number').trim();

    const [chosenCustomer, otherMatches, taxes, items, sameNumber] = await Promise.all([
      customerId
        ? getRecord(input, 'contacts', customerId, { connectionId: input.connectionId, ...orgScope })
          .catch(() => undefined)
        : Promise.resolve(undefined),
      customerName
        ? deps.booksClient.listRecords({
            companyId: input.companyId,
            ...connectionAuth(input),
            moduleName: 'contacts',
            ...orgScope,
            filters: {},
            query: customerName,
            perPage: 10,
          }).then(result => result.items).catch(() => [] as Record<string, unknown>[])
        : Promise.resolve([] as Record<string, unknown>[]),
      deps.booksClient.getEndpoint({
        companyId: input.companyId,
        ...connectionAuth(input),
        path: '/settings/taxes',
        ...orgScope,
      }).then(data => Array.isArray(data['taxes']) ? data['taxes'] as Record<string, unknown>[] : [])
        .catch(() => [] as Record<string, unknown>[]),
      deps.booksClient.listRecords({
        companyId: input.companyId,
        ...connectionAuth(input),
        moduleName: 'items',
        ...orgScope,
        filters: {},
        perPage: 50,
      }).then(result => result.items).catch(() => [] as Record<string, unknown>[]),
      invoiceNumber
        ? deps.booksClient.listRecords({
            companyId: input.companyId,
            ...connectionAuth(input),
            moduleName: 'invoices',
            ...orgScope,
            filters: { invoice_number: invoiceNumber },
            perPage: 25,
          }).then(result => ({ items: result.items, ran: true }))
            .catch(() => ({ items: [] as Record<string, unknown>[], ran: false }))
        : Promise.resolve({ items: [] as Record<string, unknown>[], ran: true }),
    ]);

    return {
      ...(chosenCustomer ? { chosenCustomer } : {}),
      otherCustomerMatches: otherMatches.filter(record =>
        String(record['contact_id'] ?? '') !== customerId),
      availableTaxes: taxes,
      catalogueItems: items,
      reviewedOrganizationId: reviewOrg,
      reviewedOrganizationStateCode: chosenOrg?.stateCode,
      taxDirectionById: Object.fromEntries(
        taxes.flatMap(tax => {
          const id = String(tax['tax_id'] ?? '');
          const spec = String(tax['tax_specification'] ?? '').toLowerCase();
          return id && (spec === 'inter' || spec === 'intra')
            ? [[id, spec] as const]
            : [];
        }),
      ),
      sameNumberInvoices: sameNumber.items.filter(record =>
        String(record['invoice_number'] ?? '').trim().toLowerCase() === invoiceNumber.toLowerCase()),
      duplicateCheckUnavailable: !sameNumber.ran,
    };
  };

  const gatherTurns = async (input: CallContext) => {
    const threadId = input.runtimeThreadId ?? input.chatId;
    if (!deps.conversationHistory || !threadId) return [];
    const history = await deps.conversationHistory.getHistory(threadId, 30, {
      companyId: input.companyId,
      channel: input.channel,
    }).catch(() => null);
    if (!history?.ok) return [];
    return history.value
      .filter(turn => turn.role === 'user' || (turn.role === 'assistant' && turn.content.includes('?')))
      .map(turn => ({
        role: turn.role === 'user' ? 'member' as const : 'divo' as const,
        content: turn.content,
      }));
  };

  const gatherDocument = async (input: CallContext, fileName: string | undefined) => {
    if (!fileName || !deps.documentParser || !deps.attachmentSource) return undefined;
    if (input.channel !== 'lark' || !input.chatId) return undefined;
    const resolved = await deps.attachmentSource.resolve({
      companyId: input.companyId,
      userId: input.userId,
      channel: input.channel,
      chatId: input.chatId,
      fileName,
    }).catch(() => null);
    if (!resolved || resolved.kind !== 'resolved') return undefined;
    const parsed = await deps.documentParser.parse({
      buffer: resolved.content,
      fileName: resolved.fileName,
      mimeType: resolved.mimeType,
      signal: input.signal ?? AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (!parsed) return undefined;
    const sourceText = parsed.units.map(unit => unit.text).join('\n\n').trim();
    return sourceText ? { fileName: resolved.fileName, text: sourceText } : undefined;
  };

  return {
    async stage(input: CallContext & {
      readonly fields?: Record<string, unknown>;
      readonly fileName?: string;
      readonly supersedesStagingId?: string;
    }): Promise<Result<InvoiceStageOutput, ToolError>> {
      if (!input.fields) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for stage_invoice' }));
      }
      if (!deps.staging || !deps.reviewer) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'bad_args',
          message: 'Invoice staging is not configured on this deployment, so an invoice cannot be prepared for review.',
        }));
      }

      const normalized = normalizeInvoiceFields(input.fields);
      if (!normalized.ok) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: normalized.message }));
      }
      const payload = normalized.fields;
      const previous = input.supersedesStagingId
        ? await deps.staging.get({ stagingId: input.supersedesStagingId, companyId: input.companyId, userId: input.userId })
        : null;
      const attempt = (previous?.attempt ?? 0) + 1;

      input.onProgress?.('Checking the draft invoice…');
      const [sources, turns, sourceDocument] = await Promise.all([
        gatherReviewSources(input, payload),
        gatherTurns(input),
        gatherDocument(input, input.fileName),
      ]);

      const {
        sameNumberInvoices,
        reviewedOrganizationId,
        duplicateCheckUnavailable,
        reviewedOrganizationStateCode,
        taxDirectionById,
        ...reviewSources
      } = sources;

      if (!reviewedOrganizationId) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'upstream_failure',
          message: 'Divo could not work out which Zoho organisation to prepare this invoice for, '
            + 'so it will not stage one that might be created in the wrong set of books. Try again.',
        }));
      }

      const homeState = reviewedOrganizationStateCode ?? deps.homeGstStateCode;
      const findings = checkInvoice({
        invoice: payload,
        ...(homeState ? { homeGstStateCode: homeState } : {}),
        taxDirectionById,
        sameNumberInvoices,
        duplicateCheckUnavailable,
      });

      const customerName = typeof reviewSources.chosenCustomer?.['contact_name'] === 'string'
        ? reviewSources.chosenCustomer['contact_name'] as string
        : undefined;
      const summary = [
        renderStagedInvoice({
          payload,
          ...(customerName ? { customerName } : {}),
          findings,
          ...(input.fileName ? { attachFileName: input.fileName } : {}),
        }),
        ...(normalized.notes.length > 0
          ? ['', `Divo read: ${normalized.notes.join('; ')}.`]
          : []),
      ].join('\n');

      input.onProgress?.('Reviewing the draft…');
      const review = await deps.reviewer.review({
        turns,
        stagedSummary: summary,
        ...reviewSources,
        ...(sourceDocument ? { sourceDocument } : {}),
        findings,
        ...(previous ? { changedSincePrevious: describePayloadChange(previous.payload, payload) } : {}),
      });

      const stagingId = randomUUID();
      await deps.staging.put({
        stagingId,
        companyId: input.companyId,
        userId: input.userId,
        connectionId: input.connectionId,
        organizationId: reviewedOrganizationId,
        payload,
        summary,
        ...(input.fileName ? { attachFileName: input.fileName } : {}),
        findings,
        review,
        attempt,
        ...(input.supersedesStagingId ? { supersedesId: input.supersedesStagingId } : {}),
        expiresAt: new Date(input.now.getTime() + STAGED_INVOICE_TTL_MS),
      });

      const attemptsRemaining = Math.max(0, MAX_INVOICE_FIX_ATTEMPTS - (attempt - 1));
      const blocked = hasBlockingFinding(findings) || review.outcome === 'fail';
      return ok({
        success: !blocked,
        stagingId,
        stagedSummary: summary,
        review: {
          outcome: review.outcome,
          reason: review.reason,
          issues: [...review.issues],
          unsourced: [...review.unsourced],
          attempt,
          attemptsRemaining,
        },
        message: blocked
          ? `This draft is not ready. ${review.reason} Nothing has been created. Correct it and call stage_invoice again with supersedesStagingId, or ask the member about what could not be resolved.`
          : `Draft ready — nothing has been created yet. Show the member this summary exactly as written, including anything listed as unconfirmed, and create it only once they agree. Then call create_invoice with stagingId "${stagingId}".`,
      });
    },

    async create(input: CallContext & {
      readonly stagingId?: string;
      readonly attach?: (invoiceId: string, fileName: string, organizationId?: string) => Promise<ZohoDocumentAttachment>;
    }): Promise<Result<InvoiceCreateOutput, ToolError>> {
      if (!input.stagingId) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'bad_args',
          message: 'create_invoice needs a stagingId. Call stage_invoice first, show the member the summary it returns, and create only what they agreed to.',
        }));
      }
      if (!deps.staging) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'Invoice staging is not configured on this deployment.' }));
      }

      const staged = await deps.staging.get({ stagingId: input.stagingId, companyId: input.companyId, userId: input.userId });
      if (!staged) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'bad_args',
          message: 'That draft is unknown or has expired. Stage the invoice again and show the member the fresh summary.',
        }));
      }
      if (staged.expiresAt.getTime() <= input.now.getTime()) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'bad_args',
          message: 'That draft has expired. Stage it again so the member confirms current figures.',
        }));
      }
      if (hasBlockingFinding(staged.findings) || staged.review.outcome === 'fail') {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'bad_args',
          message: `This draft did not pass review, so it will not be created: ${staged.review.reason} Correct it with stage_invoice and supersedesStagingId.`,
        }));
      }
      if (input.connectionId !== staged.connectionId) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'bad_args',
          message: 'This draft was prepared for a different Zoho account than the one this call names. '
            + 'Create it with the account it was staged against, or stage it again for this one.',
        }));
      }
      if (input.organizationId && input.organizationId !== staged.organizationId) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'bad_args',
          message: 'This draft was prepared for a different Zoho organisation than the one this call names. '
            + 'Create it in the organisation it was staged against, or stage it again for this one.',
        }));
      }

      const recovery = createZohoInvoiceRecovery({
        booksClient: deps.booksClient,
        companyId: input.companyId,
        userId: input.userId,
        now: () => input.now,
        ...(input.signal ? { signal: input.signal } : {}),
        writeCeilingMs: INVOICE_WRITE_CEILING_MS,
      });
      const findInvoiceCreatedFrom = recovery.findCreatedFrom;

      const unresolved = await deps.staging.findUnresolved({
        companyId: input.companyId,
        connectionId: staged.connectionId,
      });
      const staleBefore = input.now.getTime() - INVOICE_WRITE_CEILING_MS;
      const twins = unresolved.filter(earlier =>
        earlier.stagingId !== staged.stagingId
        && matchStagedInvoice(earlier, staged.payload) !== 'no');

      if (twins.length > TWIN_READ_BACK_LIMIT) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'upstream_failure',
          message: `There are ${twins.length} earlier attempts at this same invoice whose outcome was never established, `
            + 'which is too many for Divo to check one by one. It will not create another until that is sorted out. '
            + 'Ask someone to look at this customer\'s invoices in Zoho.',
        }));
      }

      for (const earlier of twins) {
        const held = earlier.createdInvoiceId ?? '';
        if (held.startsWith(INVOICE_CLAIM_PENDING)
          && (earlier.claimedAt?.getTime() ?? 0) >= staleBefore) {
          return err(new ToolError({
            toolId: 'zohoBooks',
            reason: 'bad_args',
            message: 'This same invoice is being sent to Zoho right now by an earlier attempt. '
              + 'Creating it again would bill the customer twice, so it will not be created. '
              + 'Wait for that attempt to finish, then check Zoho before trying anything else.',
          }));
        }

        const readBack = await findInvoiceCreatedFrom(earlier);
        if (readBack.state === 'found') {
          await deps.staging.settle({
            stagingId: earlier.stagingId,
            companyId: input.companyId,
            invoiceId: readBack.invoiceId,
          });
          return err(new ToolError({
            toolId: 'zohoBooks',
            reason: 'bad_args',
            message: 'An earlier attempt at this same invoice did reach Zoho after all — it exists as invoice '
              + `${String(readBack.invoice['invoice_number'] ?? readBack.invoiceId)}. This draft will not be created, `
              + 'because it would bill the customer a second time. Show the member the existing invoice; '
              + 'use update_invoice if it needs correcting.',
          }));
        }
        if (readBack.state === 'unknown') {
          return err(new ToolError({
            toolId: 'zohoBooks',
            reason: 'upstream_failure',
            message: `An earlier attempt at this same invoice never reported back, and Divo cannot check whether it exists (${readBack.why}). `
              + 'Creating this draft could bill the customer twice, so it will not be created. '
              + 'Ask the member to look in Zoho, and try again once the connection is working.',
          }));
        }
        await deps.staging.markAbsent({
          stagingId: earlier.stagingId,
          companyId: input.companyId,
          marker: earlier.createdInvoiceId ?? '',
          absent: `${INVOICE_CLAIM_ABSENT}${input.correlationId}`,
        });
      }

      const marker = `${INVOICE_CLAIM_PENDING}${input.correlationId}`;
      const claim = await deps.staging.claim({ stagingId: staged.stagingId, companyId: input.companyId, marker });
      if (!claim.claimed) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'bad_args',
          message: claim.heldBy?.startsWith(INVOICE_CLAIM_PENDING)
            ? 'This draft is already being sent to Zoho. Do not send it again — check Zoho for the invoice before retrying.'
            : claim.heldBy?.startsWith(INVOICE_CLAIM_UNRESOLVED)
              ? 'An earlier attempt to create this invoice never reported back, so it may already exist in Zoho. '
                + 'Divo will not send it again. Check Zoho for this invoice and tell the member what you find.'
              : claim.heldBy?.startsWith(INVOICE_CLAIM_ABSENT)
                ? 'This draft was already sent to Zoho once. The invoice could not be found afterwards, so it was most '
                  + 'likely never created — but this draft is spent either way. Stage it again if the member confirms it is missing.'
                : `This draft was already created as invoice ${claim.heldBy}. It will not be created twice.`,
        }));
      }

      const writer = createZohoBooksWriteRunner({
        booksClient: deps.booksClient,
        companyId: input.companyId,
        userId: input.userId,
        connectionId: staged.connectionId,
        organizationId: staged.organizationId,
        ...(input.signal ? { signal: input.signal } : {}),
        appBaseUrl: deps.appBaseUrl,
      });

      let createdRecord: Record<string, unknown>;
      let createdId = '';
      let createdMessage = '';
      let createdRecordUrl: string | undefined;
      let recoveryNote = '';
      let createdFromReadBack = false;
      const writeOutcome = await writeZohoDocument({
        writer,
        receivedObject: 'the invoice',
        request: {
          module: 'invoices',
          verb: 'created',
          method: 'POST',
          path: '/invoices',
          ...(typeof staged.payload['invoice_number'] === 'string' && String(staged.payload['invoice_number']).trim()
            ? { params: { ignore_auto_number_generation: 'true' } }
            : {}),
          body: staged.payload,
        },
      });
      if (writeOutcome.kind === 'failed') {
        const { error, failure } = writeOutcome;
        if (failure.kind !== 'unknown') {
          await deps.staging.release({ stagingId: staged.stagingId, companyId: input.companyId, marker });
          return err(new ToolError({
            toolId: 'zohoBooks',
            reason: 'upstream_failure',
            cause: error,
            message: mapZohoError(error),
          }));
        }

        const readBack = await findInvoiceCreatedFrom(staged);
        if (readBack.state === 'found') {
          const summary = summarizeZohoWrite({
            module: 'invoices',
            verb: 'created',
            record: readBack.invoice,
            appBaseUrl: deps.appBaseUrl,
            ...(staged.organizationId ? { organizationId: staged.organizationId } : {}),
          });
          createdRecord = readBack.invoice;
          createdId = readBack.invoiceId;
          createdMessage = summary.message;
          createdRecordUrl = summary.recordUrl;
          recoveryNote = failure.why + ', so Divo checked Zoho: the invoice was created. ';
          createdFromReadBack = true;
        } else {
          if (readBack.state === 'absent') {
            await deps.staging.markAbsent({
              stagingId: staged.stagingId,
              companyId: input.companyId,
              marker,
              absent: INVOICE_CLAIM_ABSENT + input.correlationId,
            });
          } else {
            await deps.staging.markUnresolved({
              stagingId: staged.stagingId,
              companyId: input.companyId,
              marker,
              unresolved: INVOICE_CLAIM_UNRESOLVED + input.correlationId,
            });
          }
          return err(new ToolError({
            toolId: 'zohoBooks',
            reason: 'upstream_failure',
            cause: error,
            message: readBack.state === 'absent'
              ? mapZohoError(error) + ' ' + failure.why + '. Divo then searched Zoho for this invoice and did not find it, '
                + 'so it most likely was not created — but that search cannot be certain, and this draft will not be sent again. '
                + 'Tell the member what happened and stage it afresh only if they confirm it is missing.'
              : mapZohoError(error) + ' ' + failure.why + '. Divo tried to check Zoho and could not (' + readBack.why + '), '
                + 'so whether the invoice exists is genuinely unknown. It will not send this draft again. '
                + 'Check Zoho for it and tell the member what you find.',
          }));
        }
      } else if (writeOutcome.kind === 'missing_id') {
        await deps.staging.markUnresolved({
          stagingId: staged.stagingId,
          companyId: input.companyId,
          marker,
          unresolved: INVOICE_CLAIM_UNRESOLVED + input.correlationId,
        });
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'upstream_failure',
          message: 'Zoho accepted the invoice but returned no invoice_id. Check Zoho before trying again.',
        }));
      } else {
        const written = writeOutcome.written;
        createdRecord = written.record;
        createdId = written.summary.id;
        createdMessage = written.summary.message;
        createdRecordUrl = written.summary.recordUrl;
      }
      await deps.staging.settle({ stagingId: staged.stagingId, companyId: input.companyId, invoiceId: createdId });

      let attachmentNote = '';
      if (staged.attachFileName && createdId) {
        const outcome = await input.attach?.(createdId, staged.attachFileName, staged.organizationId);
        if (outcome) {
          attachmentNote = outcome.outcome === 'attached'
            ? ` ${outcome.message}`
            : outcome.outcome === 'refused'
              ? ` The invoice exists, but the file the member approved was never uploaded: ${outcome.message}`
                + ' Say so; attach_document can still put it on once the cause is fixed.'
              : ` The invoice exists, but the file the member approved is not confirmed on it: ${outcome.message}`
                + ' Say so rather than leaving them to assume it was attached, and do not retry the upload blind.';
        }
      }

      const shouldVerifyFinalRecord = Boolean(createdId) && (!createdFromReadBack || Boolean(attachmentNote));
      const verified = shouldVerifyFinalRecord
        ? await writer.verifyRecord({
            module: 'invoices',
            verb: 'created',
            recordId: createdId,
            fallbackRecord: createdRecord,
            connectionId: staged.connectionId,
            ...(staged.organizationId ? { organizationId: staged.organizationId } : {}),
          })
        : undefined;
      const stored = verified?.record ?? createdRecord;
      const storedWasReadBack = verified?.verified || (createdFromReadBack && !shouldVerifyFinalRecord);
      const drift = storedWasReadBack ? compareStagedToStored(staged.payload, stored) : [];
      const base = drift.length > 0
        ? `${verified?.message ?? createdMessage} Zoho stored some values differently from the draft the member approved: `
          + `${drift.map(d => `${d.field} was ${d.staged}, Zoho has ${d.stored}`).join('; ')}. Tell them before doing anything else with it.`
        : ((verified?.message ?? createdMessage) || 'Invoice created.');

      const id = verified?.summary.id || createdId;
      const recordUrl = verified?.summary.recordUrl ?? createdRecordUrl;
      return ok({
        ...(id ? { id } : {}),
        record: stored,
        ...(recordUrl ? { recordUrl } : {}),
        ...(drift.length > 0 ? { drift } : {}),
        message: `${recoveryNote}${base}${attachmentNote}`,
      });
    },
  };
}
