import type { Logger } from '../../shared/logger';
import type { DataExportOrchestrationService } from './data-export-orchestration.service';
import type { DataExportOfferPayload } from './export-offer';
import type { ExportCandidateMetadata } from './export-candidate';

export type ToolExportCandidate =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'published';
      readonly candidateId: string;
      readonly expiresAt: Date;
      readonly estimatedRows?: number;
    };

export interface ToolExportCandidateInput {
  readonly candidates: Pick<DataExportOrchestrationService, 'publishCandidate'> | undefined;
  readonly eligible: boolean;
  readonly payload: () => DataExportOfferPayload;
  readonly metadata: ExportCandidateMetadata;
  readonly logger: Logger;
  readonly scope: string;
  readonly correlationId: string;
}

export async function publishExportCandidate(
  input: ToolExportCandidateInput,
): Promise<ToolExportCandidate> {
  if (!input.eligible || !input.candidates) return { kind: 'none' };
  try {
    const candidate = await input.candidates.publishCandidate(input.payload(), input.metadata);
    return {
      kind: 'published',
      candidateId: candidate.candidateId,
      expiresAt: candidate.expiresAt,
      ...(candidate.estimatedRows === undefined ? {} : { estimatedRows: candidate.estimatedRows }),
    };
  } catch (error) {
    input.logger.warn(`${input.scope}.export_candidate.publish_failed`, {
      error: String(error),
      correlationId: input.correlationId,
    });
    return { kind: 'none' };
  }
}

export function exportCandidateMetadata(input: {
  readonly columns: readonly string[];
  readonly previewRowCount: number;
  readonly estimatedRows?: number | undefined;
  readonly coverage?: unknown;
}): ExportCandidateMetadata {
  return {
    schema: input.columns.map(name => ({ name })),
    previewRowCount: input.previewRowCount,
    ...(input.estimatedRows === undefined ? {} : { estimatedRows: input.estimatedRows }),
    ...(input.coverage === undefined ? {} : { coverage: input.coverage }),
  };
}
