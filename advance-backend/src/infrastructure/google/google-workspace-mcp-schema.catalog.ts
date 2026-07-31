import {
  GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT,
  GOOGLE_WORKSPACE_NATIVE_TOOLS,
} from '../../application/google/google-workspace-mcp-manifest';
import type { GoogleWorkspaceMcpToolDescription } from '../../application/tools/families/google-workspace-mcp.tool';

const REVIEWED_NATIVE_TOOLS = new Set<string>(GOOGLE_WORKSPACE_NATIVE_TOOLS);

/**
 * Process-level schema catalogue for the pinned private MCP sidecar.
 *
 * Native tool schemas are server contract data and do not contain account
 * data. One successful authenticated load is therefore shared across Divo
 * connections. Actual calls still create an authenticated transport using the
 * selected connection token.
 */
export class GoogleWorkspaceMcpSchemaCatalog {
  private snapshot: ReadonlyMap<string, GoogleWorkspaceMcpToolDescription> | undefined;
  private loading: Promise<ReadonlyMap<string, GoogleWorkspaceMcpToolDescription>> | undefined;

  async describe(
    name: string,
    loadAll: () => Promise<readonly GoogleWorkspaceMcpToolDescription[]>,
  ): Promise<GoogleWorkspaceMcpToolDescription | null> {
    if (!REVIEWED_NATIVE_TOOLS.has(name)) return null;
    const schemas = this.snapshot ?? await this.load(loadAll);
    return schemas.get(name) ?? null;
  }

  invalidate(): void {
    this.snapshot = undefined;
    this.loading = undefined;
  }

  private async load(
    loadAll: () => Promise<readonly GoogleWorkspaceMcpToolDescription[]>,
  ): Promise<ReadonlyMap<string, GoogleWorkspaceMcpToolDescription>> {
    if (this.snapshot) return this.snapshot;
    if (this.loading) return this.loading;

    const pending = loadAll().then((tools) => {
      const reviewed = new Map<string, GoogleWorkspaceMcpToolDescription>();
      for (const tool of tools) {
        if (!REVIEWED_NATIVE_TOOLS.has(tool.name)) continue;
        reviewed.set(tool.name, sanitizeGoogleWorkspaceMcpToolDescription(tool));
      }
      this.snapshot = reviewed;
      return reviewed;
    });
    this.loading = pending;
    try {
      return await pending;
    } finally {
      if (this.loading === pending) this.loading = undefined;
    }
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
  return {
    ...tool,
    ...(tool.description ? { description: sanitizeDescription(tool.description, true) } : {}),
    inputSchema: sanitizeSchemaNode(tool.inputSchema),
  };
}

function sanitizeSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSchemaNode);
  if (!value || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === 'properties' && child && typeof child === 'object' && !Array.isArray(child)) {
      sanitized[key] = Object.fromEntries(
        Object.entries(child as Record<string, unknown>)
          .filter(([property]) => !FORBIDDEN_SCHEMA_PROPERTIES.has(property))
          .map(([property, schema]) => [property, sanitizeSchemaNode(schema)]),
      );
      continue;
    }
    if (key === 'required' && Array.isArray(child)) {
      sanitized[key] = child.filter((property) =>
        typeof property !== 'string' || !FORBIDDEN_SCHEMA_PROPERTIES.has(property),
      );
      continue;
    }
    if (key === 'description' && typeof child === 'string') {
      sanitized[key] = sanitizeDescription(child, false);
      continue;
    }
    sanitized[key] = sanitizeSchemaNode(child);
  }
  return sanitized;
}

function sanitizeDescription(description: string, appendBoundary: boolean): string {
  const safeSentences = description
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => ![...FORBIDDEN_SCHEMA_PROPERTIES].some((property) =>
      sentence.toLowerCase().includes(property.toLowerCase()),
    ));
  return [
    ...safeSentences,
    ...(appendBoundary ? [
      'Divo supplies Google identity from the selected OAuth connection.',
      'Use inline/base64 content or an HTTPS URL; sidecar-local files are unavailable.',
    ] : []),
  ].join(' ').trim();
}
