import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  AirtableMcpPort,
  AirtableMcpToolDescription,
} from '../../application/tools/families/airtable-mcp.tool';
import type { AirtableMcpSchemaCatalog } from './airtable-mcp-schema.catalog';
import { AIRTABLE_MCP_AUTH_CONTRACT } from '../../application/airtable/airtable-mcp-manifest';
import { findForbiddenProviderInputPath } from '../../shared/provider-schema-safety';

export const AIRTABLE_MCP_DEFAULT_URL = 'https://mcp.airtable.com/mcp';

const AIRTABLE_MCP_TOOL_PAGE_LIMIT = 1_000;
const AIRTABLE_BASE_PREVIEW_MAX_BYTES = 24_000;

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

  async describeTool(
    name: string,
    options: { readonly waitForProvider?: boolean } = {},
  ): Promise<AirtableMcpToolDescription | null> {
    return this.schemas.describe(name, () => this.listTools(), options);
  }

  async callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal; readonly maxTotalTimeoutMs?: number },
  ): Promise<unknown> {
    assertSafeAirtableMcpInput(input);
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

  private async listTools(): Promise<readonly AirtableMcpToolDescription[]> {
    return this.withClient(async (client) => {
      const collected: AirtableMcpToolDescription[] = [];
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (let pageIndex = 0; pageIndex < AIRTABLE_MCP_TOOL_PAGE_LIMIT; pageIndex += 1) {
        const page = await client.listTools(cursor ? { cursor } : {});
        for (const tool of page.tools) {
          collected.push({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema,
          });
        }
        const nextCursor = page.nextCursor?.trim() || undefined;
        if (!nextCursor) return collected;
        if (seenCursors.has(nextCursor)) {
          throw new Error('Airtable MCP tool list pagination repeated a cursor');
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      throw new Error(`Airtable MCP tool list pagination exceeded ${AIRTABLE_MCP_TOOL_PAGE_LIMIT} pages`);
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

export function assertSafeAirtableMcpInput(value: unknown): void {
  const forbiddenPath = findForbiddenProviderInputPath(value, [
    ...AIRTABLE_MCP_AUTH_CONTRACT.forbiddenToolArguments,
    ...AIRTABLE_MCP_AUTH_CONTRACT.forbiddenLocalFileArguments,
  ]);
  if (forbiddenPath) {
    throw new Error(
      `${forbiddenPath} is not allowed; Airtable identity and credentials come from the selected backend-owned connection`,
    );
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
  if (name === 'list_bases') return compactListBasesResult(value);
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

function compactListBasesResult(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value['bases'])) return value;

  const bases = value['bases'].filter(isRecord).map((base, index) => ({
    index,
    base: {
      ...(typeof base['id'] === 'string' ? { id: base['id'] } : {}),
      ...(typeof base['name'] === 'string' ? { name: base['name'] } : {}),
      ...(typeof base['permissionLevel'] === 'string' ? { permissionLevel: base['permissionLevel'] } : {}),
      ...(typeof base['isFavorite'] === 'boolean' ? { isFavorite: base['isFavorite'] } : {}),
      ...(typeof base['recentlyViewedTimestamp'] === 'string'
        ? { recentlyViewedTimestamp: base['recentlyViewedTimestamp'] }
        : {}),
    },
  }));
  const preferred = [
    ...bases.filter(candidate => candidate.base['isFavorite'] === true),
    ...bases.filter(candidate => candidate.base['isFavorite'] !== true),
  ];
  const included = new Set<number>();
  const fixed = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'bases'));
  for (const candidate of preferred) {
    const next = bases
      .filter(item => included.has(item.index) || item.index === candidate.index)
      .map(item => item.base);
    if (Buffer.byteLength(JSON.stringify({ ...fixed, bases: next }), 'utf8') > AIRTABLE_BASE_PREVIEW_MAX_BYTES) continue;
    included.add(candidate.index);
  }

  const selected = bases
    .filter(candidate => included.has(candidate.index))
    .map(candidate => candidate.base);
  const favoriteIndexes = bases
    .filter(candidate => candidate.base['isFavorite'] === true)
    .map(candidate => candidate.index);
  return {
    ...fixed,
    bases: selected,
    divoBasePreview: {
      totalCount: bases.length,
      returnedCount: selected.length,
      omittedCount: bases.length - selected.length,
      truncated: selected.length !== bases.length,
      favoritesComplete: favoriteIndexes.every(index => included.has(index)),
    },
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
