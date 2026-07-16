import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  GoogleWorkspaceMcpPort,
  GoogleWorkspaceMcpToolDescription,
} from '../../application/orchestration/tools/families/google-workspace-mcp.tool';
import { GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT } from '../../application/google/google-workspace-mcp-manifest';
import { GoogleWorkspaceMcpSchemaCatalog } from './google-workspace-mcp-schema.catalog';

export const GOOGLE_WORKSPACE_MCP_DEFAULT_URL = 'http://127.0.0.1:18000/mcp';

/** Authenticated transport to the private Workspace MCP sidecar. */
export class GoogleWorkspaceMcpClient implements GoogleWorkspaceMcpPort {
  constructor(
    private readonly accessToken: string,
    private readonly mcpUrl = GOOGLE_WORKSPACE_MCP_DEFAULT_URL,
    private readonly schemaCatalog = new GoogleWorkspaceMcpSchemaCatalog(),
  ) {}

  async describeTool(name: string): Promise<GoogleWorkspaceMcpToolDescription | null> {
    return this.schemaCatalog.describe(name, () => this.withClient(async (client) => {
      const result = await client.listTools();
      return result.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      }));
    }));
  }

  async callTool(name: string, input: Readonly<Record<string, unknown>>): Promise<unknown> {
    assertSafeGoogleWorkspaceMcpInput(input);
    return this.withClient(async (client) => {
      // The bearer token is the complete identity boundary. Forward the
      // validated native input unchanged so stored account metadata can never
      // override the authenticated principal.
      const result = await client.callTool({ name, arguments: { ...input } });
      const toolResult = result as unknown as {
        readonly isError?: boolean;
        readonly structuredContent?: unknown;
        readonly content?: readonly unknown[];
      };
      if (toolResult.isError) {
        throw new Error(mcpErrorMessage(toolResult.content ?? []));
      }
      return unwrapGoogleWorkspaceMcpResult(toolResult);
    });
  }

  private async withClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'Divo Dex Google Workspace Gateway', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${this.accessToken}` } },
    });
    try {
      await client.connect(transport as any);
      return await operation(client);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }
}

export function unwrapGoogleWorkspaceMcpResult(result: {
  readonly structuredContent?: unknown;
  readonly content?: readonly unknown[];
}): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content ?? [];
  if (content.length === 1) {
    const item = content[0];
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const text = (item as Record<string, unknown>)['text'];
      if (typeof text === 'string') {
        try { return JSON.parse(text) as unknown; } catch { return { text }; }
      }
    }
  }
  return { content };
}

function mcpErrorMessage(content: readonly unknown[]): string {
  const text = content
    .map((item) => item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)['text']
      : undefined)
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .trim();
  return text || 'Google Workspace MCP tool failed';
}

/** Reject sidecar-local filesystem reads; attachments must be base64 or HTTPS. */
export function assertSafeGoogleWorkspaceMcpInput(value: unknown, path = 'input'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeGoogleWorkspaceMcpInput(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if ((GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT.forbiddenToolArguments as readonly string[]).includes(key)) {
      throw new Error(
        `${childPath} is not allowed; Google identity is derived from the selected connection's OAuth bearer token`,
      );
    }
    if ((GOOGLE_WORKSPACE_MCP_AUTH_CONTRACT.forbiddenLocalFileArguments as readonly string[]).includes(key)) {
      throw new Error(`${childPath} is not allowed; provide base64 content or an HTTPS URL`);
    }
    if ((key === 'fileUrl' || key === 'url') && typeof child === 'string' && child.trim().toLowerCase().startsWith('file:')) {
      throw new Error(`${childPath} must not use a file:// URL`);
    }
    assertSafeGoogleWorkspaceMcpInput(child, childPath);
  }
}
