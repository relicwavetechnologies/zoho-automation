import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  AirtableMcpPort,
  AirtableMcpToolDescription,
} from '../../application/tools/families/airtable-mcp.tool';
import type { AirtableMcpSchemaCatalog } from './airtable-mcp-schema.catalog';

export const AIRTABLE_MCP_DEFAULT_URL = 'https://mcp.airtable.com/mcp';

/**
 * Thin transport adapter for Airtable's hosted MCP. Which capabilities exist is
 * decided by the Divo manifest, not by this class.
 */
export class AirtableMcpClient implements AirtableMcpPort {
  private lastRestRequestAt = 0;

  constructor(
    private readonly accessToken: string,
    private readonly schemas: AirtableMcpSchemaCatalog,
    private readonly mcpUrl = AIRTABLE_MCP_DEFAULT_URL,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async describeTool(name: string): Promise<AirtableMcpToolDescription | null> {
    return this.schemas.describe(name, () => this.listTools());
  }

  async callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal; readonly maxTotalTimeoutMs?: number },
  ): Promise<unknown> {
    return this.withClient(async (client) => {
      const result = await client.callTool(
        { name, arguments: { ...input } },
        undefined,
        options
          ? {
              ...(options.signal ? { signal: options.signal } : {}),
              ...(options.maxTotalTimeoutMs !== undefined
                ? { maxTotalTimeout: options.maxTotalTimeoutMs }
                : {}),
            }
          : undefined,
      );
      const toolResult = result as unknown as {
        readonly isError?: boolean;
        readonly structuredContent?: unknown;
        readonly content?: readonly unknown[];
      };
      if (toolResult.isError) {
        throw new Error(mcpErrorMessage(toolResult.content ?? []));
      }
      return compactAirtableMcpResult(name, unwrapAirtableMcpResult(toolResult));
    });
  }

  async listFieldNamesForTable(
    baseId: string,
    tableId: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> {
    return this.withClient(async (client) => {
      const result = await client.callTool(
        { name: 'list_tables_for_base', arguments: { baseId } },
        undefined,
        signal ? { signal } : undefined,
      );
      const value = unwrapAirtableMcpResult(result as {
        readonly structuredContent?: unknown;
        readonly content?: readonly unknown[];
      });
      if (!isRecord(value) || !Array.isArray(value['tables'])) return new Map();
      const table = value['tables'].find(candidate =>
        isRecord(candidate) && (candidate['id'] === tableId || candidate['name'] === tableId));
      if (!isRecord(table) || !Array.isArray(table['fields'])) return new Map();
      return new Map(
        table['fields']
          .filter(isRecord)
          .flatMap(field =>
            typeof field['id'] === 'string' && typeof field['name'] === 'string'
              ? [[field['id'], field['name']] as const]
              : []),
      );
    });
  }

  async listRecordsPage(
    input: {
      readonly baseId: string;
      readonly tableId: string;
      readonly fieldIds?: readonly string[];
      readonly offset?: string;
    },
    signal?: AbortSignal,
  ): Promise<{ readonly records: readonly unknown[]; readonly nextCursor?: string }> {
    const url = new URL(
      `https://api.airtable.com/v0/${encodeURIComponent(input.baseId)}/${encodeURIComponent(input.tableId)}`,
    );
    url.searchParams.set('pageSize', '100');
    if (input.offset) url.searchParams.set('offset', input.offset);
    for (const fieldId of input.fieldIds ?? []) url.searchParams.append('fields[]', fieldId);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const throttleMs = Math.max(0, 210 - (Date.now() - this.lastRestRequestAt));
      if (throttleMs > 0) await abortableDelay(throttleMs, signal);
      this.lastRestRequestAt = Date.now();

      const timeoutSignal = AbortSignal.timeout(30_000);
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
      if (response.ok) {
        const value = await response.json() as unknown;
        if (!isRecord(value) || !Array.isArray(value['records'])) {
          throw new Error('Airtable Web API returned an unexpected record response');
        }
        const offset = typeof value['offset'] === 'string' && value['offset'].trim()
          ? value['offset']
          : undefined;
        return {
          records: value['records'],
          ...(offset ? { nextCursor: offset } : {}),
        };
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await abortableDelay(Number.isFinite(retryAfter) ? retryAfter * 1_000 : 1_000, signal);
        continue;
      }
      throw new Error(`Airtable Web API returned HTTP ${response.status}`);
    }
    throw new Error('Airtable Web API retry limit reached');
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

export function unwrapAirtableMcpResult(result: {
  readonly structuredContent?: unknown;
  readonly content?: readonly unknown[];
}): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content ?? [];
  if (content.length === 1) {
    const item = content[0];
    if (isRecord(item)) {
      const text = item['text'];
      if (typeof text === 'string') {
        try { return JSON.parse(text) as unknown; } catch { return { text }; }
      }
    }
  }
  return { content };
}

/**
 * Airtable's list_tables_for_base payload repeats every field definition even
 * though get_table_schema is the dedicated operation for that detail. Keep the
 * complete table index while replacing nested schemas with honest counts.
 */
export function compactAirtableMcpResult(name: string, value: unknown): unknown {
  if (name !== 'list_tables_for_base' || !isRecord(value) || !Array.isArray(value['tables'])) {
    return value;
  }
  return {
    ...value,
    tables: value['tables'].map((table) => {
      if (!isRecord(table)) return table;
      const fields = Array.isArray(table['fields']) ? table['fields'] : undefined;
      const views = Array.isArray(table['views']) ? table['views'] : undefined;
      const compact = { ...table };
      delete compact['fields'];
      delete compact['views'];
      return {
        ...compact,
        ...(fields ? { fieldCount: fields.length } : {}),
        ...(views ? { viewCount: views.length } : {}),
      };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mcpErrorMessage(content: readonly unknown[]): string {
  const text = content
    .map((item) => isRecord(item) ? item['text'] : undefined)
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .trim();
  return text || 'Airtable MCP tool failed';
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
