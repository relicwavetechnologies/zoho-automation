import { randomUUID } from 'node:crypto';
import type { ZohoBooksOrganization, ZohoBooksPaginatedClient } from '../../infrastructure/zoho/zoho-books-paginated.client';
import { ToolError } from '../../shared/errors';
import type { Result } from '../../shared/result';
import { err, ok } from '../../shared/result';
import { mapZohoError } from './zoho-error.utils';
import { refuseSelfDealing } from './zoho-self-dealing';
import {
  classifyZohoBooksWriteFailure,
  createZohoBooksWriteRunner,
} from './zoho-books-write';
import { unwrapZohoRecord, type ZohoWriteSummary } from './zoho-books-write-result';
import {
  BILL_CLAIM_PENDING,
  BILL_CLAIM_UNRESOLVED,
  checkBill,
  hasBlockingBillFinding,
  renderStagedBill,
  sameBillDraft,
  STAGED_BILL_TTL_MS,
  type StagedBillStore,
} from './zoho-bill-staging';

export interface BillStageOutput {
  readonly success: boolean;
  readonly stagingId: string;
  readonly stagedSummary: string;
  readonly message: string;
}

export interface BillCreateOutput {
  readonly record: Record<string, unknown>;
  readonly summary: ZohoWriteSummary;
  readonly message: string;
}

type CallContext = {
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly organizationId?: string;
  readonly correlationId: string;
  readonly now: Date;
  readonly signal?: AbortSignal;
  readonly onProgress?: (message: string) => void;
};

type AttachmentResult = { outcome: 'attached' | 'unconfirmed' | 'refused'; message: string };

const text = (record: Record<string, unknown>, ...keys: string[]): string =>
  keys.map(key => record[key]).find(value => typeof value === 'string' && value.trim()) as string | undefined ?? '';

