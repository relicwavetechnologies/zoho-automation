import { randomUUID } from 'node:crypto';
import type { ZohoBooksPaginatedClient, ZohoBooksOrganization } from '../../infrastructure/zoho/zoho-books-paginated.client';
import { ToolError } from '../../shared/errors';
import type { Result } from '../../shared/result';
import { err, ok } from '../../shared/result';
import { mapZohoError } from './zoho-error.utils';
import { refuseSelfDealing } from './zoho-self-dealing';
import { unwrapZohoRecord, type ZohoWriteSummary } from './zoho-books-write-result';
import {
  classifyZohoBooksWriteFailure,
  createZohoBooksWriteRunner,
} from './zoho-books-write';
import {
  checkPurchaseOrder,
  hasBlockingPurchaseOrderFinding,
  PURCHASE_ORDER_CLAIM_PENDING,
  PURCHASE_ORDER_CLAIM_UNRESOLVED,
  renderStagedPurchaseOrder,
  samePurchaseOrderDraft,
  STAGED_PURCHASE_ORDER_TTL_MS,
  type StagedPurchaseOrderStore,
} from './zoho-purchase-order-staging';

export interface PurchaseOrderStageOutput {
  readonly success: boolean;
  readonly stagingId: string;
  readonly stagedSummary: string;
  readonly message: string;
}

