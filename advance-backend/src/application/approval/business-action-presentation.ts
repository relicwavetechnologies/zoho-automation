import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import { AIRTABLE_PRODUCTS } from '../airtable/airtable-mcp-manifest';
import { googleWorkspaceProductByToolId } from '../google/google-workspace-mcp-manifest';

export interface BusinessActionPresentation {
  readonly kind: string;
  readonly provider: string;
  readonly title: string;
  readonly action: ToolActionGroup;
  readonly operation: string;
  readonly details: Record<string, unknown>;
}

/**
 * One channel-neutral description of the exact action being confirmed.
 * Web, Desktop and future channel adapters render this value; none of them
 * reconstruct business meaning from tool arguments independently.
 */
export function describeBusinessAction(
  toolId: string,
  action: ToolActionGroup,
  args: Record<string, unknown>,
): BusinessActionPresentation {
  const googleProduct = googleWorkspaceProductByToolId(toolId);
  const operation = googleProduct && typeof args['nativeTool'] === 'string'
    ? args['nativeTool']
    : typeof args['op'] === 'string'
      ? args['op']
      : typeof args['operation'] === 'string'
        ? args['operation']
        : action;

  if (googleProduct) {
    return {
      kind: `google.${googleProduct.service}.${operation}`,
      provider: 'google',
      title: googleTitle(googleProduct.service, googleProduct.name, operation, action),
      action,
      operation,
      details: pickDefined(args, ['connectionId', 'nativeTool', 'input']),
    };
  }

  const airtableProduct = AIRTABLE_PRODUCTS.find(product => product.toolId === toolId);
  if (airtableProduct) {
    const nativeTool = typeof args['nativeTool'] === 'string' ? args['nativeTool'] : operation;
    return {
      kind: `airtable.${airtableProduct.service}.${nativeTool}`,
      provider: 'airtable',
      title: `Review Airtable ${humanize(nativeTool)}`,
      action,
      operation: nativeTool,
      details: pickDefined(args, ['connectionId', 'nativeTool', 'input']),
    };
  }

  if (toolId === 'zohoCrm') {
    return {
      kind: `zoho.crm.${operation}`,
      provider: 'zoho',
      title: `Review Zoho CRM ${humanize(operation)}`,
      action,
      operation,
      details: pickDefined(args, ['connectionId', 'module', 'recordId', 'fields']),
    };
  }

  if (toolId === 'zohoBooks') {
    return {
      kind: `zoho.books.${operation}`,
      provider: 'zoho',
      title: `Review Zoho Books ${humanize(operation)}`,
      action,
      operation,
      details: cloneJsonRecord(args),
    };
  }

  if (toolId === 'knowledge' && operation === 'propose') {
    const scope = args['scope'] === 'personal'
      ? 'Personal'
      : args['scope'] === 'company'
        ? 'Company'
        : 'Selected department';
    const resource = args['kind'] === 'skill'
      ? 'procedure'
      : args['kind'] === 'file'
        ? 'file'
        : 'memory';
    const rawContent = args['content'];
    const exactContent = args['kind'] === 'file'
      && isRecord(rawContent)
      ? pickDefined(rawContent, ['fileName', 'mimeType', 'sizeBytes', 'sha256'])
      : rawContent ?? null;
    return {
      kind: `knowledge.${String(args['kind'] ?? 'resource')}.${String(args['action'] ?? action)}`,
      provider: 'divo',
      title: `Review ${scope.toLowerCase()} ${resource} change`,
      action,
      operation,
      details: {
        target: scope,
        resource,
        change: args['action'],
        logicalKey: args['logicalKey'],
        ...(args['baseVersion'] === undefined ? {} : { currentVersion: args['baseVersion'] }),
        exactContent,
      },
    };
  }

  return {
    kind: `generic.${toolId}.${operation}`,
    provider: 'generic',
    title: `Review ${humanize(toolId)} ${humanize(operation)}`,
    action,
    operation,
    details: cloneJsonRecord(args),
  };
}

function googleTitle(
  service: string,
  productName: string,
  operation: string,
  action: ToolActionGroup,
): string {
  if (service === 'gmail' && action === 'send') return 'Review email before sending';
  return `Review ${productName} ${humanize(operation)}`;
}

function humanize(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').toLowerCase();
}

function pickDefined(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) selected[key] = cloneJson(source[key]);
  }
  return selected;
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return cloneJson(value) as Record<string, unknown>;
}

function cloneJson(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
