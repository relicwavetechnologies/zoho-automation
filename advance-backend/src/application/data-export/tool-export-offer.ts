import type { Logger } from '../../shared/logger';
import type { DataExportOfferService } from './data-export-offer.service';
import type { DataExportOfferPayload } from './export-offer';

/**
 * What a tool call learned about this run's export after contributing its rows.
 *
 * `withdrawn` is not the same as "no offer". No offer means the run never
 * qualified for one. Withdrawn means an offer existed, this run can no longer
 * represent it honestly, and any button already bound to it must be revoked —
 * otherwise a member clicks an export covering a fraction of the answer above
 * it.
 */
export type ToolExportOffer =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'offered';
      readonly offerId: string;
      readonly partCount: number;
      /** Measured across every contributing call, for copy that states a real number. */
      readonly observedRowCount: number;
    }
  | { readonly kind: 'withdrawn'; readonly reason: string };

export function exportWithdrawalMessage(reason: string): string {
  if (reason === 'shape_mismatch') {
    return 'No export is available for this result because it combines datasets that cannot share one file. Ask for one dataset at a time.';
  }
  return 'No export is available for this result because Divo could not safely prepare one. Ask Divo to rerun the single dataset you want to export.';
}

export interface ToolExportOfferInput {
  readonly offers: Pick<DataExportOfferService, 'appendAuthorizedPart'> | undefined;
  /** Every gate the caller already evaluated: channel, chat, RBAC, row count. */
  readonly eligible: boolean;
  readonly payload: () => DataExportOfferPayload;
  /** Rows this tool call actually returned, so the offer can state a measured total. */
  readonly observedRowCount: number;
  /**
   * Human title for the combined dataset once a run contributes more than one
   * call. Without it a 22-domain export is titled after whichever domain
   * happened to be looked up first.
   */
  readonly collectionTitle: string;
  readonly logger: Logger;
  readonly scope: string;
  readonly correlationId: string;
}

/**
 * Contribute one tool call's rows to the single export offer for this run.
 *
 * Every provider tool goes through here so the merge rules, the withdrawal
 * signal, and the failure handling stay identical across vendors.
 */
export async function contributeExportPart(
  input: ToolExportOfferInput,
): Promise<ToolExportOffer> {
  if (!input.eligible || !input.offers) return { kind: 'none' };
  try {
    const result = await input.offers.appendAuthorizedPart(input.payload(), {
      observedRowCount: input.observedRowCount,
      collectionTitle: input.collectionTitle,
    });
    if (result.outcome === 'appended') {
      return {
        kind: 'offered',
        offerId: result.offerId,
        partCount: result.partCount,
        observedRowCount: result.observedRowCount,
      };
    }
    input.logger.info(`${input.scope}.export_offer.withdrawn`, {
      reason: result.reason,
      correlationId: input.correlationId,
    });
    return { kind: 'withdrawn', reason: result.reason };
  } catch (error) {
    // An offer we could not record must not leave an earlier one live: the
    // answer will include rows this run failed to register.
    input.logger.warn(`${input.scope}.export_offer.append_failed`, {
      error: String(error),
      correlationId: input.correlationId,
    });
    return { kind: 'withdrawn', reason: 'append_failed' };
  }
}
