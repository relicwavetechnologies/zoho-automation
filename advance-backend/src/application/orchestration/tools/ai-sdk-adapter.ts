/**
 * ai-sdk-adapter — bridges our Result<T,E> Tool contract to the Vercel AI SDK
 * tool() format. This is the ONLY place where our typed Result layer is
 * flattened into strings that the LLM can interpret.
 *
 * Failures become string envelopes:
 *   - permission_denied: <reason>
 *   - approval_pending: <reason>   (HITL gate fired, manager notified)
 *   - approval_rejected: <reason>
 *   - approval_misconfigured: <reason>
 *   - error: <reason>
 *
 * The supervisor LLM reads these and decides how to respond.
 */

import { dynamicTool } from 'ai';
import type { ToolSet } from 'ai';
import type { Tool as AppTool, ToolExecutionContext } from './tool.contract';
import type { Logger } from '../../../shared/logger';
import type { Clock } from '../../../shared/clock';
import type { PermissionResult } from '../../permissions/permission.types';
import type { RunContext } from '../../../domain/orchestration/run-context';
import type { ApprovalGateService } from '../../approval/approval-gate.service';
import { formatAmount, formatDate } from '../../zoho/zoho-format.utils';
import { googleWorkspaceProductByToolId } from '../../google/google-workspace-mcp-manifest';

export interface AdapterContext {
  runContext:    RunContext;
  perm:          PermissionResult;
  logger:        Logger;
  clock:         Clock;
  /** When provided, non-read actions are routed through the approval gate. */
  approvalGate?: ApprovalGateService;
  /** Lark chat_id — required for the approval gate idempotency key. */
  chatId?:       string;
  /** Live progress callback — tool updates flow to the user's status bubble. */
  onProgress?:   ((message: string) => void) | undefined;
  /** Parent run cancellation propagated into governed tool execution. */
  abortSignal?:  AbortSignal;
}

export function toAISdkTool(
  t: AppTool<unknown, unknown>,
  adapterCtx: AdapterContext,
) {
  const ctx: ToolExecutionContext = {
    runContext:    adapterCtx.runContext,
    perm:          adapterCtx.perm,
    correlationId: t.id,
    logger:        adapterCtx.logger.child({ toolId: t.id }),
    clock:         adapterCtx.clock,
    ...(adapterCtx.abortSignal ? { abortSignal: adapterCtx.abortSignal } : {}),
    ...(adapterCtx.onProgress ? { onProgress: adapterCtx.onProgress } : {}),
  };

  const description = t.parameterDocs
    ? `${t.description}\n${t.parameterDocs}`
    : t.description;

  return dynamicTool({
    description,
    inputSchema: t.argsSchema as never,
    execute: async (args: unknown): Promise<string> => {
      if (adapterCtx.abortSignal?.aborted) {
        return 'error: Tool execution was cancelled because the parent run ended.';
      }

      // ── Permission check ───────────────────────────────────────────────
      const permCheck = t.permissionCheck(args, adapterCtx.perm);
      if (!permCheck.ok) {
        adapterCtx.logger.warn('ai_sdk_adapter.permission_denied', {
          toolId: t.id,
          reason: permCheck.error.message,
        });
        return `permission_denied: ${permCheck.error.message}`;
      }

      const action = permCheck.value;

      // ── Approval gate ──────────────────────────────────────────────────
      // runCommand self-gates per-command on the user's machine — skip the
      // company/manager approval flow for it.
      if (adapterCtx.approvalGate && adapterCtx.chatId && t.id !== 'runCommand') {
        const argsSummary = buildArgsSummary(t.id, action, args);
        const decision = await adapterCtx.approvalGate.check({
          toolId:      t.id,
          action,
          args,
          perm:        adapterCtx.perm,
          runContext:  adapterCtx.runContext,
          chatId:      adapterCtx.chatId,
          argsSummary,
        });

        if (decision.kind === 'pending') {
          adapterCtx.logger.info('ai_sdk_adapter.approval_pending', {
            toolId:     t.id,
            action,
            approvalId: decision.approvalId,
          });
          return `approval_pending: ${decision.message}`;
        }

        if (decision.kind === 'rejected') {
          adapterCtx.logger.info('ai_sdk_adapter.approval_rejected', {
            toolId:     t.id,
            action,
            approvalId: decision.approvalId,
          });
          return `approval_rejected: ${decision.message}`;
        }

        if (decision.kind === 'misconfigured') {
          adapterCtx.logger.warn('ai_sdk_adapter.approval_misconfigured', {
            toolId: t.id,
            action,
            reason: decision.message,
          });
          return `approval_misconfigured: ${decision.message}`;
        }

        // decision.kind === 'allowed' → fall through to execute
      }

      // ── Execute ────────────────────────────────────────────────────────
      if (adapterCtx.abortSignal?.aborted) {
        return 'error: Tool execution was cancelled because the parent run ended.';
      }
      const result = await t.execute(args, ctx);
      if (!result.ok) {
        adapterCtx.logger.warn('ai_sdk_adapter.tool_error', {
          toolId: t.id,
          reason: result.error.message,
        });
        return `error: ${result.error.message}`;
      }

      const val = result.value;
      return typeof val === 'string' ? val : JSON.stringify(val);
    },
  });
}

