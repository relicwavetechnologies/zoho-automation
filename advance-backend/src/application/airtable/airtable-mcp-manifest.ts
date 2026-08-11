import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { CanonicalToolId } from '../../domain/tools/tool-id';

/**
 * Airtable ships a hosted remote MCP server; Divo is only a client. There is no
 * sidecar to run (unlike the private Google Workspace MCP). Interactive tools
 * use MCP because a live `tools/list` capture proved it is a strict superset of Airtable's
 * REST Web API — large cursor pages, a structured filter tree instead of
 * hand-escaped filterByFormula, and interfaces/forms/automations that REST does
 * not expose at all. Divo uses this one MCP contract for both model-facing
 * previews and protected local-file pages; it has no parallel REST export path.
 */
export const AIRTABLE_MCP_SOURCE = Object.freeze({
  server: 'https://mcp.airtable.com/mcp',
  /** Reported by initialize() on the capture this manifest was pinned against. */
  serverInfo: { name: 'airtable-mcp-server', version: '0.0.1' },
  capturedToolCount: 41,
  capturedAt: '2026-07-25',
});

/**
 * Authorization is resolved before any native tool runs. The selected Divo
 * connection's backend-owned bearer (OAuth or PAT) identifies the Airtable
 * user, so identity is never a model argument, and Airtable applies its own
 * token-scope and base-level permissions on top.
 */
export const AIRTABLE_MCP_AUTH_CONTRACT = Object.freeze({
  mode: 'external_bearer' as const,
  identitySource: 'access_token' as const,
  agentGuidance:
    'The selected Divo connection authenticates the request with its backend-owned bearer token. ' +
    'Airtable derives the account from that token and still enforces its own base permissions, ' +
    'so never send identity, token, or API-key fields in native tool input.',
});

/**
 * OAuth scopes the Airtable MCP advertises at
 * /.well-known/oauth-protected-resource. Note the omissions: there is no
 * `webhook:manage` and no automation-specific scope, so webhook management is
 * not reachable through this lane at all, and automation/interface writes ride
 * on schema.bases:write. Airtable remains the final authority — a scope group
 * here narrows what Divo will attempt, never what Airtable will allow.
 */
export const AIRTABLE_SCOPE = Object.freeze({
  recordsRead: 'data.records:read',
  recordsWrite: 'data.records:write',
  commentsRead: 'data.recordComments:read',
  commentsWrite: 'data.recordComments:write',
  schemaRead: 'schema.bases:read',
  schemaWrite: 'schema.bases:write',
  workspacesRead: 'workspacesAndBases:read',
});

/** Requested by OAuth connect. One consent covers every Airtable product tool. */
export const AIRTABLE_REQUESTED_SCOPES: readonly string[] = Object.freeze([
  AIRTABLE_SCOPE.recordsRead,
  AIRTABLE_SCOPE.recordsWrite,
  AIRTABLE_SCOPE.commentsRead,
  AIRTABLE_SCOPE.commentsWrite,
  AIRTABLE_SCOPE.schemaRead,
  AIRTABLE_SCOPE.schemaWrite,
  AIRTABLE_SCOPE.workspacesRead,
]);

export type AirtableService = 'base' | 'records' | 'schema' | 'automation';

export interface AirtableOperationDefinition {
  /** Exact native MCP tool name. This allow-list is the RBAC surface. */
  readonly nativeTool: string;
  readonly action: ToolActionGroup;
  /**
   * Extra action groups this operation may additionally perform depending on
   * its input. Checked by the tool's permissionCheck so an input flag can never
   * quietly buy a capability the caller was not granted.
   */
  readonly escalations?: readonly {
    readonly whenInputPresent: string;
    readonly requires: ToolActionGroup;
  }[];
}

export interface AirtableProductDefinition {
  readonly service: AirtableService;
  readonly toolId: Extract<CanonicalToolId, `airtable${string}`>;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly operations: readonly AirtableOperationDefinition[];
  readonly readScopeGroups: readonly (readonly string[])[];
  readonly writeScopeGroups: readonly (readonly string[])[];
}

/**
 * Read-only discovery. Every product needs these: a records call is impossible
 * without first resolving a baseId and tableId, and they carry no write risk.
 */
const DISCOVERY_OPERATIONS: readonly AirtableOperationDefinition[] = [
  { nativeTool: 'list_bases', action: 'read' },
  { nativeTool: 'list_workspaces', action: 'read' },
  { nativeTool: 'search_bases', action: 'read' },
  { nativeTool: 'list_tables_for_base', action: 'read' },
  { nativeTool: 'list_fields_for_table', action: 'read' },
  { nativeTool: 'get_table_schema', action: 'read' },
  { nativeTool: 'list_views_for_table', action: 'read' },
];

