import type { AgentInvokeInputDTO } from '../../contracts';
import { larkDocsService, LarkDocsIntegrationError } from '../../channels/lark/lark-docs.service';
import { BaseAgent } from '../base';

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

  const header = `| ${keys.join(' | ')} |`;
  const divider = `| ${keys.map(() => '---').join(' | ')} |`;
  const rows = items.slice(0, 12).map((item) =>
    `| ${keys.map((key) => formatUnknown(item[key]).replace(/\n+/g, ' ').replace(/\|/g, '\\|')).join(' | ')} |`);
  return [header, divider, ...rows].join('\n');
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

    try {
      const result = await larkDocsService.createMarkdownDoc({
        companyId,
        larkTenantKey,
        title,
        markdown,
        folderToken,
      });

      const answer = result.url
        ? `Created Lark Doc "${result.title}". URL: ${result.url}`
        : `Created Lark Doc "${result.title}". Document ID: ${result.documentId}`;

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
          `Lark Doc creation failed: ${error.message}`,
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
        `Lark Doc creation failed: ${rawMessage}`,
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
