import type { AgentInvokeInputDTO } from '../../contracts';
import { larkDocsService, LarkDocsIntegrationError } from '../../channels/lark/lark-docs.service';
import { BaseAgent } from '../base';
import { conversationMemoryStore } from '../../state/conversation';

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
};

const extractTitle = (objective: string): string => {
  const quoted = objective.match(/(?:title|named|called)\s+["“']([^"”']{3,120})["”']/i)?.[1];
  if (quoted) {
    return quoted.trim();
  }

  const forMatch = objective.match(/(?:lark doc|document|doc)\s+(?:for|about|on)\s+([^.?!\n]{3,120})/i)?.[1];
  if (forMatch) {
    return forMatch.trim().replace(/\s+/g, ' ');
  }

  return 'Lark Doc';
};

const toMarkdownSection = (heading: string, content: string): string =>
  `## ${heading}\n\n${content.trim()}`;

const buildConversationKey = (input: AgentInvokeInputDTO): string | null => {
  const channel = asString(input.contextPacket.channel);
  const tenant = asString(input.contextPacket.larkTenantKey);
  const chatId = asString(input.contextPacket.chatId);
  if (!channel || !chatId) {
    return null;
  }
  return `${channel}:${tenant ?? 'no_tenant'}:${chatId}`;
};

const inferEditStrategy = (objective: string): 'replace' | 'append' | 'patch' | 'delete' => {
  const text = objective.toLowerCase();
  if (/\b(rewrite|redo|replace|change everything|replace everything|start over)\b/.test(text)) {
    return 'replace';
  }
  if (/\b(add|append|include|insert)\b/.test(text)) {
    return 'append';
  }
  if (/\b(remove|delete)\b/.test(text)) {
    return 'delete';
  }
  return 'patch';
};

const isEditIntent = (objective: string): boolean =>
  /\b(edit|update|append|add|remove|delete|rewrite|replace)\b/i.test(objective);

const formatUnknown = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.trim();
  }
  try {
    return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  } catch {
    return String(value);
  }
};

const formatArrayOfRecords = (items: Record<string, unknown>[]): string => {
  const keys = [...new Set(items.flatMap((item) => Object.keys(item).slice(0, 6)))].slice(0, 6);
  if (keys.length === 0) {
    return items.map((item, index) => `${index + 1}. ${formatUnknown(item)}`).join('\n');
  }

  return items.slice(0, 12).map((item, index) => {
    const titleKey = keys.find((key) => /name|title|subject|deal|company/i.test(key));
    const titleValue = titleKey ? formatUnknown(item[titleKey]).replace(/\n+/g, ' ').trim() : '';
    const fields = keys
      .map((key) => {
        const value = formatUnknown(item[key]).replace(/\n+/g, ' ').trim();
        if (!value) {
          return null;
        }
        return `  - **${key}:** ${value}`;
      })
      .filter((value): value is string => Boolean(value));

    if (fields.length === 0) {
      return `${index + 1}. ${formatUnknown(item)}`;
    }

    return [`${index + 1}. ${titleValue || 'Record'}`, ...fields].join('\n');
  }).join('\n\n');
};

const formatResultPayload = (payload: Record<string, unknown>): string => {
  const answer = asString(payload.answer);
  if (answer) {
    const details: string[] = [answer];

    const records = payload.records;
    if (Array.isArray(records) && records.length > 0) {
      const recordObjects = records.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item));
      if (recordObjects.length > 0) {
        details.push(toMarkdownSection('Records', formatArrayOfRecords(recordObjects)));
      }
    }

    const items = payload.items;
    if (Array.isArray(items) && items.length > 0) {
      const itemObjects = items.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item));
      if (itemObjects.length > 0) {
        details.push(toMarkdownSection('Items', formatArrayOfRecords(itemObjects)));
      }
    }

    return details.join('\n\n');
  }

  return formatUnknown(payload);
};

