import type { Result } from '../../../shared/result';
import { ok } from '../../../shared/result';
import type { AppError } from '../../../shared/errors';
import type { Logger } from '../../../shared/logger';
import type { Clock } from '../../../shared/clock';
import type { IncomingMessage } from '../../../domain/channel/incoming-message';
import type { FinalReply } from '../../../domain/channel/outbound';
import type { RunContext } from '../../../domain/orchestration/run-context';
import type { PermissionService } from '../../permissions/permission.service';
import type { PermissionQuery } from '../../permissions/permission.types';
import type { ToolRegistry } from '../tools/tool-registry';
import type { HistoryService } from './history';
import type { ConversationHandle } from '../../channels/channel.adapter';
import type { ChannelAdapter } from '../../channels/channel.adapter';
import type { StatusHandle } from '../../channels/channel.adapter';
import type { StatusChannel } from './status-channel';
import type { ChatId } from '../../../shared/ids';
import { asChatId } from '../../../shared/ids';
import type { SupervisorAgent } from '../agents/supervisor';
import type { ApprovalGateService } from '../../approval/approval-gate.service';
import type { ExecutionRepository } from '../../../infrastructure/persistence/execution.repository';
import { OrchestrationTracer } from '../../observability/orchestration-tracer';
import { resolveBranding } from '../department-branding';
import { RunStatusAggregator } from '../run-status.aggregator';

// ─── Public I/O types ──────────────────────────────────────────────────────

export interface EngineInput {
  incoming: IncomingMessage;
  runContext: RunContext;
  conversation: ConversationHandle;
  channelAdapter: ChannelAdapter;
  /** When provided, non-read tool actions are routed through the approval gate. */
  approvalGate?: ApprovalGateService;
  /** Pre-seeded statusMessageId for resume flows (so same bubble is updated). */
  existingStatusMessageId?: string;
}

export interface EngineOutput {
  finalReply: FinalReply;
  toolsCalled: readonly string[];
}

// ─── Deps ─────────────────────────────────────────────────────────────────

export interface OrchestrationEngineDeps {
  permissions:  PermissionService;
  toolRegistry: ToolRegistry;
  supervisor:   SupervisorAgent;
  history:      HistoryService;
  logger:       Logger;
  clock:        Clock;
  executionRepo?: ExecutionRepository;
}

// ─── Engine ───────────────────────────────────────────────────────────────

export class OrchestrationEngine {
  constructor(private readonly deps: OrchestrationEngineDeps) {}

