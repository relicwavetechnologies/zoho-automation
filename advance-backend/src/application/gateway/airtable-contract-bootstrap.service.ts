import {
  AIRTABLE_RECORD_READ_MAX_ROWS,
  type ResolveAirtableMcpConnection,
} from '../tools/families/airtable-mcp.tool';
import {
  AIRTABLE_PRODUCTS,
  type AirtableProductDefinition,
} from '../airtable/airtable-mcp-manifest';
import type {
  WorkContractBootstrapMode,
  WorkContractBootstrapPort,
  WorkContractBootstrapResult,
} from './work-contract-bootstrap.port';
import { loadWorkNativeContracts } from './work-contract-bootstrap-concurrency';

/** Product tools whose work is reading and writing records, not base structure. */
const RECORD_TOOL_IDS = new Set(['airtableBase', 'airtableRecords']);
const PRODUCT_BY_TOOL_ID = new Map<string, AirtableProductDefinition>(
  AIRTABLE_PRODUCTS.map(product => [product.toolId, product]),
);
const LOCAL_SYNTHETIC_CONTRACTS = new Set(['list_fields_for_table']);

/**
 * Discovery and read contracts every record run needs. `list_records_for_table`
 * is the expensive one and the reason this bootstrap exists: its filter tree is
 * a deeply nested union that no model reconstructs correctly from prose, and
 * each failed guess costs a larger validation dump than the schema itself.
 *
 * `list_fields_for_table` is deliberately absent — it is synthesized by Divo
 * rather than served by Airtable's MCP, so there is nothing to describe.
 */
const RECORD_READ_CONTRACTS: readonly string[] = [
  'search_bases',
  'list_tables_for_base',
  'get_table_schema',
  'list_records_for_table',
];

const SEARCH_TERMS = ['search', 'find', 'look up', 'lookup', 'keyword', 'matching'];

const WRITE_TERMS = [
  'create',
  'add',
  'insert',
  'update',
  'edit',
  'change',
  'set ',
  'mark',
  'upsert',
  'fill',
];

/**
 * Preloads the native Airtable contracts a resolved workflow is about to need.
 *
 * Airtable is a hosted MCP whose schemas are server contract data, so one
 * authenticated load is shared process-wide by AirtableMcpSchemaCatalog. The
 * connection here only authenticates that catalogue load; it is not selected
 * for later data access, and ToolExecutor still resolves the real account.
 */
export class AirtableContractBootstrapService implements WorkContractBootstrapPort {
  constructor(
    private readonly resolveConnection: ResolveAirtableMcpConnection,
  ) {}

  async load(input: Parameters<WorkContractBootstrapPort['load']>[0]): Promise<WorkContractBootstrapResult> {
    input.abortSignal?.throwIfAborted();
    const requested = airtableNativeToolsForMode(
      input.query,
      input.toolIds,
      input.contractMode ?? 'suggested',
    );
    if (requested.length === 0) {
      return { contracts: [], unavailableNativeTools: [] };
    }

    const schemaConnection = input.connections.find(connection => connection.provider === 'airtable');
    if (!schemaConnection) {
      return { contracts: [], unavailableNativeTools: requested.map(item => item.nativeTool) };
    }

    let resolution: Awaited<ReturnType<ResolveAirtableMcpConnection>>;
    try {
      resolution = await this.resolveConnection({
        companyId: input.member.companyId,
        userId: input.member.userId,
        connectionId: schemaConnection.connectionId,
        minimumAccess: 'read_only',
        requiredScopeGroups: [],
      });
      input.abortSignal?.throwIfAborted();
    } catch {
      input.abortSignal?.throwIfAborted();
      return { contracts: [], unavailableNativeTools: requested.map(item => item.nativeTool) };
    }
    if (resolution.status !== 'resolved') {
      return { contracts: [], unavailableNativeTools: requested.map(item => item.nativeTool) };
    }

    return loadWorkNativeContracts(requested, async item => {
      const description = await resolution.connection.client.describeTool(item.nativeTool, {
        waitForProvider: input.contractMode !== 'complete_cached',
      });
      if (!description) return null;
      const boundedDescription = contractDescription(description.name, description.description);
      return {
        toolId: item.toolId,
        nativeTool: description.name,
        ...(boundedDescription ? { description: boundedDescription } : {}),
        inputSchema: boundedRecordReadSchema(description.name, description.inputSchema),
      };
    }, input.abortSignal);
  }
}

function contractDescription(nativeTool: string, description?: string): string | undefined {
  if (!['list_records_for_table', 'search_records'].includes(nativeTool)) return description;
  return [
    description,
    'Divo returns record values under records[].cellValuesByFieldId, the exact filtered count at metadata.totalRecordCount, and continuation at nextCursor when present. Direct calls are previews; use the same call through divo-local for protected file pages.',
  ].filter(Boolean).join(' ');
}

function boundedRecordReadSchema(nativeTool: string, schema: unknown): unknown {
  const limitKey = nativeTool === 'list_records_for_table'
    ? 'pageSize'
    : nativeTool === 'search_records'
      ? 'limit'
      : null;
  if (!limitKey || !isRecord(schema) || !isRecord(schema['properties'])) return schema;
  const limit = schema['properties'][limitKey];
  if (!isRecord(limit)) return schema;
  return {
    ...schema,
    properties: {
      ...schema['properties'],
      [limitKey]: { ...limit, maximum: AIRTABLE_RECORD_READ_MAX_ROWS },
    },
  };
}

/**
 * Read contracts are the default rather than a keyword match. Members ask for
 * Airtable numbers in Hinglish and in wording that carries no read verb at all,
 * and a gate that misses those is exactly how a run ends up guessing the filter
 * shape again. Only the extra write and search contracts are earned by wording.
 */
export function suggestedAirtableNativeTools(
  query: string,
  toolIds: readonly string[],
): Array<{ toolId: string; nativeTool: string }> {
  return airtableNativeToolsForMode(query, toolIds, 'suggested');
}

export function airtableNativeToolsForMode(
  query: string,
  toolIds: readonly string[],
  contractMode: WorkContractBootstrapMode,
): Array<{ toolId: string; nativeTool: string }> {
  if (contractMode !== 'suggested') return completeAirtableNativeTools(toolIds);
  const normalized = query.toLowerCase();
  const suggestions: Array<{ toolId: string; nativeTool: string }> = [];

  for (const toolId of new Set(toolIds)) {
    if (!RECORD_TOOL_IDS.has(toolId)) continue;

    const nativeTools = [...RECORD_READ_CONTRACTS];
    if (containsAny(normalized, SEARCH_TERMS)) nativeTools.push('search_records');
    if (toolId === 'airtableRecords' && containsAny(normalized, WRITE_TERMS)) {
      nativeTools.push('create_records_for_table', 'update_records_for_table');
    }
    for (const nativeTool of nativeTools) suggestions.push({ toolId, nativeTool });
  }
  return suggestions;
}

function completeAirtableNativeTools(
  toolIds: readonly string[],
): Array<{ toolId: string; nativeTool: string }> {
  const suggestions: Array<{ toolId: string; nativeTool: string }> = [];
  for (const toolId of new Set(toolIds)) {
    const product = PRODUCT_BY_TOOL_ID.get(toolId);
    if (!product) continue;
    for (const operation of product.operations) {
      if (LOCAL_SYNTHETIC_CONTRACTS.has(operation.nativeTool)) continue;
      suggestions.push({ toolId, nativeTool: operation.nativeTool });
    }
  }
  return suggestions;
}

function containsAny(value: string, needles: readonly string[]): boolean {
  return needles.some(needle => value.includes(needle));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