async function chooseOrganization(
  booksClient: ZohoBooksPaginatedClient,
  input: CallContext,
): Promise<ZohoBooksOrganization | undefined> {
  try {
    const organizations = await booksClient.listOrganizations(input.companyId, {
      userId: input.userId,
      connectionId: input.connectionId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return input.organizationId
      ? organizations.find(item => item.organizationId === input.organizationId)
      : (organizations.find(item => item.isDefault === true) ?? organizations[0]);
  } catch {
    return undefined;
  }
}

async function getContact(
  booksClient: ZohoBooksPaginatedClient,
  input: CallContext,
  contactId: string,
  organizationId: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const payload = await booksClient.getEndpoint({
      companyId: input.companyId,
      userId: input.userId,
      connectionId: input.connectionId,
      organizationId,
      path: `/contacts/${encodeURIComponent(contactId)}`,
    });
    return unwrapZohoRecord(payload, 'contacts');
  } catch {
    return undefined;
  }
}

export function createZohoBillService(deps: {
  readonly booksClient: ZohoBooksPaginatedClient;
  readonly staging?: StagedBillStore;
  readonly appBaseUrl: string;
}) {
  return {
    async stage(input: CallContext & { fields?: Record<string, unknown>; fileName?: string }): Promise<Result<BillStageOutput, ToolError>> {
      if (!input.fields) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for stage_bill' }));
      }
      if (!deps.staging) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'Bill staging is not configured on this deployment.' }));
      }

      const billFields = input.fields;
      input.onProgress?.('Checking the draft bill...');
      const organization = await chooseOrganization(deps.booksClient, input);
      if (!organization) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'upstream_failure',
          message: 'Divo could not determine which Zoho organisation should own this bill.',
        }));
      }
      const destinationOrganizationId = input.organizationId ?? organization?.organizationId;
      const vendorId = text(billFields, 'vendor_id');
      const vendor = vendorId
        ? await getContact(deps.booksClient, input, vendorId, destinationOrganizationId)
        : undefined;
      const billNumber = text(billFields, 'bill_number');
      const duplicateLookup = billNumber
        ? await deps.booksClient.listRecords({
          companyId: input.companyId,
          userId: input.userId,
          connectionId: input.connectionId,
          organizationId: destinationOrganizationId,
          moduleName: 'bills',
          filters: { bill_number: billNumber },
          page: 1,
          perPage: 25,
          ...(input.signal ? { signal: input.signal } : {}),
        }).then(result => ({ ran: true, items: result.items }))
          .catch(() => ({ ran: false, items: [] as Record<string, unknown>[] }))
        : { ran: true, items: [] as Record<string, unknown>[] };

      const findings = checkBill({
        bill: billFields,
        sameNumberBills: duplicateLookup.items.filter(item =>
          text(item, 'bill_number').replace(/\s+/g, '').toLowerCase()
          === billNumber.replace(/\s+/g, '').toLowerCase()),
        duplicateCheckUnavailable: !duplicateLookup.ran,
      });
      if (vendorId && !vendor) {
        findings.push({ code: 'vendor_not_found', severity: 'blocking', message: `Vendor ${vendorId} could not be verified in this Zoho organisation.` });
      }
      const selfDealing = refuseSelfDealing({
        organization,
        party: {
          name: vendor ? text(vendor, 'contact_name', 'company_name') : text(billFields, 'vendor_name'),
          gstNo: vendor ? text(vendor, 'gst_no') : text(billFields, 'gst_no'),
        },
        role: 'vendor',
        act: 'Recording this bill',
      });
      if (selfDealing) findings.push({ code: 'self_dealing', severity: 'blocking', message: selfDealing });

      const summary = renderStagedBill({
        payload: billFields,
        ...(vendor ? { vendorName: text(vendor, 'contact_name', 'company_name') } : {}),
        ...(input.fileName ? { attachFileName: input.fileName } : {}),
      });
      const stagingId = randomUUID();
      await deps.staging.put({
        stagingId,
        companyId: input.companyId,
        userId: input.userId,
        connectionId: input.connectionId,
        organizationId: destinationOrganizationId,
        payload: billFields,
        summary,
        findings,
        ...(input.fileName ? { attachFileName: input.fileName } : {}),
        expiresAt: new Date(input.now.getTime() + STAGED_BILL_TTL_MS),
      });
      const blocked = hasBlockingBillFinding(findings);
      return ok({
        success: !blocked,
        stagingId,
        stagedSummary: summary,
        message: blocked
          ? `This bill draft is not ready: ${findings.filter(item => item.severity === 'blocking').map(item => item.message).join(' ')} Nothing has been created.`
          : `Draft ready - nothing has been created or paid. Show stagedSummary exactly, obtain confirmation, then call create_bill with stagingId "${stagingId}".`,
      });
    },

    async create(input: CallContext & {
      stagingId?: string;
      attach?: (billId: string, fileName: string, organizationId: string) => Promise<AttachmentResult>;
    }): Promise<Result<BillCreateOutput, ToolError>> {
      if (!input.stagingId) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'create_bill needs a stagingId from stage_bill.' }));
      }
      if (!deps.staging) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'Bill staging is not configured.' }));
      }
      const staged = await deps.staging.get({ stagingId: input.stagingId, companyId: input.companyId, userId: input.userId });
      if (!staged || staged.expiresAt.getTime() <= input.now.getTime()) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'That bill draft is unknown or expired. Stage it again.' }));
      }
      if (hasBlockingBillFinding(staged.findings)) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'That bill draft failed validation and cannot be created.' }));
      }
      if (staged.connectionId !== input.connectionId || (input.organizationId && input.organizationId !== staged.organizationId)) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'bad_args',
          message: 'This draft was prepared for a different Zoho account or organisation. Use the staged destination or stage it again.',
        }));
      }
      const unresolved = await deps.staging.findUnresolved({ companyId: input.companyId, connectionId: staged.connectionId });
      if (unresolved.some(earlier => earlier.stagingId !== staged.stagingId && sameBillDraft(earlier, staged.payload))) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'upstream_failure',
          message: 'An earlier attempt at this same bill never reported a certain result. Divo will not create another; check Zoho first.',
        }));
      }

      const marker = `${BILL_CLAIM_PENDING}${input.correlationId}`;
      const claim = await deps.staging.claim({ stagingId: staged.stagingId, companyId: input.companyId, marker });
      if (!claim.claimed) {
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'bad_args',
          message: claim.heldBy?.startsWith(BILL_CLAIM_UNRESOLVED)
            ? 'The earlier create lost its response, so this bill may already exist. Check Zoho; this draft will not be sent again.'
            : claim.heldBy?.startsWith(BILL_CLAIM_PENDING)
              ? 'This bill is already being created. It will not be sent twice.'
              : `This draft was already created as bill ${claim.heldBy ?? 'unknown'}.`,
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

      let record: Record<string, unknown>;
      let summary: ZohoWriteSummary;
      try {
        const written = await writer.writeRecord({
          module: 'bills',
          verb: 'created',
          method: 'POST',
          path: '/bills',
          body: staged.payload,
        });
        record = written.record;
        summary = written.summary;
      } catch (error) {
        const failure = classifyZohoBooksWriteFailure(error, { receivedObject: 'the bill' });
        if (failure.kind !== 'unknown') {
          await deps.staging.release({ stagingId: staged.stagingId, companyId: input.companyId, marker });
          return err(new ToolError({
            toolId: 'zohoBooks',
            reason: 'upstream_failure',
            cause: error,
            message: mapZohoError(error),
          }));
        }
        await deps.staging.markUnresolved({
          stagingId: staged.stagingId,
          companyId: input.companyId,
          marker,
          unresolved: `${BILL_CLAIM_UNRESOLVED}${input.correlationId}`,
        });
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'upstream_failure',
          cause: error,
          message: `${mapZohoError(error)} The request may have reached Zoho, so Divo will not retry it. Check bills before staging another.`,
        }));
      }

      if (!summary.id) {
        await deps.staging.markUnresolved({
          stagingId: staged.stagingId,
          companyId: input.companyId,
          marker,
          unresolved: `${BILL_CLAIM_UNRESOLVED}${input.correlationId}`,
        });
        return err(new ToolError({
          toolId: 'zohoBooks',
          reason: 'upstream_failure',
          message: 'Zoho accepted the bill but returned no bill_id. Check Zoho before trying again.',
        }));
      }
      await deps.staging.settle({ stagingId: staged.stagingId, companyId: input.companyId, billId: summary.id });

      let attachmentNote = '';
      if (staged.attachFileName && input.attach) {
        const outcome = await input.attach(summary.id, staged.attachFileName, staged.organizationId);
        attachmentNote = outcome.outcome === 'attached'
          ? ` ${outcome.message}`
          : ` The bill exists, but its attachment is ${outcome.outcome}: ${outcome.message}`;
      }
      return ok({
        record,
        summary,
        message: `${summary.message}${attachmentNote}`.trim(),
      });
    },
  };
}