export const AIRTABLE_PRODUCTS: readonly AirtableProductDefinition[] = [
  {
    service: 'base',
    toolId: 'airtableBase',
    name: 'Airtable',
    description:
      'Read governed Airtable bases, table schemas, views, and records through Divo-controlled Airtable MCP.',
    category: 'data',
    operations: [
      ...DISCOVERY_OPERATIONS,
      { nativeTool: 'list_records_for_table', action: 'read' },
      { nativeTool: 'search_records', action: 'read' },
    ],
    readScopeGroups: [
      [AIRTABLE_SCOPE.recordsRead],
      [AIRTABLE_SCOPE.schemaRead],
      [AIRTABLE_SCOPE.workspacesRead],
    ],
    writeScopeGroups: [],
  },
  {
    service: 'records',
    toolId: 'airtableRecords',
    name: 'Airtable Records',
    description:
      'Read, search, create, update, upsert, and delete Airtable records and record comments, and revert an eligible prior write.',
    category: 'data',
    operations: [
      ...DISCOVERY_OPERATIONS,
      { nativeTool: 'list_records_for_table', action: 'read' },
      { nativeTool: 'search_records', action: 'read' },
      { nativeTool: 'list_record_comments', action: 'read' },
      { nativeTool: 'create_record_comment', action: 'create' },
      { nativeTool: 'create_records_for_table', action: 'create' },
      {
        nativeTool: 'update_records_for_table',
        action: 'update',
        // performUpsert inserts rows whose merge values are new, so an
        // update-only caller must not be able to reach it.
        escalations: [{ whenInputPresent: 'performUpsert', requires: 'create' }],
      },
      { nativeTool: 'delete_records_for_table', action: 'delete' },
      // An inverse write: reverting a create removes rows. Gate at the highest
      // privilege it can exercise rather than the one it nominally is.
      { nativeTool: 'revert_action', action: 'delete' },
    ],
    readScopeGroups: [
      [AIRTABLE_SCOPE.recordsRead],
      [AIRTABLE_SCOPE.schemaRead],
    ],
    writeScopeGroups: [[AIRTABLE_SCOPE.recordsWrite]],
  },
  {
    service: 'schema',
    toolId: 'airtableSchema',
    name: 'Airtable Schema',
    description:
      'Inspect and edit the structure of Airtable bases: create bases, tables, and fields, rename or describe them, and delete tables.',
    category: 'data',
    operations: [
      ...DISCOVERY_OPERATIONS,
      { nativeTool: 'create_base', action: 'create' },
      { nativeTool: 'create_table', action: 'create' },
      { nativeTool: 'update_table', action: 'update' },
      { nativeTool: 'delete_table', action: 'delete' },
      { nativeTool: 'create_field', action: 'create' },
      { nativeTool: 'update_field', action: 'update' },
    ],
    readScopeGroups: [
      [AIRTABLE_SCOPE.schemaRead],
      [AIRTABLE_SCOPE.workspacesRead],
    ],
    writeScopeGroups: [[AIRTABLE_SCOPE.schemaWrite]],
  },
  {
    service: 'automation',
    toolId: 'airtableAutomation',
    name: 'Airtable Interfaces & Automations',
    description:
      'Build and inspect Airtable interfaces, pages, and forms, and create, update, or delete base automations. Automations are saved as drafts and must be activated in Airtable.',
    category: 'workflow',
    operations: [
      { nativeTool: 'list_pages_for_base', action: 'read' },
      { nativeTool: 'describe_page_type', action: 'read' },
      { nativeTool: 'describe_page_element', action: 'read' },
      { nativeTool: 'get_form_schema', action: 'read' },
      { nativeTool: 'list_records_for_page', action: 'read' },
      { nativeTool: 'get_record_for_page', action: 'read' },
      { nativeTool: 'search_candidate_linked_records', action: 'read' },
      { nativeTool: 'list_automations', action: 'read' },
      { nativeTool: 'get_automation', action: 'read' },
      { nativeTool: 'get_create_automation_instructions', action: 'read' },
      { nativeTool: 'list_external_accounts', action: 'read' },
      { nativeTool: 'fetch_automation_input_data', action: 'read' },
      { nativeTool: 'create_interface', action: 'create' },
      { nativeTool: 'create_page', action: 'create' },
      { nativeTool: 'delete_page', action: 'delete' },
      { nativeTool: 'submit_form', action: 'create' },
      { nativeTool: 'create_automation', action: 'create' },
      { nativeTool: 'update_automation', action: 'update' },
      { nativeTool: 'delete_automation', action: 'delete' },
      { nativeTool: 'publish_interface', action: 'update' },
    ],
    readScopeGroups: [[AIRTABLE_SCOPE.schemaRead]],
    writeScopeGroups: [[AIRTABLE_SCOPE.schemaWrite]],
  },
];

export const AIRTABLE_TOOL_IDS: readonly string[] = AIRTABLE_PRODUCTS.map(p => p.toolId);

const OPERATIONS_BY_TOOL_ID = new Map<string, ReadonlyMap<string, AirtableOperationDefinition>>(
  AIRTABLE_PRODUCTS.map(product => [
    product.toolId,
    new Map(product.operations.map(operation => [operation.nativeTool, operation])),
  ]),
);

export function airtableOperationFor(
  toolId: string,
  nativeTool: string,
): AirtableOperationDefinition | undefined {
  return OPERATIONS_BY_TOOL_ID.get(toolId)?.get(nativeTool);
}

/**
 * A connection qualifies when it holds at least one scope from every required
 * group. Airtable scopes are flat strings with no broader/narrower implications
 * to expand, unlike Google's.
 */
export function hasAirtableScopeGroups(
  grantedScopes: readonly string[],
  requiredGroups: readonly (readonly string[])[],
): boolean {
  if (requiredGroups.length === 0) return true;
  const granted = new Set(grantedScopes.map(scope => scope.trim()).filter(Boolean));
  return requiredGroups.every(group => group.some(scope => granted.has(scope)));
}

export function airtableScopeGroupsFor(
  product: AirtableProductDefinition,
  action: ToolActionGroup,
): readonly (readonly string[])[] {
  return action === 'read' ? product.readScopeGroups : product.writeScopeGroups;
}
