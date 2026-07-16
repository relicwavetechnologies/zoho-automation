import type {
  GoogleWorkspaceMcpPort,
  GoogleWorkspaceMcpToolDescription,
} from '../../application/orchestration/tools/families/google-workspace-mcp.tool';
import { GoogleSheetsDataValidationClient } from './google-sheets-data-validation.client';
import { GoogleWorkspaceMcpClient } from './google-workspace-mcp.client';

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
    return this.mcp.callTool(name, input);
  }
}
