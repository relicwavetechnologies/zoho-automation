import type {
  GoogleWorkspaceMcpPort,
  GoogleWorkspaceMcpToolDescription,
} from '../../application/orchestration/tools/families/google-workspace-mcp.tool';
import { GoogleSheetsDataValidationClient } from './google-sheets-data-validation.client';
import { compactGmailMcpResult } from './gmail-result-compactor';
import { GoogleWorkspaceMcpClient } from './google-workspace-mcp.client';
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

  async describeTool(name: string): Promise<GoogleWorkspaceMcpToolDescription | null> {
    return this.sheetsDataValidation.describeTool(name) ?? this.mcp.describeTool(name);
  }

  async callTool(name: string, input: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.sheetsDataValidation.describeTool(name)) {
      return this.sheetsDataValidation.callTool(name, input);
    }
    const result = await this.mcp.callTool(name, input);
    // Normalize the complete provider response before trimming model-facing
    // prose. Otherwise a 100-message Gmail page compacted to 20 entries loses
    // 80 IDs while its provider continuation token advances past all 100.
    const normalized = normalizeGoogleWorkspaceResult(name, result, input);
    return compactGmailMcpResult(name, input, normalized);
  }
}
