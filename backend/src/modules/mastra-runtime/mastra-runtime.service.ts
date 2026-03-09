import { randomUUID } from 'crypto';

import { RequestContext } from '@mastra/core/di';

import { mastra } from '../../company/integrations/mastra';
import { buildMastraAgentRunOptions, MASTRA_AGENT_TARGETS, type MastraAgentTargetId } from '../../company/integrations/mastra/mastra-model-control';

type GeneratePayload = {
  messages: Array<{
    role: string;
    content?: unknown;
  }>;
  requestContext?: Record<string, unknown>;
};

type GenerateResponse = {
  id: string;
  agentId: string;
  text: string;
  output: {
    route: string;
    agentResults: unknown[];
  };
};

const KNOWN_AGENTS = ['supervisorAgent', 'zohoAgent', 'outreachAgent', 'searchAgent'] as const;

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const extractObjective = (messages: GeneratePayload['messages']): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;

    const content = message.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object') {
            const t = (part as Record<string, unknown>).text;
            return typeof t === 'string' ? t : '';
          }
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
};

export class MastraRuntimeService {
  async generate(agentId: string, payload: GeneratePayload, requestId?: string): Promise<GenerateResponse> {
    const objective = extractObjective(payload.messages);
    if (!objective) {
      return {
        id: randomUUID(),
        agentId,
        text: 'No user message content found in request.',
        output: { route: 'empty', agentResults: [] },
      };
    }

    if (!(KNOWN_AGENTS as readonly string[]).includes(agentId)) {
      return {
        id: randomUUID(),
        agentId,
        text: `Unknown agentId: ${agentId}`,
        output: { route: 'unknown', agentResults: [] },
      };
    }

    const raw = payload.requestContext ?? {};
    const requestContext = new RequestContext<Record<string, string>>();
    requestContext.set('companyId', asString(raw['companyId']));
    requestContext.set('larkTenantKey', asString(raw['larkTenantKey']));
    requestContext.set('userId', asString(raw['userId']));
    requestContext.set('chatId', asString(raw['chatId']));
    requestContext.set('taskId', asString(raw['taskId']));
    requestContext.set('messageId', asString(raw['messageId']));
    requestContext.set('requestId', asString(raw['requestId'] ?? requestId));
    requestContext.set('channel', asString(raw['channel']));
    requestContext.set('requesterEmail', asString(raw['requesterEmail']));

    // mastra.getAgent accepts the registered agent key — cast since we validated above
    const agent = mastra.getAgent(agentId as 'supervisorAgent' | 'zohoAgent' | 'outreachAgent' | 'searchAgent');
    // Pass objective as a plain string — MessageListInput accepts string
    const runOptions = await buildMastraAgentRunOptions(
      MASTRA_AGENT_TARGETS[agentId as MastraAgentTargetId],
      { requestContext },
    );
    const result = await agent.generate(objective, runOptions as any);

    return {
      id: randomUUID(),
      agentId,
      text: result.text,
      output: { route: 'mastra-sdk', agentResults: [] },
    };
  }

  async stream(agentId: string, payload: GeneratePayload, requestId?: string) {
    const objective = extractObjective(payload.messages);
    if (!objective) {
      throw new Error('No objective found for streaming');
    }

    if (!(KNOWN_AGENTS as readonly string[]).includes(agentId)) {
      throw new Error(`Unknown agentId: ${agentId}`);
    }

    const raw = payload.requestContext ?? {};
    const requestContext = new RequestContext<Record<string, string>>();
    requestContext.set('companyId', asString(raw['companyId']));
    requestContext.set('larkTenantKey', asString(raw['larkTenantKey']));
    requestContext.set('userId', asString(raw['userId']));
    requestContext.set('chatId', asString(raw['chatId']));
    requestContext.set('taskId', asString(raw['taskId']));
    requestContext.set('messageId', asString(raw['messageId']));
    requestContext.set('requestId', asString(raw['requestId'] ?? requestId));
    requestContext.set('channel', asString(raw['channel']));
    requestContext.set('requesterEmail', asString(raw['requesterEmail']));

    const agent = mastra.getAgent(agentId as 'supervisorAgent' | 'zohoAgent' | 'outreachAgent' | 'searchAgent');
    const runOptions = await buildMastraAgentRunOptions(
      MASTRA_AGENT_TARGETS[agentId as MastraAgentTargetId],
      { requestContext },
    );
    return agent.stream(objective, runOptions as any);
  }
}

export const mastraRuntimeService = new MastraRuntimeService();

export const __test__ = {
  extractObjective,
};
