import type { SemrushToolArgs } from '../semrush/semrush.types';
import type { DataExportCandidateRecord } from './export-candidate';
import {
  datasetSourceShapeKey,
  type DataExportSource,
} from './data-export.types';

export interface ExportCandidateListItem {
  readonly candidateId: string;
  readonly label: string;
  readonly previewRowCount: number;
  readonly estimatedRows?: number;
  readonly columns: readonly string[];
  readonly shapeKey: string;
  readonly sourceKind: string;
  readonly argsSummary: string;
  readonly createdAt: string;
}

export function summarizeExportCandidate(
  candidate: DataExportCandidateRecord,
): ExportCandidateListItem {
  const source = candidate.payload.source;
  return {
    candidateId: candidate.id,
    label: exportCandidateLabel(source),
    previewRowCount: candidate.previewRowCount,
    ...(candidate.estimatedRows === undefined ? {} : { estimatedRows: candidate.estimatedRows }),
    columns: candidate.schema?.map(column => column.name) ?? [],
    shapeKey: datasetSourceShapeKey(source),
    sourceKind: candidate.sourceKind,
    argsSummary: exportCandidateArgsSummary(source),
    createdAt: candidate.createdAt.toISOString(),
  };
}

export function exportCandidateLabel(source: DataExportSource): string {
  if (source.kind === 'semrush_snapshot') {
    return semrushExportTitle(source.args);
  }
  if (source.kind === 'oms_snapshot') {
    return `OMS ${source.args.operation}`;
  }
  if (source.kind === 'menhood_query') {
    return 'Menhood query';
  }
  if (source.kind === 'zoho_books') {
    return `Zoho Books ${source.module}`;
  }
  if (source.kind === 'zoho_crm') {
    return `Zoho CRM ${source.module}`;
  }
  if (source.kind === 'airtable_records') {
    const tableId = source.input['tableId'];
    return `Airtable ${typeof tableId === 'string' ? tableId : source.nativeTool}`;
  }
  return 'export';
}

export function exportCandidateArgsSummary(source: DataExportSource): string {
  if (source.kind === 'semrush_snapshot') {
    return semrushArgsSummary(source.args);
  }
  if (source.kind === 'oms_snapshot') {
    return source.args.operation;
  }
  if (source.kind === 'menhood_query') {
    return 'sql';
  }
  if (source.kind === 'zoho_books' || source.kind === 'zoho_crm') {
    return source.module;
  }
  if (source.kind === 'airtable_records') {
    const tableId = source.input['tableId'];
    return typeof tableId === 'string' ? tableId : source.nativeTool;
  }
  return 'export';
}

function semrushExportTitle(args: SemrushToolArgs): string {
  const subject = 'domain' in args
    ? args.domain
    : args.targets.length <= 3
      ? args.targets.join(', ')
      : `${args.targets.slice(0, 2).join(', ')} +${args.targets.length - 2} more`;
  const title = `Semrush ${args.operation.replaceAll('_', ' ')} — ${subject}`;
  return title.length <= 120 ? title : `${title.slice(0, 117)}...`;
}

function semrushArgsSummary(args: SemrushToolArgs): string {
  if ('domain' in args) {
    return args.operation === 'keyword_position_trend'
      ? `${args.operation}: ${args.domain} / ${args.keyword} / ${args.date}`
      : `${args.operation}: ${args.domain}`;
  }
  return `${args.operation}: ${args.targets.join(', ')}`;
}
