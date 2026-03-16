import * as fs from 'fs';
import * as path from 'path';
import { extractLastJsonObjectString } from '../langchain/json-output';

export type LlmAuditType =
  | 'session_start'
  | 'bootstrap'
  | 'followup'
  | 'planning'
  | 'decision'
  | 'param'
  | 'synthesis';

export interface LlmAuditEntry {
  ts: string;
  executionId: string;
  hop?: number;
  type: LlmAuditType;
  promptTokenEstimate?: number;
  responseTokenEstimate?: number;
  thinkingTokenEstimate?: number;
  outputTokenEstimate?: number;
  latencyMs?: number;
  prompt?: string;
  rawResponse?: string;
  reasoningSummary?: string;
  parsed?: unknown;
  message?: string;
  mode?: string;
  threadId?: string;
}

export const appendLlmAuditLog = (entry: LlmAuditEntry): void => {
  try {
    const filePath = path.join('/tmp', `llm-audit-${entry.executionId}.jsonl`);
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Never break execution on audit log failure.
  }
};

export const roughTokenEstimate = (value: string | null | undefined): number =>
  Math.ceil((value ?? '').length / 4);

const summarizeReasoning = (value: string): string =>
  value.replace(/\s+/g, ' ').trim().slice(0, 200);

export const deriveAuditResponseFields = (raw: string | null | undefined): Pick<LlmAuditEntry, 'reasoningSummary' | 'thinkingTokenEstimate' | 'outputTokenEstimate'> => {
  const text = raw ?? '';
  if (!text) {
    return {
      reasoningSummary: '',
      thinkingTokenEstimate: 0,
      outputTokenEstimate: 0,
    };
  }

  const jsonTail = extractLastJsonObjectString(text);
  if (!jsonTail) {
    return {
      reasoningSummary: summarizeReasoning(text),
      thinkingTokenEstimate: roughTokenEstimate(text),
      outputTokenEstimate: 0,
    };
  }

  const splitIndex = text.lastIndexOf(jsonTail);
  const reasoning = splitIndex > 0 ? text.slice(0, splitIndex).trim() : '';
  return {
    reasoningSummary: summarizeReasoning(reasoning),
    thinkingTokenEstimate: roughTokenEstimate(reasoning),
    outputTokenEstimate: roughTokenEstimate(jsonTail),
  };
};