/**
 * Convert an array of AppTool into the AI SDK ToolSet,
 * keyed by tool ID, filtered to the provided set of IDs.
 */
export function toAISdkTools(
  tools: ReadonlyArray<AppTool<unknown, unknown>>,
  ctx: AdapterContext,
  filterIds?: ReadonlySet<string>,
): ToolSet {
  const filtered = filterIds
    ? tools.filter(t => filterIds.has(t.id))
    : tools;

  return Object.fromEntries(
    filtered.map(t => [t.id, toAISdkTool(t, ctx)]),
  ) as unknown as ToolSet;
}

export function buildArgsSummary(toolId: string, action: string, args: unknown): string {
  try {
    const a = args as Record<string, unknown>;
    if (googleWorkspaceProductByToolId(toolId)) return buildGoogleWorkspaceArgsSummary(toolId, action, a);
    const parts: string[] = [`${toolId}.${action}`];
    // Append the most human-readable fields if present
    for (const key of ['to', 'subject', 'title', 'name', 'query', 'module', 'chatId', 'calendarId']) {
      if (a[key] !== undefined) {
        const val = String(a[key]).slice(0, 80);
        parts.push(`${key}=${val}`);
      }
    }
    if (toolId === 'zohoBooks') {
      const fields = a['fields'] && typeof a['fields'] === 'object' && !Array.isArray(a['fields'])
        ? a['fields'] as Record<string, unknown>
        : {};
      const merged = { ...fields, ...a };
      const currency = typeof merged['currency_code'] === 'string' ? merged['currency_code'] : 'USD';
      for (const key of ['customer_name', 'vendor_name', 'invoice_id', 'bill_id', 'expense_id']) {
        if (merged[key] !== undefined) parts.push(`${key}=${String(merged[key]).slice(0, 80)}`);
      }
      for (const key of ['amount', 'total', 'balance']) {
        const raw = merged[key];
        const amount = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
        if (Number.isFinite(amount)) parts.push(`${key}=${formatAmount(amount, currency)}`);
      }
      for (const key of ['date', 'due_date', 'payment_date']) {
        if (typeof merged[key] === 'string') parts.push(`${key}=${formatDate(merged[key])}`);
      }
    }
    return parts.join(' | ');
  } catch {
    return `${toolId}.${action}`;
  }
}

function buildGoogleWorkspaceArgsSummary(
  toolId: string,
  action: string,
  args: Record<string, unknown>,
): string {
  const nativeTool = typeof args['nativeTool'] === 'string' ? args['nativeTool'] : action;
  const input = args['input'] && typeof args['input'] === 'object' && !Array.isArray(args['input'])
    ? args['input'] as Record<string, unknown>
    : {};
  const parts = [`${toolId}.${nativeTool}`];
  for (const key of [
    'to', 'cc', 'bcc', 'subject', 'title', 'name', 'query', 'calendar_id',
    'event_id', 'document_id', 'spreadsheet_id', 'presentation_id', 'form_id',
  ]) {
    if (input[key] === undefined) continue;
    const value = Array.isArray(input[key]) ? input[key].join(', ') : String(input[key]);
    parts.push(`${key}=${value.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  const body = input['body'] ?? input['body_text'] ?? input['text'];
  if (typeof body === 'string' && body.trim()) {
    parts.push(`preview=${body.replace(/\s+/g, ' ').slice(0, 180)}`);
  }
  return parts.join(' | ');
}
