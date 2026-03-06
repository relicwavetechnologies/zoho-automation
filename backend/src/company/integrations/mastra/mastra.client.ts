import config from '../../../config';
import { HttpException } from '../../../core/http-exception';
import { logger } from '../../../utils/logger';

type MastraClientOptions = {
  fetchImpl?: typeof fetch;
};

type MastraGenerateInput = {
  taskId: string;
  messageId: string;
  userId: string;
  chatId: string;
  text: string;
  channel: string;
  companyId?: string;
  requestId?: string;
  larkTenantKey?: string;
};

type MastraGenerateResult = {
  text: string;
  raw: unknown;
};

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value.trim() : undefined);

const extractTextFromContentArray = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  for (const part of value) {
    if (!part || typeof part !== 'object') {
      continue;
    }
    const text = asString((part as Record<string, unknown>).text);
    if (text) {
      return text;
    }
  }

  return undefined;
};

const extractMastraText = (payload: unknown): string | undefined => {
  if (!payload) {
    return undefined;
  }

  if (typeof payload === 'string') {
    return payload.trim() || undefined;
  }

  if (typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const directCandidates = [
    asString(record.text),
    asString(record.output_text),
    asString((record.output as Record<string, unknown> | undefined)?.text),
    asString((record.response as Record<string, unknown> | undefined)?.text),
    asString((record.message as Record<string, unknown> | undefined)?.content),
    extractTextFromContentArray((record.message as Record<string, unknown> | undefined)?.content),
  ];

  for (const candidate of directCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const message = first?.message as Record<string, unknown> | undefined;
    const contentString = asString(message?.content);
    if (contentString) {
      return contentString;
    }
    const contentArray = extractTextFromContentArray(message?.content);
    if (contentArray) {
      return contentArray;
    }
  }

  return undefined;
};

export class MastraClient {
  private readonly fetchImpl: typeof fetch;

  constructor(options: MastraClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(input: MastraGenerateInput): Promise<MastraGenerateResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.MASTRA_TIMEOUT_MS);
    const baseUrl = config.MASTRA_BASE_URL.replace(/\/$/, '');
    const endpoint = `${baseUrl}/api/agents/${encodeURIComponent(config.MASTRA_AGENT_ID)}/generate`;

    try {
      const headers = new Headers({
        'Content-Type': 'application/json',
      });
      if (config.MASTRA_API_KEY) {
        headers.set('Authorization', `Bearer ${config.MASTRA_API_KEY}`);
      }

      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: input.text,
            },
          ],
          threadId: input.taskId,
          requestContext: {
            taskId: input.taskId,
            messageId: input.messageId,
            userId: input.userId,
            chatId: input.chatId,
            channel: input.channel,
            companyId: input.companyId,
            requestId: input.requestId,
            larkTenantKey: input.larkTenantKey,
          },
        }),
      });

      const rawBody = await response.text();
      const payload: unknown = rawBody
        ? (() => {
          try {
            return JSON.parse(rawBody);
          } catch {
            return rawBody;
          }
        })()
        : {};

      if (!response.ok) {
        logger.error('mastra.client.generate.failed', {
          endpoint,
          statusCode: response.status,
          taskId: input.taskId,
          messageId: input.messageId,
          requestId: input.requestId,
        });
        throw new HttpException(502, `Mastra generate failed (${response.status})`);
      }

      const text = extractMastraText(payload);
      if (!text) {
        throw new HttpException(502, 'Mastra generate returned empty output text');
      }

      return {
        text,
        raw: payload,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new HttpException(504, `Mastra generate timed out after ${config.MASTRA_TIMEOUT_MS}ms`);
      }

      throw new HttpException(502, `Mastra generate failed: ${error instanceof Error ? error.message : 'unknown_error'}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const mastraClient = new MastraClient();
