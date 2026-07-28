import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { OrchestrationError, type AppError } from '../../../shared/errors';
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
import type { ConversationSummarizer } from './conversation-summarizer';
import type { LanguageModel } from 'ai';
import { classifyMessage, runFastPath } from './fast-path';
import { buildExecutionSummary } from './execution-summary';
import { LARK_ENGLISH_OUTPUT_POLICY } from '../lark-language-policy';
import {
  assessReplyQuality,
  buildCompactPresentationContext,
  buildDeterministicRecoveryReply,
  buildPresentationContext,
  cleanReplyText,
} from './reply-quality';
import type { LarkChatContextService } from '../../chat-context/lark-chat-context.service';
import type {
  LarkInferenceService,
  LarkModelId,
} from '../../proxy/lark-inference.service';
import { formatGroupContextForPrompt, formatGroupContextMultimodal } from '../../chat-context/group-context-formatter';
import type { GroupChatWindow } from '../../../domain/conversation/group-context';
import {
  debugRunStart, debugPermissions, debugHistory,
  debugMemoryContext, debugGroupContext, debugFinalReply, debugRunEnd,
} from '../../../shared/debug-run-log';
import { generateText } from 'ai';
import type { ConversationScope } from '../../../domain/conversation/conversation-scope';
import { conversationKeyForMessage } from '../../../domain/conversation/conversation-key';
import { userHistoryContent } from '../../../domain/conversation/history-content';
import { userFacingMessageOf } from '../../../shared/user-facing-error';

const MEM0_SEARCH_TIMEOUT_MS = 500;

const SUBJECT_MAX_CHARS = 52;
const VOICE_TRANSCRIPT_REDACTED = '[voice transcript redacted]';
const VOICE_HISTORY_PLACEHOLDER = '[Voice note transcript omitted after processing.]';

/**
 * Title the status card with the user's own words. Deliberately mechanical — no
 * model call, because this runs before the first token and must not delay the
 * card that tells the user Divo heard them.
 */
