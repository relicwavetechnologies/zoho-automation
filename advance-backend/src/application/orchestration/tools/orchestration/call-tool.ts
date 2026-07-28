/**
 * call_tool — universal meta-tool for the single-brain architecture.
 *
 * The LLM calls this ONE tool with a toolId + args, and the backend routes
 * to the correct tool implementation from the ToolRegistry. Replicates the
 * full security pipeline from ai-sdk-adapter: permission check, approval
 * gate, then execution.
 *
 * All outputs (success and error) are returned as strings for the LLM.
 */

import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { ToolRegistry } from '../tool-registry';
import type { AdapterContext } from '../ai-sdk-adapter';
import { buildArgsSummary } from '../ai-sdk-adapter';
import type { ToolExecutionContext } from '../tool.contract';
import type { ToolExecutor } from '../../../gateway/tool-executor';

const inputSchema = z.object({
  toolId: z.string().describe('The ID of the tool to execute (e.g. larkTask, googleGmail, zohoCrm)'),
  args:   z.record(z.unknown()).describe('Arguments to pass to the tool, matching its expected schema'),
});

export function createCallToolTool(
  registry: ToolRegistry,
  adapterCtx: AdapterContext,
  allowedToolIds?: ReadonlySet<string>,
  onDecision?: (event: {
    toolId: string;
    outcome: 'success' | 'failure';
    status: string;
    action?: string;
  }) => void,
  runtimeExecutor?: ToolExecutor,
  isToolResolved?: (toolId: string) => boolean,
) {
  const availableIds = registry.ids()
    .filter((toolId) => !allowedToolIds || allowedToolIds.has(String(toolId)))
    .join(', ');

  return dynamicTool({
    description:
      `Execute any tool by ID. Route your action through this single tool instead of calling tools directly.\n` +
      `Available tools: ${availableIds}`,
    inputSchema: inputSchema as never,
    execute: async (input: unknown): Promise<string> => {
      if (adapterCtx.abortSignal?.aborted) {
        return 'error: Tool execution was cancelled because the parent run ended.';
      }

      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return `error: invalid call_tool input — ${parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')}`;
      }

      const { toolId, args } = parsed.data;

      if (isToolResolved && !isToolResolved(toolId)) {
        onDecision?.({ toolId, outcome: 'failure', status: 'work_context_required' });
        return `work_context_required: Discover an approved skill for "${toolId}" before executing it.`;
      }

      adapterCtx.logger.info('call_tool.invoke', { toolId });

      // Backend-hosted channels supply the governed executor so they share
      // desktop-grade schema validation, approval matching, and tool runtime
      // behavior instead of maintaining a parallel implementation here.
      if (runtimeExecutor) {
        const outcome = await runtimeExecutor.executeForRuntime({
          toolId,
          args,
          runContext: adapterCtx.runContext,
          perm: adapterCtx.perm,
          ...(allowedToolIds ? { allowedToolIds } : {}),
          ...(adapterCtx.approvalGate ? { approvalGate: adapterCtx.approvalGate } : {}),
          ...(adapterCtx.chatId ? { chatId: adapterCtx.chatId } : {}),
          ...(adapterCtx.onProgress ? { onProgress: adapterCtx.onProgress } : {}),
          ...(adapterCtx.abortSignal ? { abortSignal: adapterCtx.abortSignal } : {}),
        });
        const outcomeResult = formatRuntimeOutcome(outcome);
        onDecision?.({
          toolId,
          outcome: outcome.status === 'success' || outcome.status === 'approval_required' ? 'success' : 'failure',
          status: outcome.status === 'approval_required' ? 'approval_pending' : outcome.status,
          ...(outcome.action ? { action: outcome.action } : {}),
        });
        return outcomeResult;
      }

      if (allowedToolIds && !allowedToolIds.has(toolId)) {
        adapterCtx.logger.warn('call_tool.permission_denied', {
          toolId,
          reason: 'Tool is not present in the request-scoped permitted tool set',
        });
        onDecision?.({ toolId, outcome: 'failure', status: 'permission_denied' });
        return `permission_denied: tool "${toolId}" is not available for the current member.`;
      }

      // ── Look up tool ─────────────────────────────────────────────────────
      const tool = registry.byId(toolId as never);
      if (!tool) {
        adapterCtx.logger.warn('call_tool.unknown_tool', { toolId });
        onDecision?.({ toolId, outcome: 'failure', status: 'unknown_tool' });
        return `error: unknown toolId "${toolId}". Available tools: ${availableIds}`;
      }

      // ── Validate args against tool schema ────────────────────────────────
      const argsParse = tool.argsSchema.safeParse(args);
      if (!argsParse.success) {
        const issues = argsParse.error.errors
          .map(e => `${e.path.join('.') || '(root)'}: ${e.message}`)
          .join('; ');
        adapterCtx.logger.warn('call_tool.invalid_args', { toolId, issues });
        onDecision?.({ toolId, outcome: 'failure', status: 'invalid_args' });
        return `error: invalid args for "${toolId}" — ${issues}`;
      }

      const validatedArgs = argsParse.data;

      // ── Permission check ─────────────────────────────────────────────────
      const permCheck = tool.permissionCheck(validatedArgs, adapterCtx.perm);
      if (!permCheck.ok) {
        adapterCtx.logger.warn('call_tool.permission_denied', {
          toolId,
          reason: permCheck.error.message,
        });
        onDecision?.({ toolId, outcome: 'failure', status: 'permission_denied' });
        return `permission_denied: ${permCheck.error.message}`;
      }

      const action = permCheck.value;

      // ── Approval gate ────────────────────────────────────────────────────
      // runCommand self-gates per-command on the user's machine — skip the
      // company/manager approval flow for it.
      if (adapterCtx.approvalGate && adapterCtx.chatId && tool.id !== 'runCommand') {
        const argsSummary = buildArgsSummary(tool.id, action, validatedArgs);
        const decision = await adapterCtx.approvalGate.check({
          toolId:      tool.id,
          action,
          args:        validatedArgs,
          perm:        adapterCtx.perm,
          runContext:  adapterCtx.runContext,
          chatId:      adapterCtx.chatId,
          argsSummary,
        });

        if (decision.kind === 'pending') {
          adapterCtx.logger.info('call_tool.approval_pending', {
            toolId,
            action,
            approvalId: decision.approvalId,
          });
          onDecision?.({ toolId, action, outcome: 'success', status: 'approval_pending' });
          return `approval_pending: ${decision.message}`;
        }

        if (decision.kind === 'rejected') {
          adapterCtx.logger.info('call_tool.approval_rejected', {
            toolId,
            action,
            approvalId: decision.approvalId,
          });
          onDecision?.({ toolId, action, outcome: 'failure', status: 'approval_rejected' });
          return `approval_rejected: ${decision.message}`;
        }

        if (decision.kind === 'misconfigured') {
          adapterCtx.logger.warn('call_tool.approval_misconfigured', {
            toolId,
            action,
            reason: decision.message,
          });
          onDecision?.({ toolId, action, outcome: 'failure', status: 'approval_misconfigured' });
          return `approval_misconfigured: ${decision.message}`;
        }

        // decision.kind === 'allowed' — fall through to execute
      }

      // ── Build execution context ──────────────────────────────────────────
      const execCtx: ToolExecutionContext = {
        runContext:    adapterCtx.runContext,
        perm:         adapterCtx.perm,
        correlationId: tool.id,
        logger:       adapterCtx.logger.child({ toolId: tool.id }),
        clock:        adapterCtx.clock,
        ...(adapterCtx.abortSignal ? { abortSignal: adapterCtx.abortSignal } : {}),
        ...(adapterCtx.onProgress ? { onProgress: adapterCtx.onProgress } : {}),
      };

      // ── Execute ──────────────────────────────────────────────────────────
      if (adapterCtx.abortSignal?.aborted) {
        return 'error: Tool execution was cancelled because the parent run ended.';
      }
      const result = await tool.execute(validatedArgs, execCtx);
      if (!result.ok) {
        adapterCtx.logger.warn('call_tool.tool_error', {
          toolId,
          reason: result.error.message,
        });
        onDecision?.({ toolId, action, outcome: 'failure', status: 'tool_error' });
        return `error: ${result.error.message}`;
      }

      const val = result.value;
      onDecision?.({ toolId, action, outcome: 'success', status: 'executed' });
      return typeof val === 'string' ? val : JSON.stringify(val);
    },
  });
}

function formatRuntimeOutcome(outcome: Awaited<ReturnType<ToolExecutor['executeForRuntime']>>): string {
  if (outcome.status === 'success') {
    return typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result);
  }
  const message = outcome.message ?? 'The tool could not complete.';
  switch (outcome.status) {
    case 'permission_denied': return `permission_denied: ${message}`;
    case 'approval_required': return `approval_pending: ${message}`;
    case 'approval_rejected': return `approval_rejected: ${message}`;
    case 'approval_misconfigured': return `approval_misconfigured: ${message}`;
    default: return `error: ${message}`;
  }
}
