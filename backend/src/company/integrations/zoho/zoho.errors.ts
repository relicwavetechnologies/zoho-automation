export type ZohoFailureCode =
  | 'auth_failed'
  | 'token_refresh_failed'
  | 'rate_limited'
  | 'schema_mismatch'
  | 'mcp_unavailable'
  | 'mcp_invalid_response'
  | 'mcp_tool_not_allowed'
  | 'mcp_action_requires_hitl'
  | 'unknown';

export class ZohoIntegrationError extends Error {
  readonly code: ZohoFailureCode;

  readonly retriable: boolean;

  readonly statusCode?: number;

  constructor(input: {
    message: string;
    code: ZohoFailureCode;
    retriable?: boolean;
    statusCode?: number;
  }) {
    super(input.message);
    this.name = 'ZohoIntegrationError';
    this.code = input.code;
    this.retriable = input.retriable ?? false;
    this.statusCode = input.statusCode;
  }
}