/** Flatten to plain prose — the card header is a plain_text field, so markup would render literally. */
function flattenRequest(text: string): string {
  return (text ?? '')
    .replace(/@_user_\d+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function summarizeRequest(text: string): string | undefined {
  const flat = flattenRequest(text);
  if (!flat) return undefined;

  // "Hi. Pull the overdue invoices." must title the card with the request, not
  // the greeting — so a stub first sentence falls through to the full text.
  const sentences = flat.split(/(?<=[.!?])\s+/);
  const first = sentences[0]?.replace(/[.!?,;:]+$/u, '').trim() ?? '';
  const isStub = first.length < 15 || first.split(/\s+/).filter(Boolean).length < 3;
  const source = isStub && sentences.length > 1
    ? sentences.slice(1).join(' ').trim()
    : first;

  const trimmed = source.replace(/[.!?,;:]+$/u, '').trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= SUBJECT_MAX_CHARS) return trimmed;

  // Cut on a word boundary so the header never ends mid-word.
  const cut = trimmed.slice(0, SUBJECT_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function withoutCurrentIncomingMessage(window: GroupChatWindow, incomingMessageId: string): GroupChatWindow {
  const recentMessages = window.recentMessages.filter(message => message.id !== incomingMessageId);
  if (recentMessages.length === window.recentMessages.length) {
    return window;
  }

  return {
    ...window,
    recentMessages,
  };
}

// ─── Public I/O types ──────────────────────────────────────────────────────

export interface EngineInput {
  incoming: IncomingMessage;
  runContext: RunContext;
  conversation: ConversationHandle;
  channelAdapter: ChannelAdapter;
  /** Cancels this run when its channel execution lane times out. */
  abortSignal?: AbortSignal;
  /** When provided, non-read tool actions are routed through the approval gate. */
  approvalGate?: ApprovalGateService;
  /** Pre-seeded statusMessageId for resume flows (so same bubble is updated). */
  existingStatusMessageId?: string;
  /** Internal test/run control. LarkInferenceService still enforces model policy. */
  larkModelId?: LarkModelId;
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
  /** When provided, fires background summarization for the current conversation key. */
  conversationSummarizer?: ConversationSummarizer;
  /** Backend-owned DeepSeek Flash model factory for first-class Lark runs. */
  larkInference?: LarkInferenceService;
}

// ─── Engine ───────────────────────────────────────────────────────────────

export class OrchestrationEngine {
  constructor(private readonly deps: OrchestrationEngineDeps) {}

  async run(input: EngineInput): Promise<Result<EngineOutput, AppError>> {
    const { incoming, runContext, conversation, channelAdapter, approvalGate, existingStatusMessageId } = input;
    const runStartMs = this.deps.clock.nowMs();
    const conversationScope: ConversationScope = {
      companyId: String(runContext.companyId),
      channel: runContext.channel,
    };
    // One canonical conversation key scopes history, approvals, summaries,
    // telemetry, and per-run tools. Actual Lark delivery still uses chatId.
    const conversationKey = conversationKeyForMessage({
      chatId: String(incoming.chatId),
      chatType: incoming.chatType,
      messageId: String(incoming.messageId),
      ...(incoming.threadId ? { threadId: String(incoming.threadId) } : {}),
      ...(incoming.rootMessageId ? { rootMessageId: String(incoming.rootMessageId) } : {}),
      userExternalId: incoming.userExternalId,
      ...(incoming.groupReplyMode ? { groupReplyMode: incoming.groupReplyMode } : {}),
    }) as unknown as ChatId;

    const log = this.deps.logger.child({
      chatId:    incoming.chatId,
      traceId:   runContext.traceId ?? incoming.traceId,
      userId:    runContext.userId,
      companyId: runContext.companyId,
    });
    const hasVoiceTranscript = incoming.attachments.some(attachment => attachment.type === 'audio');
    const telemetryUserMessage = hasVoiceTranscript
      ? VOICE_TRANSCRIPT_REDACTED
      : incoming.text;
    const historyUserMessage = hasVoiceTranscript
      ? VOICE_HISTORY_PLACEHOLDER
      : incoming.text;

    const abortController = new AbortController();
    if (input.abortSignal?.aborted) {
      abortController.abort(input.abortSignal.reason);
    } else {
      input.abortSignal?.addEventListener(
        'abort',
        () => abortController.abort(input.abortSignal?.reason),
        { once: true },
      );
    }
    if ('registerAbortController' in channelAdapter) {
      const corrId = String(runContext.traceId ?? incoming.traceId);
      (channelAdapter as any).registerAbortController(corrId, abortController, {
        userId: String(runContext.userId),
        companyId: String(runContext.companyId),
        conversationKey: String(conversationKey),
      });
    }

    try {
    log.info('engine.run.start', { userMessage: telemetryUserMessage.slice(0, 100) });

    debugRunStart({
      chatId: String(incoming.chatId),
      userId: String(runContext.userId),
      companyId: String(runContext.companyId),
      userMessage: telemetryUserMessage,
      traceId: runContext.traceId ?? incoming.traceId,
    });

    // ── 0. Create ExecutionRun trace record ────────────────────────────────
    let tracer: OrchestrationTracer | undefined;

    if (this.deps.executionRepo) {
      try {
        const runId = await this.deps.executionRepo.create({
          companyId:  runContext.companyId,
          channel:    runContext.channel,
          entrypoint: runContext.channel === 'lark' ? 'lark_webhook' : `${runContext.channel}_channel`,
          ...(runContext.userId    ? { userId:     runContext.userId }              : {}),
          ...(runContext.requestId ? { requestId:  runContext.requestId }           : {}),
          ...(incoming.chatId     ? { chatId:     String(incoming.chatId) }        : {}),
          ...(incoming.chatId     ? { threadId:   String(conversationKey) }        : {}),
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

    // This per-run wrapper resolves backend-held credentials, enforces the
    // exact requested/default model through shared policy, and records every
    // model call against the same ExecutionRun created above.
    const larkModel = runContext.channel === 'lark' && this.deps.larkInference
      ? await this.deps.larkInference.createModel({
        runContext,
        ...(tracer ? { executionRunId: tracer.executionRunId } : {}),
        ...(tracer ? { tracer } : {}),
        threadId: String(conversationKey),
        agentTarget: 'lark.orchestration',
        ...(input.larkModelId ? { requestedModelId: input.larkModelId } : {}),
      })
      : undefined;

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
    abortController.signal.throwIfAborted();
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
    aggregator.setSubject(summarizeRequest(incoming.text));

    // ── 2. Build status channel wrapper & send initial card immediately ───
    // Sending before history/tool-discovery so the user sees Divo respond
    // as soon as permissions are resolved (~300ms after message received).
    let currentStatusHandle: StatusHandle | null = null;
    const adapterAny = channelAdapter as unknown as {
      emitToolStart?: (event: Parameters<NonNullable<StatusChannel['emitToolStart']>>[0]) => void;
      emitToolEnd?: (event: Parameters<NonNullable<StatusChannel['emitToolEnd']>>[0]) => void;
      emitTextDelta?: (delta: string) => void;
    };
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
      ...(adapterAny.emitToolStart ? { emitToolStart: (e) => adapterAny.emitToolStart!(e) } : {}),
      ...(adapterAny.emitToolEnd ? { emitToolEnd: (e) => adapterAny.emitToolEnd!(e) } : {}),
      ...(adapterAny.emitTextDelta ? { emitTextDelta: (d) => adapterAny.emitTextDelta!(d) } : {}),
    };

    // Pre-seed status bubble for resume flows (approval resume path).
    if (existingStatusMessageId && 'restoreStatusCoordinator' in channelAdapter) {
      (channelAdapter as any).restoreStatusCoordinator(
        String(conversation.correlationId),
        existingStatusMessageId,
        String(conversation.chatId),
      );
    }

    const statusPromise = statusChannel.sendStatus({
      kind: 'status', terminal: false, branding,
      timeline: aggregator.snapshot(),
    });

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
      await statusPromise;
      abortController.signal.throwIfAborted();
      await channelAdapter.sendFinalReply(conversation, noToolsReply);
      return ok({ finalReply: noToolsReply, toolsCalled: [] });
    }

    // ── 4. Load pre-supervisor context in parallel ────────────────────────
    // Scheduled runs are compiled to be self-contained. Their target can be an
    // originating chat or a synthetic runtime destination such as a creator
    // open_id, so loading interactive history would be wrong in either case.
    const isScheduledDelivery = runContext.deliveryMode === 'current_chat_only'
      || runContext.deliveryMode === 'scheduled_runtime_delivery';
    const isNativeThreadReply = incoming.chatType === 'group'
      && incoming.groupReplyMode !== 'inline'
      && Boolean(incoming.rootMessageId || incoming.threadId);
    const shouldLoadGroupContext = incoming.chatType === 'group'
      && !isNativeThreadReply;
    const [historyResult, memoryContext, groupContextResult] = await Promise.all([
      isScheduledDelivery
        ? Promise.resolve({ ok: true as const, value: { turns: [], truncated: false, tokenEstimate: 0 } })
        : this.deps.history.loadWindow(
            conversationKey,
            { filterPoison: true, perm, includeSummary: true, scope: conversationScope },
          ),
      isScheduledDelivery
        ? Promise.resolve(undefined)
        : this.searchMemoryContext({
        query: incoming.text,
        runContext,
        log,
      }),
      shouldLoadGroupContext && this.deps.chatContext
        ? this.deps.chatContext.loadContext(String(runContext.companyId), String(incoming.chatId))
        : Promise.resolve(null),
      statusPromise,
    ]);
    abortController.signal.throwIfAborted();
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
        model:       larkModel ?? this.deps.fastPathModel,
        log,
        abortSignal: abortController.signal,
      });

      const fastReply: FinalReply = {
        kind: 'final', text: fastResult.text, format: 'text', branding,
      };

      abortController.signal.throwIfAborted();
      // Sequential append — sequence ordering matters (user before assistant).
      await this.deps.history.appendTurn(conversationKey, {
        role: 'user',
        content: userHistoryContent(incoming, historyUserMessage),
        timestamp: incoming.timestamp,
      }, conversationScope);
      abortController.signal.throwIfAborted();
      await this.deps.history.appendTurn(conversationKey, {
        role: 'assistant', content: fastResult.text,
        timestamp: this.deps.clock.now().toISOString(),
      }, conversationScope);

      if (this.deps.conversationSummarizer) {
        const summaryKey = String(conversationKey);
        setImmediate(() => {
          this.deps.conversationSummarizer!.maybeSummarize(summaryKey, conversationScope, larkModel)
            .catch(e => log.warn('engine.summarization.failed', { error: String(e) }));
        });
      }

      abortController.signal.throwIfAborted();
      await channelAdapter.sendFinalReply(conversation, fastReply);

      const fpMs = this.deps.clock.nowMs() - runStartMs;
      log.info('engine.fast_path.complete', { durationMs: fpMs });
      tracer?.complete(fastResult.text.slice(0, 500));
      return ok({ finalReply: fastReply, toolsCalled: [] });
    }

    // ── 4c. Loaded persistent memory context ─────────────────────────────
    if (memoryContext) debugMemoryContext(memoryContext);

    // ── 4d. Loaded group chat context (if applicable) ────────────────────
    const isGroupWithContext = incoming.chatType === 'group'
      && groupContextResult?.ok
      && groupContextResult.value.recentMessages.length > 0;

    const historicalGroupWindow = isGroupWithContext
      ? withoutCurrentIncomingMessage(groupContextResult!.value, String(incoming.messageId))
      : undefined;
    const groupContextWindow = historicalGroupWindow
      && (historicalGroupWindow.recentMessages.length > 0 || historicalGroupWindow.summary)
      ? historicalGroupWindow
      : undefined;
    const groupContext = groupContextWindow
      ? formatGroupContextForPrompt(groupContextWindow)
      : undefined;

    const multimodalCtx = groupContextWindow
      ? formatGroupContextMultimodal(groupContextWindow)
      : undefined;

    debugGroupContext(groupContext);

    const supervisorHistory = history;

    // ── 5. Run supervisor ─────────────────────────────────────────────────
    log.info('engine.pre_supervisor.duration', { ms: this.deps.clock.nowMs() - runStartMs });
    // P2P inline images — pass as multimodal content parts (same path as group images)
    const inlineImageUrls = incoming.imageUrls ?? [];

    const supervisorResult = await this.deps.supervisor.run({
      userMessage:    incoming.text,
      history:        supervisorHistory,
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
      ...('summary' in supervisorHistory && supervisorHistory.summary ? { conversationSummary: supervisorHistory.summary } : {}),
      ...(groupContext ? { groupContext } : {}),
      ...(multimodalCtx?.hasImages ? { groupContextParts: multimodalCtx.parts, groupContextSystemHeader: multimodalCtx.systemHeader } : {}),
      ...(inlineImageUrls.length > 0 ? { inlineImageUrls } : {}),
      chatId:         String(conversationKey),
      abortSignal:    abortController.signal,
      ...(larkModel ? {
        model: larkModel,
        // Dynamic root-agent model overrides are ignored for Lark by design.
        resolveModel: async () => larkModel,
      } : {}),
    });

    if (abortController.signal.aborted) {
      log.info('engine.run.interrupted', { durationMs: this.deps.clock.nowMs() - runStartMs });
      if (input.abortSignal?.aborted) {
        return err(new OrchestrationError({
          stage: 'execute',
          reason: 'canceled',
          cause: input.abortSignal.reason,
        }));
      }
      tracer?.fail('interrupted', 'Run interrupted by user');
      const interruptReply: FinalReply = {
        kind: 'final', text: 'Run interrupted.', format: 'text', branding,
      };
      await channelAdapter.sendFinalReply(conversation, interruptReply);
      return ok({ finalReply: interruptReply, toolsCalled: [] });
    }

    if (!supervisorResult.ok) {
      log.error('engine.supervisor.failed', { error: supervisorResult.error.message });
      tracer?.fail('supervisor_failed', supervisorResult.error.message);
      // A refusal the user can act on — "Pro is not enabled for this account",
      // "monthly budget reached" — is the answer, not a symptom. Only errors
      // that opted in are shown; everything else stays generic, because most
      // failures carry provider payloads and internal identifiers.
      const explained = userFacingMessageOf(supervisorResult.error);
      const errReply: FinalReply = {
        kind: 'final',
        text: explained ?? 'Something went wrong. Please try again.',
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
    //    retry presentation with compact evidence before a deterministic fallback.
    const replyAssessment = assessReplyQuality({
      userMessage: incoming.text,
      replyText:   supervisorResult.value.finalReply.text,
      toolsCalled,
      toolResults,
    });

    let presentedReply = {
      ...supervisorResult.value.finalReply,
      text: cleanReplyText(supervisorResult.value.finalReply.text),
    };
    if (replyAssessment.needsSynthesis) {
      log.warn('engine.reply_useless.synthesis_needed', {
        cleanReplyText: cleanReplyText(supervisorResult.value.finalReply.text),
        reasons: replyAssessment.reasons,
        createdTaskTitles: replyAssessment.createdTaskTitles,
        toolsCalled,
        toolResultCount: toolResults?.length ?? 0,
      });
      const synthesisInput = {
        userMessage: incoming.text,
        replyText:   supervisorResult.value.finalReply.text,
        toolsCalled,
        toolResults,
      };
      const contexts = [
        buildPresentationContext(synthesisInput),
        buildCompactPresentationContext(synthesisInput),
      ];
      let synthesizedReply = '';
      for (const [attemptIndex, toolContext] of contexts.entries()) {
        try {
          const synthesized = await generateText({
            model: larkModel ?? this.deps.supervisor.getModel(),
            system: `You are presenting the results of completed actions to the user. Rules:
- Write the final user-facing outcome, not a process update.
- Use completed/past-tense language for actions that already ran.
- If Lark tasks were created, list the task titles and include owner/location when available.
- If an internal Divo checklist was updated, do not call it a Lark Task.
- If a previous attempt only updated an internal checklist, say that plainly before saying what was corrected.
- Preserve important details: titles, counts, IDs, dates, amounts, links, errors, and partial failures.
- Do not mention tool names or agent names. Mention the Divo checklist only when needed to correct a mistaken Lark-task claim.
- Be direct — no filler phrases.
- If no meaningful data was returned by tools, say so plainly.
${incoming.channel === 'lark' ? `- ${LARK_ENGLISH_OUTPUT_POLICY}` : ''}`,
            messages: [
              { role: 'user' as const, content: incoming.text },
              { role: 'assistant' as const, content: `Actions completed. Results:\n\n${toolContext || '(no data returned)'}` },
              { role: 'user' as const, content: 'Present these results to me.' },
            ],
            temperature: 0.3,
            abortSignal: AbortSignal.any([
              AbortSignal.timeout(30_000),
              abortController.signal,
            ]),
          });
          synthesizedReply = synthesized.text.trim();
          if (synthesizedReply) {
            presentedReply = { ...supervisorResult.value.finalReply, text: synthesizedReply };
            log.info('engine.reply_useless.synthesis_done', {
              attempt: attemptIndex + 1,
              textLength: synthesizedReply.length,
            });
            break;
          }
        } catch (e) {
          log.warn('engine.reply_useless.synthesis_failed', {
            attempt: attemptIndex + 1,
            error: String(e),
          });
        }
      }
      if (!synthesizedReply) {
        presentedReply = {
          ...supervisorResult.value.finalReply,
          text: buildDeterministicRecoveryReply(toolResults),
        };
        log.warn('engine.reply_useless.deterministic_fallback', {
          textLength: presentedReply.text.length,
        });
      }
    }

    abortController.signal.throwIfAborted();

    const executionTrace = isScheduledDelivery ? undefined : aggregator.getExecutionTrace();
    const finalReply: FinalReply = {
      ...presentedReply,
      branding,
      ...(executionTrace ? { executionTrace } : {}),
    };
    const executionLog = incoming.chatType === 'group'
      ? null
      : buildExecutionSummary(toolResults);
    const assistantHistoryContent = executionLog
      ? `${executionLog}\n\n[Reply]\n${finalReply.text}`
      : finalReply.text;

    // ── 6. Persist conversation turn ──────────────────────────────────────
    await this.deps.history.appendTurn(conversationKey, {
      role:      'user',
      content:   userHistoryContent(incoming, historyUserMessage),
      timestamp: incoming.timestamp,
    }, conversationScope);
    abortController.signal.throwIfAborted();
    await this.deps.history.appendTurn(conversationKey, {
      role:      'assistant',
      content:   assistantHistoryContent,
      timestamp: this.deps.clock.now().toISOString(),
    }, conversationScope);
    abortController.signal.throwIfAborted();

    // ── 6b. Background per-conversation summarization ───────────────────
    if (
      !isScheduledDelivery
      && this.deps.conversationSummarizer
    ) {
      const summaryKey = String(conversationKey);
      setImmediate(() => {
        this.deps.conversationSummarizer!.maybeSummarize(summaryKey, conversationScope, larkModel)
          .catch(e => log.warn('engine.summarization.failed', { error: String(e) }));
      });
    }

    // ── 7. Send final reply ───────────────────────────────────────────────
    debugRunEnd({
      durationMs: this.deps.clock.nowMs() - runStartMs,
      finalReply: finalReply.text,
      toolsCalled,
    });
    abortController.signal.throwIfAborted();
    let deliveryResult = await channelAdapter.sendFinalReply(conversation, finalReply);

    // If delivery failed (card too large, Lark API error, etc.), condense
    // with LLM and retry. The user should see a clean card — never raw dumps
    // or error states.
    if (
      !deliveryResult.ok
      && deliveryResult.error.payload.reason !== 'partial_delivery'
      && deliveryResult.error.payload.reason !== 'ambiguous_delivery'
    ) {
      log.warn('engine.delivery.condensing', {
        originalLength: finalReply.text.length,
        correlationId: String(conversation.correlationId),
      });
      try {
        const condensed = await generateText({
          model: larkModel ?? this.deps.supervisor.getModel(),
          system: `You are reformatting a response that was too large to display. Condense it into clean markdown under 3000 characters. Keep key data, numbers, and structure. Use tables with max 10 rows. Do not mention truncation or condensation — write as if this is the original response.${incoming.channel === 'lark' ? ` ${LARK_ENGLISH_OUTPUT_POLICY}` : ''}`,
          messages: [
            { role: 'user' as const, content: incoming.text },
            { role: 'assistant' as const, content: finalReply.text },
            { role: 'user' as const, content: 'Rewrite this response more concisely.' },
          ],
          temperature: 0.3,
          abortSignal: AbortSignal.any([
            AbortSignal.timeout(30_000),
            abortController.signal,
          ]),
        });
        if (condensed.text.trim()) {
          const condensedReply: FinalReply = { ...finalReply, text: condensed.text.trim() };
          deliveryResult = await channelAdapter.sendFinalReply(conversation, condensedReply);
          if (deliveryResult.ok) {
            log.info('engine.delivery.condensed_ok', { condensedLength: condensed.text.length });
          }
        }
      } catch (e) {
        log.warn('engine.delivery.condense_failed', { error: String(e) });
      }

    }

    if (!deliveryResult.ok) {
      log.error('engine.delivery.failed', {
        error: deliveryResult.error.message,
        reason: deliveryResult.error.payload.reason,
        replyLength: finalReply.text.length,
      });
      tracer?.emit({
        phase: 'complete', eventType: 'delivery_failed', actorType: 'engine',
        title: deliveryResult.error.payload.reason === 'partial_delivery'
          ? 'Final reply was partially delivered'
          : 'Final reply delivery failed',
        status: 'error',
        payload: {
          error: deliveryResult.error.message,
          reason: deliveryResult.error.payload.reason,
          replyLength: finalReply.text.length,
        },
      });
      return err(new OrchestrationError({
        stage: 'compose',
        reason: 'step_failed',
        cause: deliveryResult.error,
        message: deliveryResult.error.message,
      }));
    }

    abortController.signal.throwIfAborted();

    // ── 8. Background memory extraction ───────────────────────────────────
    if (this.deps.mem0) {
      const mem0 = this.deps.mem0;
      const extractionContext = {
        userId:         String(runContext.userId),
        companyId:      String(runContext.companyId),
        ...(runContext.departmentId ? { departmentId: String(runContext.departmentId) } : {}),
        userRole:       String(runContext.companyRole),
        userMessage:    historyUserMessage,
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
    } catch (error) {
      if (abortController.signal.aborted) {
        log.info('engine.run.canceled', { durationMs: this.deps.clock.nowMs() - runStartMs });
        if (!input.abortSignal?.aborted) {
          const interruptReply: FinalReply = {
            kind: 'final',
            text: 'Run interrupted.',
            format: 'text',
          };
          await channelAdapter.sendFinalReply(conversation, interruptReply);
          return ok({ finalReply: interruptReply, toolsCalled: [] });
        }
        return err(new OrchestrationError({
          stage: 'execute',
          reason: 'canceled',
          cause: error,
        }));
      }
      throw error;
    } finally {
      if ('cleanupAbortController' in channelAdapter) {
        (channelAdapter as any).cleanupAbortController(String(runContext.traceId ?? incoming.traceId));
      }
    }
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
