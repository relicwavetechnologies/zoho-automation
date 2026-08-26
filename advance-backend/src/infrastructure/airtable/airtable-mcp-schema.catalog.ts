import {
  AIRTABLE_MCP_AUTH_CONTRACT,
  AIRTABLE_MCP_SOURCE,
  AIRTABLE_PRODUCTS,
} from '../../application/airtable/airtable-mcp-manifest';
import type { AirtableMcpToolDescription } from '../../application/tools/families/airtable-mcp.tool';
import {
  ProviderSchemaArtifactCatalogue,
  type ProviderSchemaDescribeOptions,
  type ProviderSchemaArtifactLogger,
  type ProviderSchemaArtifactStore,
} from '../../application/gateway/provider-schema-artifact-catalogue';
import { sanitizeProviderSchemaTool } from '../../shared/provider-schema-safety';

const APPROVED_NATIVE_TOOLS = new Set<string>(
  AIRTABLE_PRODUCTS.flatMap(product => product.operations.map(operation => operation.nativeTool)),
);
const AIRTABLE_SCHEMA_PROJECTION_REVISION = [
  AIRTABLE_MCP_SOURCE.serverInfo.name,
  AIRTABLE_MCP_SOURCE.serverInfo.version,
  AIRTABLE_MCP_SOURCE.capturedAt,
  'projection-v2',
].join(':');
const FORBIDDEN_SCHEMA_PROPERTIES = [
  ...AIRTABLE_MCP_AUTH_CONTRACT.forbiddenToolArguments,
  ...AIRTABLE_MCP_AUTH_CONTRACT.forbiddenLocalFileArguments,
];

/**
 * Process-level schema catalogue for Airtable's hosted MCP.
 *
 * Native tool schemas are server contract data and contain no account data, so
 * one successful authenticated load is shared across every Divo connection.
 * Real calls still open an authenticated transport with the selected
 * connection's own token.
 */
export class AirtableMcpSchemaCatalog {
  private readonly catalogue: ProviderSchemaArtifactCatalogue<AirtableMcpToolDescription>;

  constructor(options: {
    readonly store?: ProviderSchemaArtifactStore;
    readonly logger?: ProviderSchemaArtifactLogger;
    readonly partitionKey?: string;
    readonly now?: () => number;
    readonly ttlMs?: number;
  } = {}) {
    this.catalogue = new ProviderSchemaArtifactCatalogue({
      provider: 'airtable',
      partitionKey: options.partitionKey ?? 'approved-global',
      projectionRevision: AIRTABLE_SCHEMA_PROJECTION_REVISION,
      approvedNames: APPROVED_NATIVE_TOOLS,
      project: sanitizeAirtableMcpToolDescription,
      ...(options.store ? { store: options.store } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    });
  }

  async describe(
    name: string,
    loadAll: () => Promise<readonly AirtableMcpToolDescription[]>,
    options: ProviderSchemaDescribeOptions = {},
  ): Promise<AirtableMcpToolDescription | null> {
    return this.catalogue.describe(name, loadAll, options);
  }

  invalidate(): void {
    this.catalogue.invalidate();
  }
}

/** Produce the exact model-facing Airtable schema enforced at the call seam. */
export function sanitizeAirtableMcpToolDescription(
  tool: AirtableMcpToolDescription,
): AirtableMcpToolDescription {
  return sanitizeProviderSchemaTool(tool, {
    forbiddenProperties: FORBIDDEN_SCHEMA_PROPERTIES,
    appendedDescription: [
      'Divo supplies Airtable identity from the selected backend-owned connection.',
      'Sidecar-local files are unavailable; send ordinary Airtable values only.',
    ],
  });
}