const buildMarkdownFromPriorResults = (input: AgentInvokeInputDTO): string => {
  const explicitMarkdown = asString(input.contextPacket.markdown);
  if (explicitMarkdown) {
    return explicitMarkdown;
  }

  const sections = [`# ${extractTitle(input.objective)}`];

  const explicitSummary = asString(input.contextPacket.summary);
  if (explicitSummary) {
    sections.push(toMarkdownSection('Summary', explicitSummary));
  } else {
    sections.push(toMarkdownSection('Request', input.objective));
  }

  const priorOutputs = Array.isArray(input.contextPacket.priorAgentOutputs)
    ? (input.contextPacket.priorAgentOutputs as Array<Record<string, unknown>>)
    : [];

  if (priorOutputs.length === 0) {
    sections.push(toMarkdownSection('Notes', 'No prior grounded agent outputs were available. This document captures the original request.'));
    return sections.join('\n\n');
  }

  for (const entry of priorOutputs) {
    const agentKey = asString(entry.agentKey) ?? 'agent';
    const status = asString(entry.status) ?? 'unknown';
    const result = asRecord(entry.result);
    const error = asRecord(entry.error);

    if (status !== 'success') {
      sections.push(toMarkdownSection(`Source: ${agentKey}`, `The agent did not complete successfully.\n\n${formatUnknown(error ?? entry.message)}`));
      continue;
    }

    if (result) {
      sections.push(toMarkdownSection(`Source: ${agentKey}`, formatResultPayload(result)));
    } else {
      sections.push(toMarkdownSection(`Source: ${agentKey}`, formatUnknown(entry.message)));
    }
  }

  return sections.join('\n\n');
};

export class LarkDocAgent extends BaseAgent {
  readonly key = 'lark-doc';

  async invoke(input: AgentInvokeInputDTO) {
    const startedAt = Date.now();
    const title = extractTitle(input.objective);
    const markdown = buildMarkdownFromPriorResults(input);
    const folderToken = asString(input.contextPacket.folderToken);
    const companyId = asString(input.contextPacket.companyId);
    const larkTenantKey = asString(input.contextPacket.larkTenantKey);
    const appUserId = asString(input.contextPacket.userId);
    const credentialMode = input.contextPacket.larkAuthMode === 'user_linked' ? 'user_linked' : 'tenant';
    const conversationKey = buildConversationKey(input);
    const latestDoc = conversationKey ? conversationMemoryStore.getLatestLarkDoc(conversationKey) : null;

    try {
      if (isEditIntent(input.objective)) {
        const explicitDocumentId = asString(input.contextPacket.documentId);
        const documentId = explicitDocumentId ?? latestDoc?.documentId;
        if (!documentId) {
          return this.failure(
            input,
            'No prior Lark Doc was found in this conversation. Create a doc first or specify a document ID.',
            'lark_docs_invalid_response',
            'missing_document_id',
            false,
            {
              latencyMs: Date.now() - startedAt,
              apiCalls: 0,
            },
          );
        }

        const editResult = await larkDocsService.editMarkdownDoc({
          companyId,
          larkTenantKey,
          appUserId,
          credentialMode,
          documentId,
          instruction: input.objective,
          newMarkdown: inferEditStrategy(input.objective) === 'delete' ? undefined : markdown,
          strategy: inferEditStrategy(input.objective),
        });

        if (conversationKey) {
          conversationMemoryStore.addLarkDoc(conversationKey, {
            title: latestDoc?.title ?? title,
            documentId: editResult.documentId,
            url: editResult.url,
          });
        }

        const answer = editResult.url
          ? `Updated Lark Doc: ${editResult.url}`
          : `Updated Lark Doc: ${editResult.documentId}`;
        return this.success(
          input,
          answer,
          {
            answer,
            title: latestDoc?.title ?? title,
            documentId: editResult.documentId,
            url: editResult.url,
            blocksAffected: editResult.blocksAffected,
          },
          {
            latencyMs: Date.now() - startedAt,
            apiCalls: 3,
          },
        );
      }

      const result = await larkDocsService.createMarkdownDoc({
        companyId,
        larkTenantKey,
        appUserId,
        credentialMode,
        title,
        markdown,
        folderToken,
      });

      if (conversationKey) {
        conversationMemoryStore.addLarkDoc(conversationKey, {
          title: result.title,
          documentId: result.documentId,
          url: result.url,
        });
      }

      const answer = result.url
        ? `Created Lark Doc: ${result.url}`
        : `Created Lark Doc: ${result.documentId}`;

      return this.success(
        input,
        answer,
        {
          answer,
          title: result.title,
          documentId: result.documentId,
          url: result.url,
          blockCount: result.blockCount,
        },
        {
          latencyMs: Date.now() - startedAt,
          apiCalls: 3,
        },
      );
    } catch (error) {
      if (error instanceof LarkDocsIntegrationError) {
        return this.failure(
          input,
          `Lark Doc failed: ${error.message}`,
          error.code,
          error.message,
          error.code === 'lark_docs_unavailable',
          {
            latencyMs: Date.now() - startedAt,
            apiCalls: 1,
          },
        );
      }

      const rawMessage = error instanceof Error ? error.message : 'unknown_error';
      return this.failure(
        input,
        `Lark Doc failed: ${rawMessage}`,
        'lark_docs_unavailable',
        rawMessage,
        true,
        {
          latencyMs: Date.now() - startedAt,
          apiCalls: 1,
        },
      );
    }
  }
}
