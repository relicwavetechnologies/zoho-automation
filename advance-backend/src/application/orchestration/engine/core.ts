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
import type { Mem0Service } from '../../memory/mem0.service';
import type { LanguageModel } from 'ai';
import { classifyMessage, runFastPath } from './fast-path';
import { buildExecutionSummary } from './execution-summary';
import { assessReplyQuality, buildPresentationContext, cleanReplyText } from './reply-quality';
import type { LarkChatContextService } from '../../chat-context/lark-chat-context.service';
import { formatGroupContextForPrompt } from '../../chat-context/group-context-formatter';
import {
  debugRunStart, debugPermissions, debugHistory,
  debugMemoryContext, debugGroupContext, debugFinalReply, debugRunEnd,
} from '../../../shared/debug-run-log';
import { generateText } from 'ai';

const MEM0_SEARCH_TIMEOUT_MS = 500;

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
  mem0?: Mem0Service;
  /** When provided, simple messages (greetings, chitchat) skip the full supervisor loop. */
  fastPathModel?: LanguageModel;
  /** When provided, group chat context is loaded and injected into the supervisor prompt. */
  chatContext?: LarkChatContextService;
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

    debugRunStart({
      chatId: String(incoming.chatId),
      userId: String(runContext.userId),
      companyId: String(runContext.companyId),
      userMessage: incoming.text,
      traceId: runContext.traceId ?? incoming.traceId,
    });

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

    const permissionStartMs = this.deps.clock.nowMs();
    const permResult = await this.deps.permissions.resolve(permQuery);
    const permissionDurationMs = this.deps.clock.nowMs() - permissionStartMs;
    if (!permResult.ok) {
      log.warn('engine.permission.denied', {
        error: permResult.error.message,
        durationMs: permissionDurationMs,
      });
      tracer?.emit({
        phase: 'permission', eventType: 'permission_denied', actorType: 'engine',
        title: 'Permission denied', status: 'error',
        payload: { reason: permResult.error.message },
      });
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
      durationMs: permissionDurationMs,
    });

    debugPermissions({
      allowedToolCount: perm.allowedToolIds.size,
      allowedToolIds: [...perm.allowedToolIds],
      hasDepartment: !!perm.department,
      departmentName: perm.department?.name,
    });

    tracer?.emit({
      phase: 'permission', eventType: 'permission_resolved', actorType: 'engine',
      title: 'Permissions resolved', status: 'success',
      payload: { allowedToolCount: perm.allowedToolIds.size, hasDepartment: !!perm.department },
    });

    const branding   = resolveBranding(perm);
    const aggregator = new RunStatusAggregator();

    // ── 2. Build status channel wrapper & send initial card immediately ───
    // Sending before history/tool-discovery so the user sees Divo respond
    // as soon as permissions are resolved (~300ms after message received).
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

    // Pre-seed status bubble for resume flows (approval resume path).
    if (existingStatusMessageId && 'restoreStatusCoordinator' in channelAdapter) {
      (channelAdapter as any).restoreStatusCoordinator(
        String(conversation.correlationId),
        existingStatusMessageId,
        String(conversation.chatId),
      );
    }

    await statusChannel.sendStatus({ kind: 'status', terminal: false, branding, timeline: { liveLabel: 'Routing…' } });

    // ── 3. Discover allowed tools ─────────────────────────────────────────
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

    const memoryContextPromise = this.searchMemoryContext({
      query: incoming.text,
      runContext,
      log,
    });

    // ── 4. Load history with poison filter ────────────────────────────────
    const historyResult = await this.deps.history.loadWindow(
      incoming.chatId as unknown as ChatId,
      { filterPoison: true, perm },
    );
    const history = historyResult.ok
      ? historyResult.value
      : { turns: [], truncated: false, tokenEstimate: 0 };

    debugHistory({
      turnCount: history.turns.length,
      truncated: history.truncated,
      tokenEstimate: history.tokenEstimate,
      turns: history.turns.map(t => ({ role: t.role, content: t.content })),
    });

    // ── 4b. Fast-path: skip supervisor for simple messages (greetings, chitchat) ──
    if (this.deps.fastPathModel && classifyMessage(incoming.text) === 'SIMPLE') {
      log.info('engine.fast_path.triggered', { messageLength: incoming.text.length });

      const fastResult = await runFastPath({
        userMessage: incoming.text,
        history:     history.turns.map(t => ({ role: t.role as 'user' | 'assistant', content: t.content })),
        model:       this.deps.fastPathModel,
        log,
      });

      const fastReply: FinalReply = {
        kind: 'final', text: fastResult.text, format: 'text', branding,
      };

      // Sequential append — sequence ordering matters (user before assistant).
      await this.deps.history.appendTurn(incoming.chatId as unknown as ChatId, {
        role: 'user', content: incoming.text, timestamp: incoming.timestamp,
      });
      await this.deps.history.appendTurn(incoming.chatId as unknown as ChatId, {
        role: 'assistant', content: fastResult.text,
        timestamp: this.deps.clock.now().toISOString(),
      });

      await channelAdapter.sendFinalReply(conversation, fastReply);

      const fpMs = this.deps.clock.nowMs() - runStartMs;
      log.info('engine.fast_path.complete', { durationMs: fpMs });
      tracer?.complete(fastResult.text.slice(0, 500));
      // memoryContextPromise runs to completion in background (no leak — it's fire-and-forget).
      return ok({ finalReply: fastReply, toolsCalled: [] });
    }

    // ── 4c. Load persistent memory context ────────────────────────────────
    const memoryContext = await memoryContextPromise;
    debugMemoryContext(memoryContext);

    // ── 4d. Load group chat context (if applicable) ──────────────────────
    let groupContext: string | undefined;
    if (incoming.chatType === 'group' && this.deps.chatContext) {
      const ctxResult = await this.deps.chatContext.loadContext(
        String(runContext.companyId), String(incoming.chatId),
      );
      if (ctxResult.ok && ctxResult.value.recentMessages.length > 0) {
        groupContext = formatGroupContextForPrompt(ctxResult.value);
      }
    }
    debugGroupContext(groupContext);

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
      ...(memoryContext ? { memoryContext } : {}),
      ...(groupContext ? { groupContext } : {}),
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

    debugFinalReply({
      finalText: supervisorResult.value.finalReply.text,
      source: 'supervisor',
      toolsCalled,
      toolResultCount: toolResults?.length ?? 0,
    });

    // ── 5b. Post-pipeline safety net — if tools ran but reply is useless,
    //    make one more LLM call to present the results properly.
    const replyAssessment = assessReplyQuality({
      userMessage: incoming.text,
      replyText:   supervisorResult.value.finalReply.text,
      toolsCalled,
      toolResults,
    });

    let presentedReply = supervisorResult.value.finalReply;
    if (replyAssessment.needsSynthesis) {
      log.warn('engine.reply_useless.synthesis_needed', {
        cleanReplyText: cleanReplyText(supervisorResult.value.finalReply.text),
        reasons: replyAssessment.reasons,
        createdTaskTitles: replyAssessment.createdTaskTitles,
        toolsCalled,
        toolResultCount: toolResults?.length ?? 0,
      });
      try {
        const toolContext = buildPresentationContext({
          userMessage: incoming.text,
          replyText:   supervisorResult.value.finalReply.text,
          toolsCalled,
          toolResults,
        });
        const synthesized = await generateText({
          model: this.deps.supervisor.getModel(),
          system: `You are presenting the results of completed actions to the user. Rules:
- Write the final user-facing outcome, not a process update.
- Use completed/past-tense language for actions that already ran.
- If Lark tasks were created, list the task titles and include owner/location when available.
- If an internal Divo checklist was updated, do not call it a Lark Task.
- If a previous attempt only updated an internal checklist, say that plainly before saying what was corrected.
- Preserve important details: titles, counts, IDs, dates, amounts, links, errors, and partial failures.
- Do not mention tool names or agent names. Mention the Divo checklist only when needed to correct a mistaken Lark-task claim.
- Be direct — no filler phrases.
- If no meaningful data was returned by tools, say so plainly.`,
          messages: [
            { role: 'user' as const, content: incoming.text },
            { role: 'assistant' as const, content: `Actions completed. Results:\n\n${toolContext || '(no data returned)'}` },
            { role: 'user' as const, content: 'Present these results to me.' },
          ],
          temperature: 0.3,
          abortSignal: AbortSignal.timeout(30_000),
        });
        if (synthesized.text.trim()) {
          presentedReply = { ...supervisorResult.value.finalReply, text: synthesized.text.trim() };
          log.info('engine.reply_useless.synthesis_done', { textLength: synthesized.text.length });
        }
      } catch (e) {
        log.warn('engine.reply_useless.synthesis_failed', { error: String(e) });
      }
    }

    const executionTrace = aggregator.getExecutionTrace();
    const finalReply: FinalReply = {
      ...presentedReply,
      branding,
      ...(executionTrace ? { executionTrace } : {}),
    };
    const executionLog = buildExecutionSummary(toolResults);
    const assistantHistoryContent = executionLog
      ? `${executionLog}\n\n[Reply]\n${finalReply.text}`
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
    debugRunEnd({
      durationMs: this.deps.clock.nowMs() - runStartMs,
      finalReply: finalReply.text,
      toolsCalled,
    });
    await channelAdapter.sendFinalReply(conversation, finalReply);

    // ── 8. Background memory extraction ───────────────────────────────────
    if (this.deps.mem0) {
      const mem0 = this.deps.mem0;
      const extractionContext = {
        userId:         String(runContext.userId),
        companyId:      String(runContext.companyId),
        ...(runContext.departmentId ? { departmentId: String(runContext.departmentId) } : {}),
        userRole:       String(runContext.companyRole),
        userMessage:    incoming.text,
        assistantReply: finalReply.text,
      };
      setImmediate(() => {
        mem0.extractAndStore(extractionContext)
          .then(summary => {
            tracer?.emit({
              phase: 'complete',
              eventType: 'memory_extracted',
              actorType: 'mem0',
              title: 'Memory extraction complete',
              status: 'info',
              payload: {
                userId: runContext.userId,
                attemptedScopes: summary.attemptedScopes,
                storedMemories: summary.storedMemories,
                scopes: summary.scopes,
              },
            });
          })
          .catch(error => {
            log.warn('engine.mem0.extract_failed', { error: String(error) });
          });
      });
    }

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

  private async searchMemoryContext(input: {
    readonly query: string;
    readonly runContext: RunContext;
    readonly log: Logger;
  }): Promise<string> {
    if (!this.deps.mem0) return '';

    const startedAtMs = this.deps.clock.nowMs();
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<string>(resolve => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        input.log.warn('engine.mem0.search_timeout', {
          timeoutMs: MEM0_SEARCH_TIMEOUT_MS,
          durationMs: this.deps.clock.nowMs() - startedAtMs,
        });
        resolve('');
      }, MEM0_SEARCH_TIMEOUT_MS);
    });

    try {
      const searchPromise = this.deps.mem0.searchForContext({
        query:     input.query,
        userId:    String(input.runContext.userId),
        companyId: String(input.runContext.companyId),
        ...(input.runContext.departmentId ? { departmentId: String(input.runContext.departmentId) } : {}),
      });

      const memoryContext = await Promise.race([searchPromise, timeoutPromise]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (!timedOut) {
        input.log.info('engine.mem0.search_done', {
          durationMs: this.deps.clock.nowMs() - startedAtMs,
          hasMemoryContext: memoryContext.length > 0,
        });
      }
      return memoryContext;
    } catch (error) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      input.log.warn('engine.mem0.search_failed', {
        durationMs: this.deps.clock.nowMs() - startedAtMs,
        error: String(error),
      });
      return '';
    }
  }
}

export interface SupervisorToolResultLogEntry {
  readonly toolName: string;
  readonly output: string;
}
