import { randomUUID } from 'crypto';

import config from '../../../config';
import { logger } from '../../../utils/logger';
import { ZohoIntegrationError } from './zoho.errors';

// ▶ MCP HTTP call logs are prefixed with 'mcp.http.*' so you can grep for them.

type McpHttpRequest = {
  baseUrl: string;
  apiKey?: string;
  workspaceKey?: string;
  body: Record<string, unknown>;
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
  };
};

type McpToolListResponse = {
  result?: {
    tools?: Array<{ name?: string }>;
  };
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const shouldRetryStatus = (status: number): boolean => status === 429 || status >= 500;

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as Record<string, unknown>;
};

export class McpHttpClient {
  async requestJson<T>(input: McpHttpRequest): Promise<T> {
    const maxAttempts = Math.max(1, input.retry?.maxAttempts ?? config.MCP_MAX_RETRIES);
    const baseDelayMs = Math.max(0, input.retry?.baseDelayMs ?? config.MCP_RETRY_BASE_DELAY_MS);

    const startedAt = Date.now();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      logger.info('mcp.http.request.start', {
        baseUrl: input.baseUrl,
        attempt,
        maxAttempts,
        method: (input.body as Record<string, unknown>).method ?? 'unknown',
      });

      try {
        // Zoho MCP authenticates via a ?key= query param, not a header.
        // Build the final URL with the key appended if provided.
        const requestUrl = (() => {
          if (!input.apiKey) return input.baseUrl;
          const url = new URL(input.baseUrl);
          url.searchParams.set('key', input.apiKey);
          return url.toString();
        })();

        const response = await fetch(requestUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(input.workspaceKey ? { 'x-workspace-key': input.workspaceKey } : {}),
          },
          body: JSON.stringify(input.body),
          signal: AbortSignal.timeout(config.MCP_REQUEST_TIMEOUT_MS),
        });

        const raw = await response.text();
        const parsed = raw ? (JSON.parse(raw) as unknown) : {};
        if (response.ok) {
          logger.info('mcp.http.request.success', {
            baseUrl: input.baseUrl,
            statusCode: response.status,
            latencyMs: Date.now() - startedAt,
            attempt,
          });
          return parsed as T;
        }

        if (response.status === 401 || response.status === 403) {
          throw new ZohoIntegrationError({
            message: `MCP authentication failed (${response.status})`,
            code: 'auth_failed',
            retriable: false,
            statusCode: response.status,
          });
        }

        if (shouldRetryStatus(response.status) && attempt < maxAttempts) {
          const delayMs = baseDelayMs * attempt;
          logger.warn('mcp.http.request.retry', {
            baseUrl: input.baseUrl,
            attempt,
            delayMs,
            statusCode: response.status,
          });
          await sleep(delayMs);
          continue;
        }

        logger.error('mcp.http.request.failed', {
          baseUrl: input.baseUrl,
          statusCode: response.status,
          latencyMs: Date.now() - startedAt,
          attempt,
        });
        throw new ZohoIntegrationError({
          message: `MCP request failed (${response.status})`,
          code: shouldRetryStatus(response.status) ? 'mcp_unavailable' : 'mcp_invalid_response',
          retriable: shouldRetryStatus(response.status),
          statusCode: response.status,
        });
      } catch (error) {
        const isZohoError = error instanceof ZohoIntegrationError;
        if (isZohoError) {
          throw error;
        }

        if (attempt < maxAttempts) {
          const delayMs = baseDelayMs * attempt;
          logger.warn('mcp.http.retry', {
            attempt,
            delayMs,
            reason: error instanceof Error ? error.message : 'unknown_error',
          });
          await sleep(delayMs);
          continue;
        }

        throw new ZohoIntegrationError({
          message: error instanceof Error ? error.message : 'MCP request failed',
          code: 'mcp_unavailable',
          retriable: true,
        });
      }
    }

    throw new ZohoIntegrationError({
      message: 'MCP request exhausted retries',
      code: 'mcp_unavailable',
      retriable: true,
    });
  }

  async listTools(input: { baseUrl: string; apiKey?: string; workspaceKey?: string }): Promise<string[]> {
    logger.info('mcp.tools.list.start', { baseUrl: input.baseUrl });
    const payload = await this.requestJson<McpToolListResponse>({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      workspaceKey: input.workspaceKey,
      body: {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/list',
      },
      retry: {
        maxAttempts: Math.max(1, config.MCP_MAX_RETRIES - 1),
      },
    });

    const tools = Array.isArray(payload.result?.tools) ? payload.result.tools : [];
    const toolNames = tools
      .map((tool) => (typeof tool?.name === 'string' ? tool.name.trim() : ''))
      .filter((name) => name.length > 0);
    logger.info('mcp.tools.list.done', { baseUrl: input.baseUrl, toolCount: toolNames.length, tools: toolNames });
    return toolNames;
  }

  async callTool(input: {
    baseUrl: string;
    apiKey?: string;
    workspaceKey?: string;
    toolName: string;
    argumentsPayload: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    logger.info('mcp.tool.call.start', {
      baseUrl: input.baseUrl,
      toolName: input.toolName,
      arguments: input.argumentsPayload,
    });
    const callStartedAt = Date.now();
    const payload = await this.requestJson<unknown>({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      workspaceKey: input.workspaceKey,
      body: {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/call',
        params: {
          name: input.toolName,
          arguments: input.argumentsPayload,
        },
      },
    });

    const asObj = asRecord(payload);
    if (!asObj) {
      logger.error('mcp.tool.call.invalid_response', { toolName: input.toolName });
      throw new ZohoIntegrationError({
        message: 'MCP tool response is not an object',
        code: 'mcp_invalid_response',
        retriable: false,
      });
    }

    const result = asRecord(asObj.result);
    logger.info('mcp.tool.call.done', {
      toolName: input.toolName,
      latencyMs: Date.now() - callStartedAt,
      hasResult: Boolean(result),
    });
    if (result) {
      return result;
    }

    return asObj;
  }
}

export const mcpHttpClient = new McpHttpClient();
