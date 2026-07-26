import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  AirtableMcpPort,
  AirtableMcpToolDescription,
} from '../../application/orchestration/tools/families/airtable-mcp.tool';
import type { AirtableMcpSchemaCatalog } from './airtable-mcp-schema.catalog';

export const AIRTABLE_MCP_DEFAULT_URL = 'https://mcp.airtable.com/mcp';

/**
 * Thin transport adapter for Airtable's hosted MCP. Which capabilities exist is
 * decided by the Divo manifest, not by this class.
 */
export class AirtableMcpClient implements AirtableMcpPort {
  constructor(
    private readonly accessToken: string,
    private readonly schemas: AirtableMcpSchemaCatalog,
    private readonly mcpUrl = AIRTABLE_MCP_DEFAULT_URL,
  ) {}

  async describeTool(name: string): Promise<AirtableMcpToolDescription | null> {
    return this.schemas.describe(name, () => this.listTools());
  }

  async callTool(name: string, input: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.withClient(client => client.callTool({ name, arguments: { ...input } }));
  }

  private async listTools(): Promise<readonly AirtableMcpToolDescription[]> {
    return this.withClient(async (client) => {
      const collected: AirtableMcpToolDescription[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        for (const tool of page.tools) {
          collected.push({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return collected;
    });
  }

  private async withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'Divo', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${this.accessToken}` } },
    });
    try {
      // SDK v1.29's transport declarations are not exactOptionalPropertyTypes
      // compatible even though its runtime transport implements this contract.
      await client.connect(transport as any);
      return await run(client);
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }
}
