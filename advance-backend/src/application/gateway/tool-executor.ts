import type { ToolRegistry } from '../tools/tool-registry';
import type { PermissionService } from '../permissions/permission.service';
import type { PermissionResult } from '../permissions/permission.types';
import type { ApprovalGateService } from '../approval/approval-gate.service';
import { buildArgsSummary } from './args-summary';
import type { ToolExecutionContext } from '../tools/tool.contract';
import type { Tool } from '../tools/tool.contract';
import type { RunContext } from '../../domain/orchestration/run-context';
import type { Logger } from '../../shared/logger';
import type { Clock } from '../../shared/clock';
import type { ConnectionRateLimitService } from '../governance/connection-rate-limit.service';
import type { ConnectionRegistryPort } from '../connections/connection-registry.port';
import { publicConnectionChoices, selectAccessibleConnection } from '../connections/accessible-connection-selection';
import { listAccessibleConnectionsFor } from './work-bootstrap.service';
import { CONNECTION_PROVIDER_LABELS, type ConnectionProvider } from '../../domain/connections/connection-provider';
import { asCompanyId, asDepartmentId, asToolId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import { randomUUID } from 'node:crypto';
import type {
  GatewayExecutionContext,
  GatewayMemberContext,
  GatewayResponse,
} from './gateway.types';
import { gatewayFailure, gatewaySuccess } from './gateway.types';
import { SCHEDULED_SESSION_AUTH_PROVIDER } from '../scheduling/scheduled-runtime-session';
import { limitLocalFileResult, limitModelFacingResult } from './model-facing-result-limit';
import {
  classifyShopifyProtectedResult,
  isProtectedShopifyToolId,
  isShopifyToolId,
  type ShopifyProtectedResult,
} from '../shopify/shopify-protected-result';

export interface ToolExecutorInput {
  readonly member: GatewayMemberContext;
  readonly departmentId?: string;
  readonly toolId: string;
  readonly args: Record<string, unknown>;
  readonly requestId?: string;
  /** Non-authoritative runtime provenance for one isolated Pi action. */
  readonly execution?: GatewayExecutionContext;
  /** Optional invariant used by prepared commits to prevent action reclassification. */
  readonly expectedAction?: ToolActionGroup;
}

export interface ToolExecutorDeps {
  readonly toolRegistry: ToolRegistry;
  readonly permissions: PermissionService;
  readonly approvalGate?: ApprovalGateService;
  /** Optional during staged rollout; when configured this is the sole live connection budget authority. */
  readonly connectionRateLimits?: ConnectionRateLimitService;
  /** Resolves request-scoped connected accounts for backend-hosted channels. */
  readonly connectionRegistry?: ConnectionRegistryPort;
  /**
   * Server-owned monotonic classification for runs that invoke protected
   * data tools. Production must wire this before protected tools are enabled.
   */
  readonly protectedDataRuns?: {
    observe(input: {
      readonly companyId: string;
      readonly userId: string;
      readonly channel: string;
      readonly runId: string;
      readonly threadId?: string;
    }): Promise<void>;
  };
  /** Records exact tenant/shop provenance before a successful Shopify result is returned. */
  readonly shopifyDataRuns?: {
    record(input: {
      readonly companyId: string;
      readonly userId: string;
      readonly channel: string;
      readonly runId: string;
      readonly threadId?: string;
      readonly connectionId: string;
      readonly toolId: string;
    }): Promise<void>;
  };
  readonly logger: Logger;
  readonly clock: Clock;
}

/**
 * A channel has already resolved the authenticated member and permission
 * snapshot, but still needs to execute through the same validation, approval,
 * and tool-runtime path as the desktop gateway. This prevents Lark's agent
 * tool from becoming a second policy implementation.
 */
export interface RuntimeToolExecutionInput {
  readonly toolId: string;
  readonly args: Record<string, unknown>;
  readonly runContext: RunContext;
  readonly perm: PermissionResult;
  readonly execution?: GatewayExecutionContext;
  readonly allowedToolIds?: ReadonlySet<string>;
  readonly approvalGate?: ApprovalGateService;
  readonly chatId?: string;
  readonly onProgress?: (message: string) => void;
  readonly expectedAction?: ToolActionGroup;
  readonly abortSignal?: AbortSignal;
}

export interface RuntimeToolExecutionOutcome {
  readonly status: Extract<GatewayResponse['status'],
    'success' | 'unknown_tool' | 'invalid_args' | 'permission_denied'
    | 'approval_required' | 'approval_rejected' | 'approval_execution_failed'
    | 'approval_misconfigured'
    | 'rate_limited' | 'rate_limit_unavailable' | 'tool_error'>;
  readonly toolId: string;
  readonly action?: ToolActionGroup;
  readonly result?: unknown;
  readonly message?: string;
  readonly approvalId?: string;
  readonly protectedData?: ShopifyProtectedResult;
}

export interface RuntimeToolPreflightOutcome {
  readonly status: RuntimeToolExecutionOutcome['status'];
  readonly toolId: string;
  readonly action?: ToolActionGroup;
  readonly validation?: Record<string, unknown>;
  readonly message?: string;
}

function limitGatewayResult(member: GatewayMemberContext, value: unknown): unknown {
  return member.resultAudience === 'local_file'
    ? limitLocalFileResult(value)
    : limitModelFacingResult(value);
}

export interface PreparedToolInvocation {
  readonly toolId: string;
  readonly action: ToolActionGroup;
  readonly args: Record<string, unknown>;
}

export interface PreflightedToolInvocation extends PreparedToolInvocation {
  readonly validation: Record<string, unknown>;
}

interface ResolvedToolInvocation extends PreparedToolInvocation {
  readonly tool: Tool<unknown, unknown>;
  readonly perm: PermissionResult;
  readonly runContext: RunContext;
  readonly effectiveDepartmentId?: string;
}

interface ResolvedRuntimeToolInvocation {
  readonly tool: Tool<unknown, unknown>;
  readonly toolId: string;
  readonly action: ToolActionGroup;
  readonly args: Record<string, unknown>;
}

type ResolveToolInvocationResult =
  | { readonly ok: true; readonly value: ResolvedToolInvocation }
  | { readonly ok: false; readonly response: GatewayResponse };

type ResolveRuntimeToolInvocationResult =
  | { readonly ok: true; readonly value: ResolvedRuntimeToolInvocation }
  | { readonly ok: false; readonly outcome: RuntimeToolExecutionOutcome };

export class ToolExecutor {
  constructor(private readonly deps: ToolExecutorDeps) {}

  /** Validate and authorize a proposed invocation without running approval gates or tool code. */
  async prepare(input: ToolExecutorInput): Promise<GatewayResponse<PreparedToolInvocation>> {
    const resolved = await this.resolve(input);
    if (!resolved.ok) return resolved.response as GatewayResponse<PreparedToolInvocation>;

    return gatewaySuccess({
      toolId: resolved.value.toolId,
      action: resolved.value.action,
      args: resolved.value.args,
    });
  }

  /** Validate permission plus any tool-owned, side-effect-free readiness contract. */
  async preflight(input: ToolExecutorInput): Promise<GatewayResponse<PreflightedToolInvocation>> {
    const resolved = await this.resolve(input);
    if (!resolved.ok) return resolved.response as GatewayResponse<PreflightedToolInvocation>;

    const { tool, args, perm, runContext, action, toolId } = resolved.value;
    let validation: Record<string, unknown> = { level: 'permission_only' };
    if (tool.preflight) {
      const checked = await tool.preflight(args, {
        runContext,
        perm,
        correlationId: input.requestId ?? input.execution?.actionId ?? randomUUID(),
        logger: this.deps.logger.child({ toolId: tool.id, operation: 'preflight' }),
        clock: this.deps.clock,
      });
      if (!checked.ok) {
        const status = checked.error.payload.reason === 'bad_args' ? 'invalid_args' : 'tool_error';
        return gatewayFailure(status, checked.error.message) as GatewayResponse<PreflightedToolInvocation>;
      }
      validation = checked.value;
    }

    const rate = await this.preflightRateLimit({
      companyId: runContext.companyId,
      toolFamily: tool.family,
      action,
      args,
    });
    if (rate) return rate as GatewayResponse<PreflightedToolInvocation>;

    return gatewaySuccess({ toolId, action, args, validation });
  }

  async invoke(input: ToolExecutorInput): Promise<GatewayResponse> {
    const resolved = await this.resolve(input);
    if (!resolved.ok) return resolved.response;
    if (input.expectedAction && resolved.value.action !== input.expectedAction) {
      return gatewayFailure(
        'invalid_args',
        `Tool action changed from "${input.expectedAction}" to "${resolved.value.action}" after preparation`,
      );
    }

    const { member } = input;
    const {
      tool,
      action,
      args: validatedArgs,
      perm,
      runContext,
      effectiveDepartmentId,
    } = resolved.value;

    const ratePreflight = await this.preflightRateLimit({
      companyId: runContext.companyId,
      toolFamily: tool.family,
      action,
      args: validatedArgs,
    });
    if (ratePreflight) return ratePreflight;

    let executionGrant: {
      approvalId: string;
      authority: 'connection_owner' | 'company_admin' | 'department_manager';
    } | undefined;

    // A connection policy can require its owner even when the caller did not
    // select a department. The gate itself preserves the old no-department
    // behaviour for ordinary department-based approval rules.
    if (this.deps.approvalGate && isProtectedShopifyToolId(String(tool.id))) {
      const requirement = await this.deps.approvalGate.inspect({
        toolId: tool.id,
        action,
        args: validatedArgs,
        perm,
        runContext,
      });
      if (requirement.kind === 'required') {
        return gatewayFailure(
          'approval_misconfigured',
          'Protected Shopify reads cannot be stored in a durable approval request. Grant direct read access or deny this capability.',
        );
      }
      if (requirement.kind === 'misconfigured') {
        return gatewayFailure('approval_misconfigured', requirement.message);
      }
    } else if (this.deps.approvalGate) {
      const argsSummary = buildArgsSummary(tool.id, action, validatedArgs);
      const decision = await this.deps.approvalGate.check({
        toolId: tool.id,
        action,
        args: validatedArgs,
        perm,
        runContext,
        chatId: gatewayApprovalChatId(member, input.execution),
        argsSummary,
        ...(input.execution ? { execution: input.execution } : {}),
      });

      if (decision.kind === 'pending') {
        return gatewayFailure('approval_required', decision.message, {
          approval: {
            approvalId: decision.approvalId,
            message: decision.message,
            status: 'pending',
            authority: decision.authority,
            approverName: decision.approverName,
            scope: 'once',
            requestState: decision.requestState,
            nextAction: decision.nextAction,
            retry: decision.retry,
          },
        });
      }

      if (decision.kind === 'rejected') {
        return gatewayFailure('approval_rejected', decision.message, {
          approval: {
            approvalId: decision.approvalId,
            message: decision.message,
            status: 'rejected',
            authority: decision.authority,
            approverName: decision.approverName,
            scope: 'once',
            requestState: decision.requestState,
            nextAction: decision.nextAction,
            retry: decision.retry,
          },
        });
      }

      if (decision.kind === 'execution_failed') {
        return gatewayFailure('approval_execution_failed', decision.message, {
          approval: {
            approvalId: decision.approvalId,
            message: decision.message,
            status: 'failed',
            authority: decision.authority,
            approverName: decision.approverName,
            scope: 'once',
            requestState: decision.requestState,
            nextAction: decision.nextAction,
            retry: decision.retry,
          },
        });
      }

      if (decision.kind === 'misconfigured') {
        return gatewayFailure('approval_misconfigured', decision.message);
      }

      if (decision.kind === 'completed') {
        const replayed = validateToolResult(tool, decision.result);
        if (!replayed.ok) return gatewayFailure('tool_error', replayed.message);
        const provenanceFailure = await this.recordShopifyRun({
          toolId: String(tool.id),
          args: validatedArgs,
          companyId: member.companyId,
          userId: member.userId,
          channel: member.channel ?? 'desktop',
          ...(input.execution ? { execution: input.execution } : {}),
        });
        if (provenanceFailure) return gatewayFailure('tool_error', provenanceFailure);
        const protectedData = classifyShopifyProtectedResult({
          toolId: String(tool.id),
          args: validatedArgs,
          result: replayed.value,
        });
        return gatewaySuccess({
          toolId: tool.id,
          action,
          result: limitGatewayResult(member, replayed.value),
          ...(protectedData ? { protectedData } : {}),
          replayedApproval: {
            approvalId: decision.approvalId,
            status: 'completed',
          },
        });
      }

      executionGrant = decision.executionGrant;
    }

    const protectionFailure = await this.observeProtectedRun({
      toolId: String(tool.id),
      companyId: member.companyId,
      userId: member.userId,
      channel: member.channel ?? 'desktop',
      ...(input.execution ? { execution: input.execution } : {}),
    });
    if (protectionFailure) return gatewayFailure('tool_error', protectionFailure);

    const rateConsume = await this.consumeRateLimit({
      companyId: runContext.companyId,
      toolFamily: tool.family,
      action,
      args: validatedArgs,
    });
    if (rateConsume) {
      if (executionGrant) {
        const released = await this.releaseExecutionGrant(this.deps.approvalGate, executionGrant);
        if (!released) return approvalReleaseFailure(executionGrant.approvalId);
      }
      return rateConsume;
    }

    const initialProvenanceFailure = await this.recordShopifyRun({
      toolId: String(tool.id),
      args: validatedArgs,
      companyId: member.companyId,
      userId: member.userId,
      channel: member.channel ?? 'desktop',
      ...(input.execution ? { execution: input.execution } : {}),
    });
    if (initialProvenanceFailure) {
      if (executionGrant) {
        const finalized = await this.deps.approvalGate?.failExecution(executionGrant, {
          status: 'tool_error',
          message: initialProvenanceFailure,
        });
        if (!finalized) return approvalCheckpointFailure(executionGrant.approvalId);
      }
      return gatewayFailure('tool_error', initialProvenanceFailure);
    }

    const execCtx: ToolExecutionContext = {
      runContext,
      perm,
      correlationId: input.requestId ?? input.execution?.actionId ?? randomUUID(),
      logger: this.deps.logger.child({ toolId: tool.id }),
      clock: this.deps.clock,
      ...(executionGrant ? { approvalGrant: executionGrant } : {}),
    };

    try {
      const result = await tool.execute(validatedArgs, execCtx);
      if (!result.ok) {
        if (executionGrant) {
          const finalized = await this.deps.approvalGate?.failExecution(executionGrant, {
            status: 'tool_error',
            message: result.error.message,
          });
          if (!finalized) return approvalCheckpointFailure(executionGrant.approvalId);
        }
        // Same mapping as the two preflight sites and the runtime path: a tool
        // asking for a corrected argument must not reach the caller as a flat
        // tool failure. This is the path the cloud Pi container uses, so
        // flattening here is what made the agent report "access was denied".
        const status = result.error.payload.reason === 'bad_args' ? 'invalid_args' : 'tool_error';
        this.deps.logger.warn('gateway.tool.failed', {
          toolId: tool.id,
          action,
          status,
          reason: result.error.payload.reason,
          message: result.error.message,
        });
        return gatewayFailure(status, result.error.message);
      }

      const validatedResult = validateToolResult(tool, result.value);
      if (!validatedResult.ok) {
        if (executionGrant) {
          const finalized = await this.deps.approvalGate?.failExecution(executionGrant, {
            status: 'tool_error',
            message: validatedResult.message,
          });
          if (!finalized) return approvalCheckpointFailure(executionGrant.approvalId);
        }
        return gatewayFailure('tool_error', validatedResult.message);
      }

      if (executionGrant) {
        const finalized = await this.deps.approvalGate?.completeExecution(executionGrant, {
          status: 'success',
          result: validatedResult.value,
        });
        if (!finalized) return approvalCheckpointFailure(executionGrant.approvalId);
      }

      const provenanceFailure = await this.recordShopifyRun({
        toolId: String(tool.id),
        args: validatedArgs,
        companyId: member.companyId,
        userId: member.userId,
        channel: member.channel ?? 'desktop',
        ...(input.execution ? { execution: input.execution } : {}),
      });
      if (provenanceFailure) return gatewayFailure('tool_error', provenanceFailure);

      return gatewaySuccess({
        toolId: tool.id,
        action,
        result: limitGatewayResult(member, validatedResult.value),
        ...protectedResultField(tool.id, validatedArgs, validatedResult.value),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error('gateway.tool.threw', { toolId: tool.id, action, message });
      if (executionGrant) {
        const finalized = await this.deps.approvalGate?.failExecution(executionGrant, {
          status: 'tool_error',
          message,
        });
        if (!finalized) return approvalCheckpointFailure(executionGrant.approvalId);
      }
      return gatewayFailure('tool_error', message);
    }
  }

  /**
   * Revalidates a backend-hosted invocation without consuming a rate budget or
   * running tool code. Automation batches use this for an all-calls preflight
   * before the first approved mutation.
   */
  async preflightForRuntime(input: RuntimeToolExecutionInput): Promise<RuntimeToolPreflightOutcome> {
    const resolved = await this.resolveRuntimeInvocation(input);
    if (!resolved.ok) return resolved.outcome;

    const { tool, toolId, action, args } = resolved.value;
    let validation: Record<string, unknown> = { level: 'permission_only' };
    if (tool.preflight) {
      const checked = await tool.preflight(args, {
        runContext: input.runContext,
        perm: input.perm,
        correlationId: input.runContext.traceId
          ?? input.runContext.requestId
          ?? input.runContext.chatId
          ?? randomUUID(),
        logger: this.deps.logger.child({ toolId: tool.id, operation: 'runtime_preflight' }),
        clock: this.deps.clock,
      });
      if (!checked.ok) {
        const status = checked.error.payload.reason === 'bad_args' ? 'invalid_args' : 'tool_error';
        return runtimeFailure(toolId, status, checked.error.message, action);
      }
      validation = checked.value;
    }

    const ratePreflight = await this.preflightRateLimit({
      companyId: input.runContext.companyId,
      toolFamily: tool.family,
      action,
      args,
    });
    if (ratePreflight) return runtimeRateLimitFailure(toolId, ratePreflight, action);

    return { status: 'success', toolId, action, validation };
  }

  /**
   * Executes a request-scoped tool call for a backend-hosted channel. The
   * caller must supply the permission snapshot that the orchestration engine
   * just resolved; this method does not create an alternate identity or RBAC
   * decision path.
   */
  async executeForRuntime(input: RuntimeToolExecutionInput): Promise<RuntimeToolExecutionOutcome> {
    if (input.abortSignal?.aborted) {
      return runtimeFailure(
        input.toolId,
        'tool_error',
        'Tool execution was cancelled because the parent run ended.',
      );
    }
    const resolved = await this.resolveRuntimeInvocation(input);
    if (!resolved.ok) return resolved.outcome;
    const { toolId, tool, args: validatedArgs, action } = resolved.value;
    const { runContext, perm } = input;
    const execution = input.execution ?? runtimeExecutionContext(runContext);

    const ratePreflight = await this.preflightRateLimit({
      companyId: runContext.companyId,
      toolFamily: tool.family,
      action,
      args: validatedArgs,
    });
    if (ratePreflight) return runtimeRateLimitFailure(toolId, ratePreflight, action);

    let executionGrant: {
      approvalId: string;
      authority: 'connection_owner' | 'company_admin' | 'department_manager';
    } | undefined;
    if (input.approvalGate && input.chatId && isProtectedShopifyToolId(toolId)) {
      const requirement = await input.approvalGate.inspect({
        toolId: tool.id,
        action,
        args: validatedArgs,
        perm,
        runContext,
      });
      if (requirement.kind === 'required') {
        return runtimeFailure(
          toolId,
          'approval_misconfigured',
          'Protected Shopify reads cannot be stored in a durable approval request. Grant direct read access or deny this capability.',
          action,
        );
      }
      if (requirement.kind === 'misconfigured') {
        return runtimeFailure(toolId, 'approval_misconfigured', requirement.message, action);
      }
    } else if (input.approvalGate && input.chatId) {
      const decision = await input.approvalGate.check({
        toolId: tool.id,
        action,
        args: validatedArgs,
        perm,
        runContext,
        chatId: input.chatId,
        argsSummary: buildArgsSummary(tool.id, action, validatedArgs),
        ...(input.execution ? { execution: input.execution } : {}),
      });
      if (decision.kind === 'pending') {
        return runtimeFailure(toolId, 'approval_required', decision.message, action, decision.approvalId);
      }
      if (decision.kind === 'rejected') {
        return runtimeFailure(toolId, 'approval_rejected', decision.message, action, decision.approvalId);
      }
      if (decision.kind === 'execution_failed') {
        return runtimeFailure(
          toolId,
          'approval_execution_failed',
          decision.message,
          action,
          decision.approvalId,
        );
      }
      if (decision.kind === 'misconfigured') {
        return runtimeFailure(toolId, 'approval_misconfigured', decision.message, action);
      }
      if (decision.kind === 'completed') {
        const replayed = validateToolResult(tool, decision.result);
        if (!replayed.ok) return runtimeFailure(toolId, 'tool_error', replayed.message, action);
        const provenanceFailure = await this.recordShopifyRun({
          toolId,
          args: validatedArgs,
          companyId: String(runContext.companyId),
          userId: String(runContext.userId),
          channel: runContext.channel,
          ...(execution ? { execution } : {}),
        });
        if (provenanceFailure) return runtimeFailure(toolId, 'tool_error', provenanceFailure, action);
        const protectedData = classifyShopifyProtectedResult({
          toolId: String(tool.id),
          args: validatedArgs,
          result: replayed.value,
        });
        return {
          status: 'success',
          toolId,
          action,
          result: limitModelFacingResult(replayed.value),
          ...(protectedData ? { protectedData } : {}),
        };
      }
      executionGrant = decision.executionGrant;
    }

    const protectionFailure = await this.observeProtectedRun({
      toolId,
      companyId: String(runContext.companyId),
      userId: String(runContext.userId),
      channel: runContext.channel,
      ...(execution ? { execution } : {}),
    });
    if (protectionFailure) return runtimeFailure(toolId, 'tool_error', protectionFailure, action);

    const rateConsume = await this.consumeRateLimit({
      companyId: runContext.companyId,
      toolFamily: tool.family,
      action,
      args: validatedArgs,
    });
    if (rateConsume) {
      if (executionGrant) {
        const released = await this.releaseExecutionGrant(input.approvalGate, executionGrant);
        if (!released) {
          return runtimeFailure(
            toolId,
            'approval_misconfigured',
            approvalReleaseFailureMessage(executionGrant.approvalId),
            action,
            executionGrant.approvalId,
          );
        }
      }
      return runtimeRateLimitFailure(toolId, rateConsume, action);
    }

    const initialProvenanceFailure = await this.recordShopifyRun({
      toolId,
      args: validatedArgs,
      companyId: String(runContext.companyId),
      userId: String(runContext.userId),
      channel: runContext.channel,
      ...(execution ? { execution } : {}),
    });
    if (initialProvenanceFailure) {
      if (executionGrant) {
        const finalized = await input.approvalGate?.failExecution(executionGrant, {
          status: 'tool_error',
          message: initialProvenanceFailure,
        });
        if (!finalized) {
          return runtimeApprovalCheckpointFailure(toolId, action, executionGrant.approvalId);
        }
      }
      return runtimeFailure(toolId, 'tool_error', initialProvenanceFailure, action);
    }

    const context: ToolExecutionContext = {
      runContext,
      perm,
      // A tool ID is global and would make a per-run provider budget shared by
      // every conversation. Prefer the channel's durable run identity instead.
      correlationId: runContext.traceId ?? runContext.requestId ?? runContext.chatId ?? randomUUID(),
      logger: this.deps.logger.child({ toolId: tool.id, channel: runContext.channel }),
      clock: this.deps.clock,
      ...(executionGrant ? { approvalGrant: executionGrant } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    };

    try {
      if (input.abortSignal?.aborted) {
        if (executionGrant) {
          const released = await this.releaseExecutionGrant(input.approvalGate, executionGrant);
          if (!released) {
            return runtimeFailure(
              toolId,
              'approval_misconfigured',
              approvalReleaseFailureMessage(executionGrant.approvalId),
              action,
              executionGrant.approvalId,
            );
          }
        }
        return runtimeFailure(
          toolId,
          'tool_error',
          'Tool execution was cancelled because the parent run ended.',
          action,
        );
      }
      const result = await tool.execute(validatedArgs, context);
      if (!result.ok) {
        if (executionGrant) {
          const finalized = await input.approvalGate?.failExecution(executionGrant, {
            status: 'tool_error',
            message: result.error.message,
          });
          if (!finalized) {
            return runtimeApprovalCheckpointFailure(toolId, action, executionGrant.approvalId);
          }
        }
        // Preserve `bad_args` the way both preflight paths already do. Flattened
        // to `tool_error`, a tool saying "add accountId and retry" reads to the
        // model as the tool failing, and it reports the request as denied
        // instead of correcting the one argument it was asked to correct.
        const status = result.error.payload.reason === 'bad_args' ? 'invalid_args' : 'tool_error';
        // Nothing on this path was logged, so a run that ended with the model
        // telling a member "access was denied" left no record of which tool
        // refused or why. Args stay out: they carry member data.
        this.deps.logger.warn('gateway.tool.failed', {
          toolId,
          action,
          status,
          reason: result.error.payload.reason,
          message: result.error.message,
          correlationId: context.correlationId,
        });
        return runtimeFailure(toolId, status, result.error.message, action);
      }

      const validatedResult = validateToolResult(tool, result.value);
      if (!validatedResult.ok) {
        if (executionGrant) {
          const finalized = await input.approvalGate?.failExecution(executionGrant, {
            status: 'tool_error',
            message: validatedResult.message,
          });
          if (!finalized) {
            return runtimeApprovalCheckpointFailure(toolId, action, executionGrant.approvalId);
          }
        }
        return runtimeFailure(toolId, 'tool_error', validatedResult.message, action);
      }

      if (executionGrant) {
        const finalized = await input.approvalGate?.completeExecution(executionGrant, {
          status: 'success',
          result: validatedResult.value,
        });
        if (!finalized) {
          return runtimeApprovalCheckpointFailure(toolId, action, executionGrant.approvalId);
        }
      }
      this.deps.logger.info('gateway.tool.succeeded', {
        toolId,
        action,
        correlationId: context.correlationId,
      });
      const provenanceFailure = await this.recordShopifyRun({
        toolId,
        args: validatedArgs,
        companyId: String(runContext.companyId),
        userId: String(runContext.userId),
        channel: runContext.channel,
        ...(execution ? { execution } : {}),
      });
      if (provenanceFailure) return runtimeFailure(toolId, 'tool_error', provenanceFailure, action);
      const protectedData = classifyShopifyProtectedResult({
        toolId: String(tool.id),
        args: validatedArgs,
        result: validatedResult.value,
      });
      return {
        status: 'success',
        toolId,
        action,
        result: limitModelFacingResult(validatedResult.value),
        ...(protectedData ? { protectedData } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error('gateway.tool.threw', {
        toolId,
        action,
        message,
        correlationId: context.correlationId,
      });
      if (executionGrant) {
        const finalized = await input.approvalGate?.failExecution(executionGrant, {
          status: 'tool_error',
          message,
        });
        if (!finalized) {
          return runtimeApprovalCheckpointFailure(toolId, action, executionGrant.approvalId);
        }
      }
      return runtimeFailure(toolId, 'tool_error', message, action);
    }
  }

  private async resolveRuntimeInvocation(
    input: RuntimeToolExecutionInput,
  ): Promise<ResolveRuntimeToolInvocationResult> {
    const { toolId, args, perm } = input;
    if (toolId === 'runCommand') {
      return {
        ok: false,
        outcome: runtimeFailure(
          toolId,
          'permission_denied',
          'runCommand is not available through backend-hosted channels.',
        ),
      };
    }
    if (input.allowedToolIds && !input.allowedToolIds.has(toolId)) {
      return {
        ok: false,
        outcome: runtimeFailure(toolId, 'permission_denied', 'This tool is not available for the current member.'),
      };
    }

    const tool = this.deps.toolRegistry.byId(toolId as never);
    if (!tool) {
      return { ok: false, outcome: runtimeFailure(toolId, 'unknown_tool', `Unknown toolId "${toolId}"`) };
    }

    const connectionArgs = await this.resolveRuntimeConnectionArgs(input);
    if (!connectionArgs.ok) return connectionArgs.result;

    const parsed = tool.argsSchema.safeParse(connectionArgs.args);
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return {
        ok: false,
        outcome: runtimeFailure(toolId, 'invalid_args', `Invalid args for "${toolId}" — ${issues}`),
      };
    }

    const validatedArgs = parsed.data as Record<string, unknown>;
    const permissionCheck = tool.permissionCheck(validatedArgs, perm);
    if (!permissionCheck.ok) {
      return {
        ok: false,
        outcome: runtimeFailure(toolId, 'permission_denied', permissionCheck.error.message),
      };
    }
    const action = permissionCheck.value;
    if (input.expectedAction && action !== input.expectedAction) {
      return {
        ok: false,
        outcome: runtimeFailure(
          toolId,
          'invalid_args',
          `Tool action changed from "${input.expectedAction}" to "${action}" after approval.`,
          action,
        ),
      };
    }

    return {
      ok: true,
      value: { tool, toolId, action, args: validatedArgs },
    };
  }

  private async resolveRuntimeConnectionArgs(input: RuntimeToolExecutionInput): Promise<
    | { readonly ok: true; readonly args: Record<string, unknown> }
    | { readonly ok: false; readonly result: ResolveRuntimeToolInvocationResult }
  > {
    const provider = runtimeConnectionProvider(input.toolId);
    if (!provider) {
      return { ok: true, args: input.args };
    }
    if (typeof input.args.connectionId === 'string' && input.args.connectionId.length > 0) {
      return { ok: true, args: input.args };
    }
    if (!this.deps.connectionRegistry) {
      return {
        ok: false,
        result: {
          ok: false,
          outcome: runtimeFailure(
            input.toolId,
            'invalid_args',
            `No ${runtimeConnectionLabel(provider)} connectionId was provided and connected-account discovery is unavailable.`,
          ),
        },
      };
    }

    const connectionInput = {
      companyId: String(input.runContext.companyId),
      userId: String(input.runContext.userId),
    };
    const accessible = await listAccessibleConnectionsFor(
      this.deps.connectionRegistry,
      connectionInput,
      provider,
    );
    if (!accessible.ok) {
      return {
        ok: false,
        result: {
          ok: false,
          outcome: runtimeFailure(
            input.toolId,
            'tool_error',
            `Accessible ${runtimeConnectionLabel(provider)} accounts could not be loaded.`,
          ),
        },
      };
    }

    const selection = selectAccessibleConnection({
      connections: accessible.value,
      minimumAccess: 'read_only',
    });
    if (selection.status === 'unavailable') {
      return {
        ok: false,
        result: {
          ok: false,
          outcome: runtimeFailure(
            input.toolId,
            'invalid_args',
            `No accessible ${runtimeConnectionLabel(provider)} connection is available for this member.`,
          ),
        },
      };
    }
    if (selection.status === 'choose_connection') {
      return {
        ok: false,
        result: {
          ok: false,
          outcome: runtimeFailure(
            input.toolId,
            'invalid_args',
            `More than one ${runtimeConnectionLabel(provider)} connection is available. Retry with one exact connectionId: ${JSON.stringify(publicConnectionChoices(selection.connections))}`,
          ),
        },
      };
    }
    return {
      ok: true,
      args: { ...input.args, connectionId: selection.connection.connectionId },
    };
  }

  private async resolve(input: ToolExecutorInput): Promise<ResolveToolInvocationResult> {
    const { member, departmentId, toolId, args } = input;

    if (toolId === 'runCommand') {
      return { ok: false, response: gatewayFailure(
        'permission_denied',
        'runCommand is not available through the company gateway',
      ) };
    }

    const tool = this.deps.toolRegistry.byId(toolId as never);
    if (!tool) {
      return { ok: false, response: gatewayFailure('unknown_tool', `Unknown toolId "${toolId}"`) };
    }

    const argsParse = tool.argsSchema.safeParse(args);
    if (!argsParse.success) {
      const issues = argsParse.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      return { ok: false, response: gatewayFailure('invalid_args', `Invalid args for "${toolId}" — ${issues}`) };
    }

    const validatedArgs = argsParse.data;
    const effectiveDepartmentId = knowledgeScopedDepartmentId(
      toolId,
      validatedArgs,
      departmentId,
    );

    const basePermissionQuery = {
      companyId: asCompanyId(member.companyId),
      userId: asUserId(member.userId),
      companyRole: asCompanyRoleSlug(member.aiRole),
      channel: member.channel ?? 'desktop',
    } as const;

    const permResult = await this.deps.permissions.resolve({
      ...basePermissionQuery,
      ...(effectiveDepartmentId ? { departmentId: asDepartmentId(effectiveDepartmentId) } : {}),
    });

    if (!permResult.ok) {
      return { ok: false, response: gatewayFailure('permission_denied', permResult.error.message) };
    }

    const perm = permResult.value;

    const permCheck = tool.permissionCheck(validatedArgs, perm);
    if (!permCheck.ok) {
      return { ok: false, response: gatewayFailure('permission_denied', permCheck.error.message) };
    }

    const action = permCheck.value;

    const runContext = this.buildRunContext(
      member,
      effectiveDepartmentId,
      perm.department?.zohoReadScope,
      input.requestId ?? input.execution?.actionId,
      input.execution,
    );
    return {
      ok: true,
      value: {
        tool,
        toolId: tool.id,
        action,
        args: validatedArgs as Record<string, unknown>,
        perm,
        runContext,
        ...(effectiveDepartmentId ? { effectiveDepartmentId } : {}),
      },
    };
  }

  private buildRunContext(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    departmentZohoReadScope: string | undefined,
    requestId: string | undefined,
    execution: GatewayExecutionContext | undefined,
  ): RunContext {
    const larkDelivery = member.channel === 'lark' && execution
      ? larkDeliveryContextFromThreadId(execution.threadId)
      : undefined;
    return {
      companyId: asCompanyId(member.companyId),
      userId: asUserId(member.userId),
      companyRole: asCompanyRoleSlug(member.aiRole),
      ...(departmentId ? { departmentId: asDepartmentId(departmentId) } : {}),
      channel: member.channel ?? 'desktop',
      ...(member.email ? { requesterEmail: member.email } : {}),
      ...(member.larkOpenId ? { userExternalId: member.larkOpenId } : {}),
      ...(member.channel === 'lark' && member.larkTenantKey
        ? { tenantId: member.larkTenantKey }
        : {}),
      ...(departmentZohoReadScope ? { departmentZohoReadScope } : {}),
      requesterAiRole: member.aiRole,
      // Pi runs inside its container and calls back through here, so this is the
      // run context every tool actually sees — the one the scheduler builds never
      // reaches them. Without this, a scheduled run's delivery guards are inert
      // and the DM-only rule holds by prompt text alone.
      ...(member.authProvider === SCHEDULED_SESSION_AUTH_PROVIDER
        ? { deliveryMode: 'scheduled_runtime_delivery' as const }
        : {}),
      ...(requestId ? { traceId: requestId, requestId } : {}),
      // Read off the signed runtime lease, never off the request body, so a run
      // cannot reach somebody else's origin by naming their run ID.
      ...(member.runtimeRunId ? { runtimeRunId: member.runtimeRunId } : {}),
      ...(member.runtimeThreadId ? { runtimeThreadId: member.runtimeThreadId } : {}),
      chatId: member.runtimeChatId ?? larkDelivery?.chatId ?? execution?.threadId ?? `gateway:${member.sessionId}`,
      ...(larkDelivery?.replyToMessageId
        ? { replyToMessageId: larkDelivery.replyToMessageId }
        : {}),
      ...(larkDelivery?.replyInThread !== undefined
        ? { replyInThread: larkDelivery.replyInThread }
        : {}),
    };
  }

  private async preflightRateLimit(input: {
    readonly companyId: string;
    readonly toolFamily: string;
    readonly action: ToolActionGroup;
    readonly args: Record<string, unknown>;
  }): Promise<GatewayResponse | null> {
    if (!this.deps.connectionRateLimits) return null;
    if (isNativeSchemaDescribe(input.toolFamily, input.args)) return null;
    const connectionId = connectionIdFromArgs(input.args);
    const decision = await this.deps.connectionRateLimits.preflight({
      companyId: input.companyId,
      ...(connectionId ? { connectionId } : {}),
      action: input.action,
    });
    return rateLimitFailure(decision);
  }

  private async consumeRateLimit(input: {
    readonly companyId: string;
    readonly toolFamily: string;
    readonly action: ToolActionGroup;
    readonly args: Record<string, unknown>;
  }): Promise<GatewayResponse | null> {
    if (!this.deps.connectionRateLimits) return null;
    if (isNativeSchemaDescribe(input.toolFamily, input.args)) return null;
    const connectionId = connectionIdFromArgs(input.args);
    const decision = await this.deps.connectionRateLimits.consume({
      companyId: input.companyId,
      ...(connectionId ? { connectionId } : {}),
      action: input.action,
    });
    return rateLimitFailure(decision);
  }

  private async releaseExecutionGrant(
    approvalGate: ApprovalGateService | undefined,
    grant: {
      readonly approvalId: string;
      readonly authority: 'connection_owner' | 'company_admin' | 'department_manager';
    },
  ): Promise<boolean> {
    if (!approvalGate) return false;
    return approvalGate.releaseExecution(grant);
  }

  private async observeProtectedRun(input: {
    readonly toolId: string;
    readonly companyId: string;
    readonly userId: string;
    readonly channel: string;
    readonly execution?: GatewayExecutionContext;
  }): Promise<string | null> {
    if (!isProtectedShopifyToolId(input.toolId)) return null;
    if (!this.deps.protectedDataRuns || !input.execution) {
      return 'Protected Shopify data is unavailable because durable run protection could not be established.';
    }
    try {
      await this.deps.protectedDataRuns.observe({
        companyId: input.companyId,
        userId: input.userId,
        channel: input.channel,
        runId: input.execution.runId,
        threadId: input.execution.threadId,
      });
      return null;
    } catch (error) {
      this.deps.logger.error('gateway.protected_run.observe_failed', {
        companyId: input.companyId,
        userId: input.userId,
        runId: input.execution.runId,
        toolId: input.toolId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'Protected Shopify data is unavailable because durable run protection could not be established.';
    }
  }

  private async recordShopifyRun(input: {
    readonly toolId: string;
    readonly args: Record<string, unknown>;
    readonly companyId: string;
    readonly userId: string;
    readonly channel: string;
    readonly execution?: GatewayExecutionContext;
  }): Promise<string | null> {
    if (!isShopifyToolId(input.toolId)) return null;
    const connectionId = input.args['connectionId'];
    if (
      !this.deps.shopifyDataRuns
      || !input.execution
      || typeof connectionId !== 'string'
      || !connectionId
    ) {
      return 'Shopify data is unavailable because durable shop provenance could not be established.';
    }
    try {
      await this.deps.shopifyDataRuns.record({
        companyId: input.companyId,
        userId: input.userId,
        channel: input.channel,
        runId: input.execution.runId,
        threadId: input.execution.threadId,
        connectionId,
        toolId: input.toolId,
      });
      return null;
    } catch (error) {
      this.deps.logger.error('gateway.shopify_run.record_failed', {
        companyId: input.companyId,
        userId: input.userId,
        runId: input.execution.runId,
        toolId: input.toolId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'Shopify data is unavailable because durable shop provenance could not be established.';
    }
  }
}

function runtimeExecutionContext(runContext: RunContext): GatewayExecutionContext | undefined {
  if (!runContext.traceId || !runContext.chatId) return undefined;
  return {
    version: 1,
    runId: runContext.traceId,
    threadId: runContext.chatId,
    actionId: runContext.requestId ?? runContext.traceId,
  };
}

function protectedResultField(
  toolId: string,
  args: Record<string, unknown>,
  result: unknown,
): { readonly protectedData?: ShopifyProtectedResult } {
  const protectedData = classifyShopifyProtectedResult({ toolId, args, result });
  return protectedData ? { protectedData } : {};
}

type RuntimeConnectionProvider = Extract<ConnectionProvider, 'zoho' | 'lark' | 'shopify'>;

const LARK_USER_CONNECTION_TOOL_IDS = new Set([
  'larkTask',
  'larkMessaging',
  'larkCalendar',
  'larkMeeting',
  'larkDoc',
  'larkBase',
]);

function runtimeConnectionProvider(toolId: string): RuntimeConnectionProvider | undefined {
  if (toolId === 'zohoCrm' || toolId === 'zohoBooks') return 'zoho';
  if (LARK_USER_CONNECTION_TOOL_IDS.has(toolId)) return 'lark';
  if (toolId === 'shopifyAnalytics' || toolId === 'shopifyOrders' || toolId === 'shopifyCustomers') return 'shopify';
  return undefined;
}

function runtimeConnectionLabel(provider: RuntimeConnectionProvider): string {
  return CONNECTION_PROVIDER_LABELS[provider];
}

function validateToolResult(
  tool: Tool<unknown, unknown>,
  value: unknown,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string } {
  const parsed = tool.resultSchema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.errors
    .slice(0, 5)
    .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return {
    ok: false,
    message: `Tool "${tool.id}" returned an invalid result${issues ? ` — ${issues}` : ''}.`,
  };
}

function runtimeFailure(
  toolId: string,
  status: Exclude<RuntimeToolExecutionOutcome['status'], 'success'>,
  message: string,
  action?: ToolActionGroup,
  approvalId?: string,
): RuntimeToolExecutionOutcome {
  return {
    status,
    toolId,
    ...(action ? { action } : {}),
    message,
    ...(approvalId ? { approvalId } : {}),
  };
}

function approvalReleaseFailure(approvalId: string): GatewayResponse {
  return gatewayFailure('approval_misconfigured', approvalReleaseFailureMessage(approvalId));
}

function approvalCheckpointFailure(approvalId: string): GatewayResponse {
  return gatewayFailure('approval_execution_failed', approvalCheckpointFailureMessage(approvalId));
}

function runtimeApprovalCheckpointFailure(
  toolId: string,
  action: ToolActionGroup,
  approvalId: string,
): RuntimeToolExecutionOutcome {
  return runtimeFailure(
    toolId,
    'approval_execution_failed',
    approvalCheckpointFailureMessage(approvalId),
    action,
    approvalId,
  );
}

function approvalCheckpointFailureMessage(approvalId: string): string {
  return `The provider action may have completed, but Divo could not durably store its final state for approval ${approvalId}. Do not retry the exact action. Inspect the destination, then contact your administrator.`;
}

function approvalReleaseFailureMessage(approvalId: string): string {
  return `The action did not run because its final rate-budget check failed, but Divo could not release approval ${approvalId}. Nothing was executed. Contact your administrator before retrying this exact action.`;
}

function connectionIdFromArgs(args: Record<string, unknown>): string | undefined {
  const candidate = args['connectionId'];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

/** Native schema metadata is process-cached contract data, not a SaaS data operation. */
function isNativeSchemaDescribe(toolFamily: string, args: Record<string, unknown>): boolean {
  return (toolFamily === 'google' || toolFamily === 'airtable') && args['op'] === 'describe';
}

function rateLimitFailure(
  decision: Awaited<ReturnType<ConnectionRateLimitService['preflight']>>,
): GatewayResponse | null {
  if (decision.kind === 'limited') return gatewayFailure('rate_limited', decision.message);
  if (decision.kind === 'unavailable') return gatewayFailure('rate_limit_unavailable', decision.message);
  return null;
}

function runtimeRateLimitFailure(
  toolId: string,
  response: GatewayResponse,
  action: ToolActionGroup,
): RuntimeToolExecutionOutcome {
  const status = response.status === 'rate_limited' || response.status === 'rate_limit_unavailable'
    ? response.status
    : 'rate_limit_unavailable';
  return runtimeFailure(toolId, status, response.error?.message ?? 'Connection rate limit check failed.', action);
}

/**
 * A manager approval may be retried within one run, but must never be shared
 * by two independent desktop chats or two separate user turns. The execution
 * context is not trusted for authorization; it only partitions an already
 * authenticated requester's approval/idempotency namespace. Session IDs are
 * deliberately excluded so re-authentication cannot manufacture a second
 * approval for the same requester/thread/run/action.
 */
function gatewayApprovalChatId(
  member: GatewayMemberContext,
  execution: GatewayExecutionContext | undefined,
): string {
  if (!execution) return `gateway:${member.sessionId}`;
  return [
    'gateway',
    'company',
    member.companyId,
    'requester',
    member.userId,
    'thread',
    execution.threadId,
    'run',
    execution.runId,
  ].join(':');
}

function larkDeliveryContextFromThreadId(threadId: string): {
  chatId: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
} {
  const threadMarker = ':thread:';
  const threadIndex = threadId.indexOf(threadMarker);
  if (threadIndex > 0) {
    const chatId = threadId.slice(0, threadIndex);
    const rootMessageId = threadId.slice(threadIndex + threadMarker.length);
    if (rootMessageId) {
      return {
        chatId,
        replyToMessageId: rootMessageId,
        replyInThread: true,
      };
    }
  }

  const inlineMarker = ':user:';
  const inlineIndex = threadId.indexOf(inlineMarker);
  if (inlineIndex > 0) {
    return {
      chatId: threadId.slice(0, inlineIndex),
      replyInThread: false,
    };
  }

  return { chatId: threadId };
}

function knowledgeScopedDepartmentId(
  toolId: string,
  args: unknown,
  gatewayDepartmentId: string | undefined,
): string | undefined {
  if (toolId !== 'knowledge' || typeof args !== 'object' || args === null) {
    return gatewayDepartmentId;
  }
  const operation = (args as { operation?: unknown }).operation;
  if (operation === 'recall') return undefined;
  if (operation !== 'propose' && operation !== 'apply') return gatewayDepartmentId;
  if ((args as { scope?: unknown }).scope !== 'department') return undefined;
  const requested = (args as { departmentId?: unknown }).departmentId;
  return typeof requested === 'string' ? requested : gatewayDepartmentId;
}
