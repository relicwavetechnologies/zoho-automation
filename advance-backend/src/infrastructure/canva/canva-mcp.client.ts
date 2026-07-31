import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const CANVA_MCP_DEFAULT_URL = 'https://mcp.canva.com/mcp';

/** Thin transport adapter. Divo tools decide which Canva capabilities are exposed. */
export class CanvaMcpClient {
  constructor(
    private readonly accessToken: string,
    private readonly mcpUrl = CANVA_MCP_DEFAULT_URL,
  ) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = new Client({ name: 'Divo Dex', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${this.accessToken}` } },
    });
    try {
      // SDK v1.29's transport declarations are not exactOptionalPropertyTypes
      // compatible even though its runtime transport implements this contract.
      await client.connect(transport as any);
      return await client.callTool({ name, arguments: args });
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }
}