export interface PurchaseOrderCreateOutput {
  readonly id: string;
  readonly record: Record<string, unknown>;
  readonly message: string;
  readonly recordUrl?: string;
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

const connectionAuth = (input: CallContext) => ({
  userId: input.userId,
  connectionId: input.connectionId,
  ...(input.signal ? { signal: input.signal } : {}),
});

async function chooseOrganization(
  booksClient: ZohoBooksPaginatedClient,
  input: CallContext,
): Promise<ZohoBooksOrganization | undefined> {
  const organizations = await booksClient.listOrganizations(input.companyId, connectionAuth(input)).catch(() => []);
  return input.organizationId
    ? organizations.find(item => item.organizationId === input.organizationId)
    : (organizations.find(item => item.isDefault === true) ?? organizations[0]);
}

async function getRecord(
  booksClient: ZohoBooksPaginatedClient,
  input: CallContext,
  module: 'contacts' | 'purchaseorders',
  id: string,
  organizationId: string,
): Promise<Record<string, unknown>> {
  const payload = await booksClient.getEndpoint({
    companyId: input.companyId,
    ...connectionAuth(input),
    organizationId,
    path: `/${module}/${encodeURIComponent(id)}`,
  });
  return unwrapZohoRecord(payload, module);
}

export function createZohoPurchaseOrderService(deps: {
  booksClient: ZohoBooksPaginatedClient;
  staging?: StagedPurchaseOrderStore;
  appBaseUrl: string;
}) {
  return {
    async stage(
      input: CallContext & { fields?: Record<string, unknown>; fileName?: string },
    ): Promise<Result<PurchaseOrderStageOutput, ToolError>> {
      if (!input.fields) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'fields required for stage_purchase_order' }));
      }
      if (!deps.staging) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'Purchase-order staging is not configured on this deployment.' }));
      }
      const payload = { ...input.fields };
      input.onProgress?.('Checking the draft purchase order…');
      const organization = await chooseOrganization(deps.booksClient, input);
      if (!organization) {
        return err(new ToolError({
          toolId: 'zohoBooks', reason: 'upstream_failure',
          message: 'Divo could not determine which Zoho organisation should own this purchase order.',
        }));
      }

      const vendorId = text(payload, 'vendor_id');
      const vendor = vendorId
        ? await getRecord(deps.booksClient, input, 'contacts', vendorId, organization.organizationId).catch(() => undefined)
        : undefined;
      const poNumber = text(payload, 'purchaseorder_number');
      const referenceNumber = text(payload, 'reference_number');
      const lookupPurchaseOrders = (search: { filters?: Record<string, unknown>; query?: string }) =>
        deps.booksClient.listRecords({
            companyId: input.companyId,
            ...connectionAuth(input),
            organizationId: organization.organizationId,
            moduleName: 'purchaseorders',
            ...(search.filters ? { filters: search.filters } : {}),
            ...(search.query ? { query: search.query } : {}),
            page: 1,
            perPage: 200,
          }).then(result => ({ ran: true, items: result.items }))
          .catch(() => ({ ran: false, items: [] as Record<string, unknown>[] }));
      const [numberLookup, referenceLookup] = await Promise.all([
        poNumber
          ? lookupPurchaseOrders({ filters: { purchaseorder_number: poNumber } })
          : Promise.resolve({ ran: true, items: [] as Record<string, unknown>[] }),
        referenceNumber
          ? lookupPurchaseOrders({ query: referenceNumber })
          : Promise.resolve({ ran: true, items: [] as Record<string, unknown>[] }),
      ]);

      const findings = checkPurchaseOrder({
        purchaseOrder: payload,
        sameNumberPurchaseOrders: numberLookup.items.filter(item =>
          text(item, 'purchaseorder_number').toLowerCase() === poNumber.toLowerCase()),
        sameReferencePurchaseOrders: referenceLookup.items.filter(item =>
          text(item, 'reference_number').toLowerCase() === referenceNumber.toLowerCase()),
        numberCheckUnavailable: !numberLookup.ran,
        referenceCheckUnavailable: !referenceLookup.ran,
      });
      if (vendorId && !vendor) {
        findings.push({ code: 'vendor_not_found', severity: 'blocking', message: `Vendor ${vendorId} could not be verified in this Zoho organisation.` });
      }
      const refusal = refuseSelfDealing({
        organization,
        party: {
          name: vendor ? text(vendor, 'contact_name', 'company_name') : text(payload, 'vendor_name'),
          gstNo: vendor ? text(vendor, 'gst_no') : text(payload, 'gst_no'),
        },
        role: 'vendor',
        act: 'Creating this purchase order',
      });
      if (refusal) findings.push({ code: 'self_dealing', severity: 'blocking', message: refusal });

      const stagedSummary = renderStagedPurchaseOrder({
        payload,
        ...(vendor ? { vendorName: text(vendor, 'contact_name', 'company_name') } : {}),
        ...(input.fileName ? { attachFileName: input.fileName } : {}),
      });
      const stagingId = randomUUID();
      await deps.staging.put({
        stagingId,
        companyId: input.companyId,
        userId: input.userId,
        connectionId: input.connectionId,
        organizationId: organization.organizationId,
        payload,
        summary: stagedSummary,
        findings,
        ...(input.fileName ? { attachFileName: input.fileName } : {}),
        expiresAt: new Date(input.now.getTime() + STAGED_PURCHASE_ORDER_TTL_MS),
      });
      const blocked = hasBlockingPurchaseOrderFinding(findings);
      return ok({
        success: !blocked,
        stagingId,
        stagedSummary,
        message: blocked
          ? `This purchase-order draft is not ready: ${findings.filter(item => item.severity === 'blocking').map(item => item.message).join(' ')} Nothing has been created.`
          : `Draft ready — nothing has been created or sent. Show stagedSummary exactly, obtain confirmation, then call create_purchase_order with stagingId "${stagingId}".`,
      });
    },

    async create(
      input: CallContext & {
        stagingId?: string;
        attach?: (purchaseOrderId: string, fileName: string, organizationId: string) => Promise<AttachmentResult>;
      },
    ): Promise<Result<PurchaseOrderCreateOutput, ToolError>> {
      if (!input.stagingId) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'create_purchase_order needs a stagingId from stage_purchase_order.' }));
      }
      if (!deps.staging) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'Purchase-order staging is not configured.' }));
      }
      const staged = await deps.staging.get({ stagingId: input.stagingId, companyId: input.companyId, userId: input.userId });
      if (!staged || staged.expiresAt.getTime() <= input.now.getTime()) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'That purchase-order draft is unknown or expired. Stage it again.' }));
      }
      if (hasBlockingPurchaseOrderFinding(staged.findings)) {
        return err(new ToolError({ toolId: 'zohoBooks', reason: 'bad_args', message: 'That purchase-order draft failed validation and cannot be created.' }));
      }
      if (staged.connectionId !== input.connectionId || (input.organizationId && input.organizationId !== staged.organizationId)) {
        return err(new ToolError({
          toolId: 'zohoBooks', reason: 'bad_args',
          message: 'This draft was prepared for a different Zoho account or organisation. Use the staged destination or stage it again.',
        }));
      }
      const unresolved = await deps.staging.findUnresolved({ companyId: input.companyId, connectionId: staged.connectionId });
      if (unresolved.some(earlier => earlier.stagingId !== staged.stagingId && samePurchaseOrderDraft(earlier, staged.payload))) {
        return err(new ToolError({
          toolId: 'zohoBooks', reason: 'upstream_failure',
          message: 'An earlier attempt at this same purchase order never reported a certain result. Divo will not create another; check Zoho first.',
        }));
      }

      const marker = `${PURCHASE_ORDER_CLAIM_PENDING}${input.correlationId}`;
      const claim = await deps.staging.claim({ stagingId: staged.stagingId, companyId: input.companyId, marker });
      if (!claim.claimed) {
        return err(new ToolError({
          toolId: 'zohoBooks', reason: 'bad_args',
          message: claim.heldBy?.startsWith(PURCHASE_ORDER_CLAIM_UNRESOLVED)
            ? 'The earlier create lost its response, so this purchase order may already exist. Check Zoho; this draft will not be sent again.'
            : claim.heldBy?.startsWith(PURCHASE_ORDER_CLAIM_PENDING)
              ? 'This purchase order is already being created. It will not be sent twice.'
              : `This draft was already created as purchase order ${claim.heldBy ?? 'unknown'}.`,
        }));
      }

      let record: Record<string, unknown>;
      let summary: ZohoWriteSummary;
      const writer = createZohoBooksWriteRunner({
        booksClient: deps.booksClient,
        companyId: input.companyId,
        userId: input.userId,
        connectionId: staged.connectionId,
        organizationId: staged.organizationId,
        ...(input.signal ? { signal: input.signal } : {}),
        appBaseUrl: deps.appBaseUrl,
      });
      try {
        const poNumber = staged.payload['purchaseorder_number'];
        const written = await writer.writeRecord({
          module: 'purchaseorders',
          verb: 'created',
          method: 'POST',
          path: '/purchaseorders',
          ...(typeof poNumber === 'string' && poNumber.trim()
            ? { params: { ignore_auto_number_generation: 'true' } }
            : {}),
          body: staged.payload,
        });
        record = written.record;
        summary = written.summary;
      } catch (error) {
        const failure = classifyZohoBooksWriteFailure(error, { receivedObject: 'the purchase order' });
        if (failure.kind !== 'unknown') {
          await deps.staging.release({ stagingId: staged.stagingId, companyId: input.companyId, marker });
          return err(new ToolError({ toolId: 'zohoBooks', reason: 'upstream_failure', cause: error, message: mapZohoError(error) }));
        }
        await deps.staging.markUnresolved({
          stagingId: staged.stagingId,
          companyId: input.companyId,
          marker,
          unresolved: `${PURCHASE_ORDER_CLAIM_UNRESOLVED}${input.correlationId}`,
        });
        return err(new ToolError({
          toolId: 'zohoBooks', reason: 'upstream_failure', cause: error,
          message: `${mapZohoError(error)} The request may have reached Zoho, so Divo will not retry it. Check purchase orders before staging another.`,
        }));
      }

      if (!summary.id) {
        await deps.staging.markUnresolved({
          stagingId: staged.stagingId,
          companyId: input.companyId,
          marker,
          unresolved: `${PURCHASE_ORDER_CLAIM_UNRESOLVED}${input.correlationId}`,
        });
        return err(new ToolError({
          toolId: 'zohoBooks', reason: 'upstream_failure',
          message: 'Zoho accepted the purchase order but returned no purchaseorder_id. Check Zoho before trying again.',
        }));
      }
      await deps.staging.settle({
        stagingId: staged.stagingId,
        companyId: input.companyId,
        purchaseOrderId: summary.id,
      });

      let attachmentNote = '';
      if (staged.attachFileName && input.attach) {
        const outcome = await input.attach(summary.id, staged.attachFileName, staged.organizationId);
        attachmentNote = outcome.outcome === 'attached'
          ? ` ${outcome.message}`
          : ` The purchase order exists, but its attachment is ${outcome.outcome}: ${outcome.message}`;
      }
      return ok({
        id: summary.id,
        record,
        message: `${summary.message}${attachmentNote}`.trim(),
        ...(summary.recordUrl ? { recordUrl: summary.recordUrl } : {}),
      });
    },
  };
}
