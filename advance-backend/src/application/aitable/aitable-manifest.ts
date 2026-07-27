import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { CanonicalToolId } from '../../domain/tools/tool-id';

/**
 * What Divo will attempt against AITable, and under which action group.
 *
 * This allow-list is the RBAC surface: an operation absent from it is not
 * callable, whatever the model asks for. Unlike the Airtable manifest — which
 * mirrors a hosted MCP server's tool names — these are Divo's own operation
 * names over the Fusion REST API, because AITable's published MCP server is not
 * used at all (plans/aitable-integration.md §2.1).
 */
export const AITABLE_SOURCE = Object.freeze({
  api: 'Fusion API v1 (v2 for node search)',
  /** Ported from the MIT `apitable` SDK and corroborated by n8n-nodes-vika-aitable. */
  portedFrom: 'github.com/apitable/sdk@1.3.0',
  /**
   * Same API serves aitable.ai, api.apitable.com and self-hosted APITable, so
   * the host is configuration rather than a constant.
   */
  configurableHost: 'AITABLE_BASE_URL',
});

export const AITABLE_AUTH_CONTRACT = Object.freeze({
  mode: 'api_key' as const,
  agentGuidance:
    'The selected Divo connection authenticates the request with its stored AITable API key. ' +
    'AITable applies the key owner\'s own workspace permissions on top of Divo RBAC, ' +
    'so never send a key, token, or identity field in tool input.',
});

export interface AitableOperationDefinition {
  readonly name: string;
  readonly action: ToolActionGroup;
  readonly summary: string;
}

export interface AitableProductDefinition {
  readonly toolId: Extract<CanonicalToolId, `aitable${string}`>;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly operations: readonly AitableOperationDefinition[];
}

/**
 * Read-only discovery every product needs. A record call is impossible without
 * first resolving a space and a datasheet, and none of these can change data.
 */
const DISCOVERY_OPERATIONS: readonly AitableOperationDefinition[] = [
  { name: 'list_spaces', action: 'read', summary: 'List the AITable workspaces this connection can reach.' },
  { name: 'search_nodes', action: 'read', summary: 'Find datasheets, folders, forms and dashboards in a workspace.' },
  { name: 'get_node', action: 'read', summary: 'Read one node\'s details.' },
];

export const AITABLE_PRODUCTS: readonly AitableProductDefinition[] = [
  {
    toolId: 'aitableDatasheets',
    name: 'AITable Datasheets',
    description:
      'Browse AITable workspaces and datasheets, and read, create, update or delete the records inside them.',
    category: 'data',
    operations: [
      ...DISCOVERY_OPERATIONS,
      // Reading the schema belongs to both products. A write is only safe once
      // the caller knows which fields are writable and what each accepts, so
      // withholding it here would have made every granted write a guess — and
      // the skill instructs the model to call it before writing.
      { name: 'get_fields', action: 'read', summary: 'Read the field schema, including which fields are writable.' },
      { name: 'list_views', action: 'read', summary: 'List the views defined on a datasheet.' },
      { name: 'list_records', action: 'read', summary: 'Read records, with optional view, filter, sort and paging.' },
      { name: 'create_records', action: 'create', summary: 'Add records to a datasheet.' },
      { name: 'update_records', action: 'update', summary: 'Change fields on existing records.' },
      { name: 'delete_records', action: 'delete', summary: 'Remove records from a datasheet permanently.' },
    ],
  },
  {
    toolId: 'aitableFields',
    name: 'AITable Fields',
    description:
      'Inspect the field schema of an AITable datasheet, and add or remove fields. Removing a field deletes its data.',
    category: 'data',
    operations: [
      ...DISCOVERY_OPERATIONS,
      { name: 'get_fields', action: 'read', summary: 'Read the field schema, including which fields are writable.' },
      { name: 'create_field', action: 'create', summary: 'Add a field to a datasheet.' },
      // Deliberately no update_field: the Fusion API has no endpoint for it.
      // Declaring one would advertise a capability with nothing behind it.
      { name: 'delete_field', action: 'delete', summary: 'Remove a field and every value stored in it.' },
    ],
  },
];

export const AITABLE_TOOL_IDS: readonly string[] = AITABLE_PRODUCTS.map(product => product.toolId);

const OPERATIONS_BY_TOOL_ID = new Map<string, ReadonlyMap<string, AitableOperationDefinition>>(
  AITABLE_PRODUCTS.map(product => [
    product.toolId,
    new Map(product.operations.map(operation => [operation.name, operation])),
  ]),
);

export function aitableOperationFor(
  toolId: string,
  operation: string,
): AitableOperationDefinition | undefined {
  return OPERATIONS_BY_TOOL_ID.get(toolId)?.get(operation);
}

export function aitableOperationNames(toolId: string): string[] {
  return [...(OPERATIONS_BY_TOOL_ID.get(toolId)?.keys() ?? [])];
}
