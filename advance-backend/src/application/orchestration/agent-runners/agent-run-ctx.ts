/**
 * AgentRunCtx — shared context threaded into every domain agent runner.
 * Runners are plain async functions, not classes. They receive this context
 * from the supervisor so they share the same model, perm, and tracer.
 */

import type { LanguageModel } from 'ai';
import type { PermissionResult } from '../../permissions/permission.types';
import type { RunContext } from '../../../domain/orchestration/run-context';
import type { Tool } from '../tools/tool.contract';
import type { Logger } from '../../../shared/logger';
import type { Clock } from '../../../shared/clock';
import type { ApprovalGateService } from '../../approval/approval-gate.service';

export interface AgentRunCtx {
  /** The LLM used by all runners — same model as the supervisor. */
  model:       LanguageModel;
  /** Human-readable default model metadata for logs. */
  defaultModel?: {
    provider: string;
    modelId:  string;
  };
  /** Optional per-agent model resolver. Falls back to model when unset. */
  resolveModel?: (input: {
    provider: string;
    modelId: string;
    companyId: string;
    agentSlug?: string;
  }) => Promise<LanguageModel> | LanguageModel;
  /** All tools the current runtime is allowed to use (permission-filtered). */
  allTools:    ReadonlyArray<Tool<unknown, unknown>>;
  perm:        PermissionResult;
  runContext:  RunContext;
  logger:      Logger;
  clock:       Clock;
  /** HITL approval gate — when present, non-read tool actions are pre-approved. */
  approvalGate?: ApprovalGateService;
  /** Lark chat_id used by the approval gate for idempotency. */
  chatId?:       string;
  /** Gemini API key for faithfulness grading after documentRag calls. */
  geminiApiKey?: string;
}