  async run(input: EngineInput): Promise<Result<EngineOutput, AppError>> {
    const { incoming, runContext, conversation, channelAdapter, approvalGate, existingStatusMessageId } = input;
    const runStartMs = this.deps.clock.nowMs();

    const log = this.deps.logger.child({
      chatId:    incoming.chatId,
      traceId:   runContext.traceId ?? incoming.traceId,
      userId:    runContext.userId,
      companyId: runContext.companyId,
    });

    log.info('engine.run.start', { userMessage: incoming.text.slice(0, 100) });

    // ── 0. Create ExecutionRun trace record ────────────────────────────────
    let tracer: OrchestrationTracer | undefined;

    if (this.deps.executionRepo) {
      try {
        const runId = await this.deps.executionRepo.create({
          companyId:  runContext.companyId,
          channel:    runContext.channel,
          entrypoint: 'lark_webhook',
          ...(runContext.userId    ? { userId:     runContext.userId }              : {}),
          ...(runContext.requestId ? { requestId:  runContext.requestId }           : {}),
          ...(incoming.chatId     ? { chatId:     String(incoming.chatId) }        : {}),
          ...(incoming.messageId  ? { messageId:  String(incoming.messageId) }     : {}),
        });
        tracer = new OrchestrationTracer(runId, this.deps.executionRepo, log, runStartMs);
        tracer.emit({
          phase: 'init', eventType: 'run_started', actorType: 'engine',
          title: 'Orchestration run started', status: 'info',
          payload: {
            userMessageLength: incoming.text.length,
            channel:           runContext.channel,
            companyId:         runContext.companyId,
            userId:            runContext.userId,
          },
        });
      } catch (e) {
        log.warn('engine.trace.create_failed', { error: String(e) });
      }
    }

    // ── 1. Resolve permissions ─────────────────────────────────────────────
    const permQuery: PermissionQuery = {
      companyId:   runContext.companyId,
      userId:      runContext.userId,
      companyRole: runContext.companyRole,
      channel:     runContext.channel,
      ...(runContext.departmentId !== undefined ? { departmentId: runContext.departmentId } : {}),
    };

    const permResult = await this.deps.permissions.resolve(permQuery);
    if (!permResult.ok) {
      log.warn('engine.permission.denied', { error: permResult.error.message });
      tracer?.fail('permission_denied', permResult.error.message);
      const deniedReply: FinalReply = {
        kind: 'final',
        text: `I don't have permission to assist with this in your current context. Please contact your administrator.`,
        format: 'text',
      };
      await channelAdapter.sendFinalReply(conversation, deniedReply);
      return ok({ finalReply: deniedReply, toolsCalled: [] });
    }

    const perm = permResult.value;
    log.info('engine.permission.resolved', {
      allowedToolCount: perm.allowedToolIds.size,
      hasDept: !!perm.department,
    });

    const branding   = resolveBranding(perm);
    const aggregator = new RunStatusAggregator();

    // ── 2. Discover allowed tools ─────────────────────────────────────────
    const availableTools = this.deps.toolRegistry.forRuntime(perm);
    if (availableTools.length === 0) {
      log.warn('engine.no_tools_available');
      tracer?.fail('no_tools', 'No tools available for this role');
      const noToolsReply: FinalReply = {
        kind: 'final',
        text: 'No tools are available for your current role. Please contact your administrator.',
        format: 'text',
      };
      await channelAdapter.sendFinalReply(conversation, noToolsReply);
      return ok({ finalReply: noToolsReply, toolsCalled: [] });
    }

    // ── 3. Load history with poison filter ────────────────────────────────
    const historyResult = await this.deps.history.loadWindow(
      incoming.chatId as unknown as ChatId,
      { filterPoison: true, perm },
    );
    const history = historyResult.ok
      ? historyResult.value
      : { turns: [], truncated: false, tokenEstimate: 0 };

    // ── 4. Build status channel wrapper ───────────────────────────────────
    let currentStatusHandle: StatusHandle | null = null;
    const statusChannel: StatusChannel = {
      async sendStatus(update) {
        const result = await channelAdapter.sendStatus(conversation, {
          ...update, branding,
        });
        if (result.ok) { currentStatusHandle = result.value; return result.value; }
        return null;
      },
      async editStatus(handle, update) {
        if (!handle) return statusChannel.sendStatus(update);
        const result = await channelAdapter.editStatus(handle, {
          ...update, branding,
        });
        if (result.ok) { currentStatusHandle = result.value; return result.value; }
        return handle;
      },
    };

    // ── 4b. Pre-seed status bubble for resume flows ────────────────────────
    // When resuming after approval, the adapter already knows the statusMessageId.
    // Calling sendStatus here will edit the existing bubble instead of creating one.
    if (existingStatusMessageId && 'restoreStatusCoordinator' in channelAdapter) {
      (channelAdapter as any).restoreStatusCoordinator(
        String(conversation.correlationId),
        existingStatusMessageId,
        String(conversation.chatId),
      );
    }

    await statusChannel.sendStatus({ kind: 'status', terminal: false, branding, timeline: { liveLabel: 'Routing…' } });

    // ── 5. Run supervisor ─────────────────────────────────────────────────
    const supervisorResult = await this.deps.supervisor.run({
      userMessage:    incoming.text,
      history,
      channelType:    incoming.channel,
      channelId:      incoming.chatId,
      perm,
      runContext,
      statusChannel,
      aggregator,
      permittedTools: availableTools,
      ...(tracer !== undefined ? { tracer } : {}),
      ...(approvalGate !== undefined ? { approvalGate } : {}),
      chatId:         String(conversation.chatId),
    });

    if (!supervisorResult.ok) {
      log.error('engine.supervisor.failed', { error: supervisorResult.error.message });
      tracer?.fail('supervisor_failed', supervisorResult.error.message);
      const errReply: FinalReply = {
        kind: 'final',
        text: 'Something went wrong. Please try again.',
        format: 'text',
      };
      await channelAdapter.sendFinalReply(conversation, errReply);
      return ok({ finalReply: errReply, toolsCalled: [] });
    }

    const { toolsCalled, toolResults } = supervisorResult.value;
    const finalReply: FinalReply = { ...supervisorResult.value.finalReply, branding };
    const actionLog = buildActionLog(toolResults);
    const assistantHistoryContent = actionLog
      ? `[Actions]\n${actionLog}\n\n[Reply]\n${finalReply.text}`
      : finalReply.text;

    // ── 6. Persist conversation turn ──────────────────────────────────────
    await this.deps.history.appendTurn(incoming.chatId as unknown as ChatId, {
      role:      'user',
      content:   incoming.text,
      timestamp: incoming.timestamp,
    });
    await this.deps.history.appendTurn(incoming.chatId as unknown as ChatId, {
      role:      'assistant',
      content:   assistantHistoryContent,
      timestamp: this.deps.clock.now().toISOString(),
    });

    // ── 7. Send final reply ───────────────────────────────────────────────
    await channelAdapter.sendFinalReply(conversation, finalReply);

    const totalMs = this.deps.clock.nowMs() - runStartMs;
    log.info('engine.run.complete', {
      toolsCalled,
      replyLength: finalReply.text.length,
      durationMs:  totalMs,
    });

    tracer?.emit({
      phase: 'complete', eventType: 'run_complete', actorType: 'engine',
      title: 'Orchestration run complete', status: 'success',
      payload: {
        stepCount:        0,
        toolOutcomeCount: toolsCalled.length,
        toolsCalled:      toolsCalled,
        replyLength:      finalReply.text.length,
        durationMs:       totalMs,
      },
    });
    tracer?.complete(finalReply.text.slice(0, 500));

    return ok({ finalReply, toolsCalled });
  }
}

export interface SupervisorToolResultLogEntry {
  readonly toolName: string;
  readonly output: string;
}

export function buildActionLog(
  toolResults: ReadonlyArray<SupervisorToolResultLogEntry>,
): string | null {
  const lines = toolResults
    .filter(result => result.toolName !== 'manageTodos')
    .map(result => {
      const output = truncateForActionLog(result.output);
      return output ? `- ${result.toolName}: ${output}` : `- ${result.toolName}:`;
    });

  return lines.length > 0 ? lines.join('\n') : null;
}

function truncateForActionLog(output: string): string {
  const normalized = output.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 200) return normalized;
  return `${normalized.slice(0, 197)}...`;
}
