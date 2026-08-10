import {
  GOOGLE_WORKSPACE_PRODUCTS,
  type GoogleWorkspaceProductDefinition,
} from '../google/google-workspace-mcp-manifest';
import type { ResolveGoogleWorkspaceMcpConnection } from '../tools/families/google-workspace-mcp.tool';
import type {
  WorkContractBootstrapPort,
  WorkContractBootstrapResult,
  WorkNativeContract,
} from './work-contract-bootstrap.port';

const PRODUCT_BY_TOOL_ID = new Map<string, GoogleWorkspaceProductDefinition>(
  GOOGLE_WORKSPACE_PRODUCTS.map(product => [product.toolId, product]),
);

/**
 * Preloads the small set of native Google schemas a resolved workflow is
 * likely to use. The OAuth connection is used only to authenticate the pinned
 * schema catalogue load; it is not selected for later data access.
 */
export class GoogleWorkspaceContractBootstrapService implements WorkContractBootstrapPort {
  constructor(
    private readonly resolveConnection: ResolveGoogleWorkspaceMcpConnection,
  ) {}

  async load(input: Parameters<WorkContractBootstrapPort['load']>[0]): Promise<WorkContractBootstrapResult> {
    input.abortSignal?.throwIfAborted();
    const requested = suggestedGoogleWorkspaceNativeTools(input.query, input.toolIds);
    if (requested.length === 0) {
      return { contracts: [], unavailableNativeTools: [] };
    }

    const schemaConnection = input.connections.find(connection =>
      connection.provider === 'google_workspace',
    );
    if (!schemaConnection) {
      return {
        contracts: [],
        unavailableNativeTools: requested.map(item => item.nativeTool),
      };
    }

    let resolution: Awaited<ReturnType<ResolveGoogleWorkspaceMcpConnection>>;
    try {
      resolution = await this.resolveConnection({
        companyId: input.member.companyId,
        userId: input.member.userId,
        connectionId: schemaConnection.connectionId,
        minimumAccess: 'read_only',
        requiredScopeGroups: [],
        markLastUsed: false,
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
      input.abortSignal?.throwIfAborted();
    } catch {
      input.abortSignal?.throwIfAborted();
      return {
        contracts: [],
        unavailableNativeTools: requested.map(item => item.nativeTool),
      };
    }
    if (resolution.status !== 'resolved') {
      return {
        contracts: [],
        unavailableNativeTools: requested.map(item => item.nativeTool),
      };
    }

    const contracts: WorkNativeContract[] = [];
    const unavailableNativeTools: string[] = [];
    for (const item of requested) {
      let description;
      try {
        description = await resolution.connection.client.describeTool(
          item.nativeTool,
          input.abortSignal,
        );
        input.abortSignal?.throwIfAborted();
      } catch {
        input.abortSignal?.throwIfAborted();
        unavailableNativeTools.push(item.nativeTool);
        continue;
      }
      if (!description) {
        unavailableNativeTools.push(item.nativeTool);
        continue;
      }
      contracts.push({
        toolId: item.toolId,
        nativeTool: description.name,
        ...(description.description ? { description: description.description } : {}),
        inputSchema: description.inputSchema,
      });
    }
    return { contracts, unavailableNativeTools };
  }
}

export function suggestedGoogleWorkspaceNativeTools(
  query: string,
  toolIds: readonly string[],
): Array<{ toolId: string; nativeTool: string }> {
  const normalized = query.toLowerCase();
  const selected = new Set(toolIds);
  const suggestions: Array<{ toolId: string; nativeTool: string }> = [];

  for (const toolId of selected) {
    const product = PRODUCT_BY_TOOL_ID.get(toolId);
    if (!product) continue;
    for (const nativeTool of suggestedProductOperations(product, normalized)) {
      suggestions.push({ toolId, nativeTool });
    }
  }
  return suggestions;
}

function suggestedProductOperations(
  product: GoogleWorkspaceProductDefinition,
  query: string,
): readonly string[] {
  const isDataMovement = containsAny(query, [
    'copy',
    'move',
    'transfer',
    'import',
    'save',
    'sync',
  ]);

  if (product.service === 'gmail') {
    const operations = ['search_gmail_messages'];
    if (
      isDataMovement
      || containsAny(query, ['analy', 'extract', 'summar', 'deduplic', 'group', 'export', 'sheet', 'record'])
    ) {
      operations.push('get_gmail_messages_content_batch');
    }
    return operations;
  }

  if (product.service === 'sheets') {
    const operations: string[] = [];
    const targetsGoogleSheets = containsAny(query, [
      'google sheet',
      'google sheets',
      'spreadsheet',
    ]) || /\bsheets?\b/.test(query);
    const targetsExistingSheet = containsAny(query, [
      'existing google sheet',
      'existing sheet',
      'existing spreadsheet',
      'spreadsheet id',
      'sheet id',
    ]);
    if (
      containsAny(query, ['create', 'new sheet', 'new spreadsheet', 'export'])
      || (isDataMovement && targetsGoogleSheets && !targetsExistingSheet)
    ) {
      operations.push('create_spreadsheet');
    }
    if (containsAny(query, ['tab', 'worksheet'])) operations.push('create_sheet');
    if (
      (isDataMovement && targetsGoogleSheets)
      || containsAny(query, ['write', 'populate', 'add', 'export', 'record', 'row'])
    ) {
      operations.push('modify_sheet_values');
    }
    const formatsSheet = containsAny(query, [
      'format',
      'bold',
      'center',
      'align',
      'style',
      'tidy',
      'beautif',
      'header',
    ]);
    if (formatsSheet) {
      operations.push('format_sheet_range');
    }
    if (
      formatsSheet
      || containsAny(query, ['resize', 'width', 'height', 'freeze', 'frozen', 'hide column', 'hide row'])
    ) {
      operations.push('resize_sheet_dimensions');
    }
    if (containsAny(query, ['conditional format', 'alternat', 'banded', 'shade'])) {
      operations.push('manage_conditional_formatting');
    }
    if (containsAny(query, ['verify', 'read back', 'reconcile', 'check'])) {
      operations.push('read_sheet_values');
    }
    return operations.length > 0 ? operations : ['read_sheet_values'];
  }

  return [];
}

function containsAny(value: string, needles: readonly string[]): boolean {
  return needles.some(needle => value.includes(needle));
}
