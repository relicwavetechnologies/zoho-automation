import { AIRTABLE_PRODUCTS } from '../../application/airtable/airtable-mcp-manifest';
import type { AirtableMcpToolDescription } from '../../application/tools/families/airtable-mcp.tool';

const APPROVED_NATIVE_TOOLS = new Set<string>(
  AIRTABLE_PRODUCTS.flatMap(product => product.operations.map(operation => operation.nativeTool)),
);

/**
 * Process-level schema catalogue for Airtable's hosted MCP.
 *
 * Native tool schemas are server contract data and contain no account data, so
 * one successful authenticated load is shared across every Divo connection.
 * Real calls still open an authenticated transport with the selected
 * connection's own token.
 */
export class AirtableMcpSchemaCatalog {
  private snapshot: ReadonlyMap<string, AirtableMcpToolDescription> | undefined;
  private loading: Promise<ReadonlyMap<string, AirtableMcpToolDescription>> | undefined;

  async describe(
    name: string,
    loadAll: () => Promise<readonly AirtableMcpToolDescription[]>,
  ): Promise<AirtableMcpToolDescription | null> {
    // An unapproved native tool is never described, so the model cannot learn
    // the shape of an operation the manifest deliberately withheld.
    if (!APPROVED_NATIVE_TOOLS.has(name)) return null;
    const schemas = this.snapshot ?? await this.load(loadAll);
    return schemas.get(name) ?? null;
  }

  invalidate(): void {
    this.snapshot = undefined;
    this.loading = undefined;
  }

  private async load(
    loadAll: () => Promise<readonly AirtableMcpToolDescription[]>,
  ): Promise<ReadonlyMap<string, AirtableMcpToolDescription>> {
    if (this.snapshot) return this.snapshot;
    if (this.loading) return this.loading;

    const pending = loadAll().then((tools) => {
      const approved = new Map<string, AirtableMcpToolDescription>();
      for (const tool of tools) {
        if (!APPROVED_NATIVE_TOOLS.has(tool.name)) continue;
        approved.set(tool.name, tool);
      }
      this.snapshot = approved;
      return approved;
    });
    this.loading = pending;
    try {
      return await pending;
    } finally {
      if (this.loading === pending) this.loading = undefined;
    }
  }
}
