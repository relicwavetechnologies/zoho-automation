import {
  GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT,
  GOOGLE_WORKSPACE_NATIVE_TOOLS,
  GOOGLE_WORKSPACE_MCP_SOURCE,
} from '../../application/google/google-workspace-mcp-manifest';
import type { GoogleWorkspaceMcpToolDescription } from '../../application/tools/families/google-workspace-mcp.tool';
import {
  ProviderSchemaArtifactCatalogue,
  type ProviderSchemaDescribeOptions,
  type ProviderSchemaArtifactLogger,
  type ProviderSchemaArtifactStore,
} from '../../application/gateway/provider-schema-artifact-catalogue';
import { sanitizeProviderSchemaTool } from '../../shared/provider-schema-safety';

const REVIEWED_NATIVE_TOOLS = new Set<string>(GOOGLE_WORKSPACE_NATIVE_TOOLS);
const GOOGLE_SCHEMA_PROJECTION_REVISION = [
  GOOGLE_WORKSPACE_MCP_SOURCE.version,
  GOOGLE_WORKSPACE_MCP_SOURCE.commit,
  'sanitizer-v2',
].join(':');

/**
 * Process-level schema catalogue for the pinned private MCP sidecar.
 *
 * Native tool schemas are server contract data and do not contain account
 * data. One successful authenticated load is therefore shared across Divo
 * connections. Actual calls still create an authenticated transport using the
 * selected connection token.
 */
export class GoogleWorkspaceMcpSchemaCatalog {
  private readonly catalogue: ProviderSchemaArtifactCatalogue<GoogleWorkspaceMcpToolDescription>;

  constructor(options: {
    readonly store?: ProviderSchemaArtifactStore;
    readonly logger?: ProviderSchemaArtifactLogger;
    readonly partitionKey?: string;
    readonly now?: () => number;
    readonly ttlMs?: number;
  } = {}) {
    this.catalogue = new ProviderSchemaArtifactCatalogue({
      provider: 'google_workspace',
      partitionKey: options.partitionKey ?? 'reviewed-global',
      projectionRevision: GOOGLE_SCHEMA_PROJECTION_REVISION,
      approvedNames: REVIEWED_NATIVE_TOOLS,
      project: sanitizeGoogleWorkspaceMcpToolDescription,
      ...(options.store ? { store: options.store } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    });
  }

  async describe(
    name: string,
    loadAll: () => Promise<readonly GoogleWorkspaceMcpToolDescription[]>,
    options: ProviderSchemaDescribeOptions = {},
  ): Promise<GoogleWorkspaceMcpToolDescription | null> {
    return this.catalogue.describe(name, loadAll, options);
  }

  invalidate(): void {
    this.catalogue.invalidate();
  }
}

const FORBIDDEN_SCHEMA_PROPERTIES = new Set<string>([
  ...GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT.forbiddenToolArguments,
  ...GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT.forbiddenLocalFileArguments,
]);

/** Produce the exact model-facing schema enforced by the Divo boundary. */
export function sanitizeGoogleWorkspaceMcpToolDescription(
  tool: GoogleWorkspaceMcpToolDescription,
): GoogleWorkspaceMcpToolDescription {
  return sanitizeProviderSchemaTool(tool, {
    forbiddenProperties: [...FORBIDDEN_SCHEMA_PROPERTIES],
    appendedDescription: [
      'Divo supplies Google identity from the selected OAuth connection.',
      'Use inline/base64 content or an HTTPS URL; sidecar-local files are unavailable.',
    ],
  });
}
