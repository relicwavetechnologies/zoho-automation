import type {
  GoogleWorkspaceMcpPort,
  GoogleWorkspaceMcpToolDescription,
} from '../../application/tools/families/google-workspace-mcp.tool';
import { GoogleSheetsDataValidationClient } from './google-sheets-data-validation.client';
import { compactGmailMcpResult } from './gmail-result-compactor';
import { GoogleWorkspaceMcpClient } from './google-workspace-mcp.client';
import { normalizeGoogleWorkspaceInput } from './google-workspace-input-normalizer';
import { normalizeGoogleWorkspaceResult } from './google-workspace-result-normalizer';

/** Composite governed client: pinned MCP operations plus narrow Divo adapters. */
export class GoogleWorkspaceGatewayClient implements GoogleWorkspaceMcpPort {
  private readonly sheetsDataValidation: GoogleSheetsDataValidationClient;

  constructor(
    accessToken: string,
    private readonly mcp: GoogleWorkspaceMcpClient,
    sheetsDataValidation?: GoogleSheetsDataValidationClient,
  ) {
    this.sheetsDataValidation = sheetsDataValidation ?? new GoogleSheetsDataValidationClient(accessToken);
  }

  async describeTool(
    name: string,
    abortSignal?: AbortSignal,
    options: { readonly waitForProvider?: boolean } = {},
  ): Promise<GoogleWorkspaceMcpToolDescription | null> {
    abortSignal?.throwIfAborted();
    return this.sheetsDataValidation.describeTool(name)
      ?? this.mcp.describeTool(name, abortSignal, options);
  }

  async callTool(
    name: string,
    rawInput: Readonly<Record<string, unknown>>,
    abortSignal?: AbortSignal,
  ): Promise<unknown> {
    abortSignal?.throwIfAborted();
    const input = normalizeGoogleWorkspaceInput(name, rawInput);
    if (this.sheetsDataValidation.describeTool(name)) {
      const result = await this.sheetsDataValidation.callTool(name, input);
      abortSignal?.throwIfAborted();
      return result;
    }
    const result = await this.mcp.callTool(name, input, abortSignal);
    // Normalize the complete provider response before trimming model-facing
    // prose. Otherwise a 100-message Gmail page compacted to 20 entries loses
    // 80 IDs while its provider continuation token advances past all 100.
    const normalized = normalizeGoogleWorkspaceResult(name, result, input);
    return compactGmailMcpResult(name, input, normalized);
  }
}
