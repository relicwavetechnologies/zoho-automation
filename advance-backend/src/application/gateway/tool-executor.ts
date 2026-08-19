import type { ToolRegistry } from '../tools/tool-registry';
import type { PermissionService } from '../permissions/permission.service';
import type { PermissionResult } from '../permissions/permission.types';
import type { ApprovalGateService } from '../approval/approval-gate.service';
import type {
  ApprovalDecision,
  ApprovalExecutionGrant,
} from '../approval/approval.types';
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
import {
  GOOGLE_WORKSPACE_PRODUCTS,
  googleWorkspaceActionFor,
  prefersCompanyGoogleArtifactAccount,
  googleWorkspaceScopeGroupsFor,
  type GoogleWorkspaceProductDefinition,
} from '../google/google-workspace-mcp-manifest';
import {
  AIRTABLE_PRODUCTS,
  airtableOperationFor,
  airtableScopeGroupsFor,
  hasAirtableScopeGroups,
  type AirtableProductDefinition,
} from '../airtable/airtable-mcp-manifest';
import { hasGoogleScopeGroups } from '../../domain/google/google-workspace-scope';
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
import { zohoCrmActionFor } from '../tools/families/zoho-crm.tool';
import { zohoBooksActionFor, zohoBooksScopeModuleFor } from '../tools/families/zoho-books.tool';
import { hasZohoScope } from '../../domain/zoho/zoho-scope';
import {
  measureRunLatency,
  type RunLatencyTrace,
} from '../observability/run-latency-recorder';

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
  /** A human decision should finish this exact stored action without an agent retry. */
  readonly resumeOnApproval?: boolean;
  /** Requester-confirmed business action that owns any subsequent governance decision. */
  readonly parentBusinessActionId?: string;
  /** Request-local timing only; it carries no identity or policy authority. */
  readonly latencyTrace?: RunLatencyTrace;
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
  readonly latencyTrace?: RunLatencyTrace;
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

type GovernedInvocationFailureStatus = Extract<RuntimeToolExecutionOutcome['status'],
  'invalid_args' | 'approval_required' | 'approval_rejected'
  | 'approval_execution_failed' | 'approval_misconfigured'
  | 'rate_limited' | 'rate_limit_unavailable' | 'tool_error'>;

type GovernedApprovalDecision = Extract<ApprovalDecision,
  { readonly kind: 'pending' | 'rejected' | 'execution_failed' }>;

type GovernedInvocationOutcome =
  | {
      readonly ok: true;
      readonly result: unknown;
      readonly protectedData?: ShopifyProtectedResult;
      readonly replayedApprovalId?: string;
    }
  | {
      readonly ok: false;
      readonly status: GovernedInvocationFailureStatus;
      readonly message: string;
      readonly approval?: GovernedApprovalDecision;
      readonly approvalId?: string;
      readonly retryAfterSeconds?: number;
    };

interface GovernedInvocationInput {
  readonly tool: Tool<unknown, unknown>;
  readonly action: ToolActionGroup;
  readonly args: Record<string, unknown>;
  readonly runContext: RunContext;
  readonly perm: PermissionResult;
  /** Durable provider/protected-data provenance for this exact runtime action. */
  readonly execution?: GatewayExecutionContext;
  /** Present only when this caller has a durable approval scope. */
  readonly approval?: {
    readonly gate: ApprovalGateService;
    readonly chatId: string;
    /** Explicit approval provenance; derived provider provenance is not authoritative here. */
    readonly execution?: GatewayExecutionContext;
    readonly resumeOnApproval?: boolean;
    readonly parentBusinessActionId?: string;
  };
  readonly correlationId: string;
  readonly resultAudience?: ToolExecutionContext['resultAudience'];
  readonly abortSignal?: AbortSignal;
  readonly onProgress?: (message: string) => void;
  readonly latencyTrace?: RunLatencyTrace;
}

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
    const { tool, action, args, perm, runContext } = resolved.value;
    const outcome = await this.executeGoverned({
      tool,
      action,
      args,
      perm,
      runContext,
      ...(input.execution ? { execution: input.execution } : {}),
      ...(this.deps.approvalGate ? {
        approval: {
          gate: this.deps.approvalGate,
          chatId: gatewayApprovalChatId(member, input.execution),
          ...(input.execution ? { execution: input.execution } : {}),
          ...(input.resumeOnApproval ? { resumeOnApproval: true } : {}),
          ...(input.parentBusinessActionId
            ? { parentBusinessActionId: input.parentBusinessActionId }
            : {}),
        },
      } : {}),
      correlationId: input.requestId ?? input.execution?.actionId ?? randomUUID(),
      ...(member.resultAudience ? { resultAudience: member.resultAudience } : {}),
      ...(input.latencyTrace ? { latencyTrace: input.latencyTrace } : {}),
    });
    return gatewayOutcome(tool, action, member, outcome);
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
    const { toolId, tool, args, action } = resolved.value;
    const { runContext, perm } = input;
    const execution = input.execution ?? runtimeExecutionContext(runContext);
    const outcome = await this.executeGoverned({
      tool,
      action,
      args,
      runContext,
      perm,
      ...(execution ? { execution } : {}),
      ...(input.approvalGate && input.chatId ? {
        approval: {
          gate: input.approvalGate,
          chatId: input.chatId,
          ...(input.execution ? { execution: input.execution } : {}),
        },
      } : {}),
      // A tool ID is global and would make a per-run provider budget shared by
      // every conversation. Prefer the channel's durable run identity instead.
      correlationId: runContext.traceId ?? runContext.requestId ?? runContext.chatId ?? randomUUID(),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.latencyTrace ? { latencyTrace: input.latencyTrace } : {}),
    });
    return runtimeOutcome(toolId, action, outcome);
  }

  /**
   * One governed invocation lifecycle for every caller.
   *
   * Gateway and backend-runtime entry points differ only in how identity is
   * resolved and how this neutral outcome is presented. Rate limits, approval,
   * protected-data marking, provider execution, result validation, durable
   * approval checkpoints, and provenance must remain in this one path.
   */
  private async executeGoverned(input: GovernedInvocationInput): Promise<GovernedInvocationOutcome> {
    const { tool, action, args, runContext, perm } = input;
    const toolId = String(tool.id);
    const ratePreflight = await this.preflightRateLimit({
      companyId: runContext.companyId,
      toolFamily: tool.family,
      action,
      args,
    });
    if (ratePreflight) return governedRateLimitFailure(ratePreflight);

    let executionGrant: ApprovalExecutionGrant | undefined;
    if (input.approval && isProtectedShopifyToolId(toolId)) {
      const requirement = await input.approval.gate.inspect({
        toolId: tool.id,
        action,
        args,
        perm,
        runContext,
      });
      if (requirement.kind === 'required') {
        return governedFailure(
          'approval_misconfigured',
          'Protected Shopify reads cannot be stored in a durable approval request. Grant direct read access or deny this capability.',
        );
      }
      if (requirement.kind === 'misconfigured') {
        return governedFailure('approval_misconfigured', requirement.message);
      }
    } else if (input.approval) {
      const decision = await input.approval.gate.check({
        toolId: tool.id,
        action,
        args,
        perm,
        runContext,
        chatId: input.approval.chatId,
        argsSummary: buildArgsSummary(tool.id, action, args),
        ...(input.approval.resumeOnApproval ? { resumeOnApproval: true } : {}),
        ...(input.approval.parentBusinessActionId
          ? { parentBusinessActionId: input.approval.parentBusinessActionId }
          : {}),
        ...(input.approval.execution ? { execution: input.approval.execution } : {}),
      });
      if (
        decision.kind === 'pending'
        || decision.kind === 'rejected'
        || decision.kind === 'execution_failed'
      ) {
        return governedApprovalFailure(decision);
      }
      if (decision.kind === 'misconfigured') {
        return governedFailure('approval_misconfigured', decision.message);
      }
      if (decision.kind === 'completed') {
        const replayed = validateToolResult(tool, decision.result);
        if (!replayed.ok) return governedFailure('tool_error', replayed.message);
        const provenanceFailure = await this.recordShopifyRun({
          toolId,
          args,
          companyId: String(runContext.companyId),
          userId: String(runContext.userId),
          channel: runContext.channel,
          ...(input.execution ? { execution: input.execution } : {}),
        });
        if (provenanceFailure) return governedFailure('tool_error', provenanceFailure);
        const protectedData = classifyShopifyProtectedResult({ toolId, args, result: replayed.value });
        return {
          ok: true,
          result: replayed.value,
          ...(protectedData ? { protectedData } : {}),
          replayedApprovalId: decision.approvalId,
        };
      }
      executionGrant = decision.executionGrant;
    }

    const protectionFailure = await this.observeProtectedRun({
      toolId,
      companyId: String(runContext.companyId),
      userId: String(runContext.userId),
      channel: runContext.channel,
      ...(input.execution ? { execution: input.execution } : {}),
    });
    if (protectionFailure) return governedFailure('tool_error', protectionFailure);

    const rateConsume = await this.consumeRateLimit({
      companyId: runContext.companyId,
      toolFamily: tool.family,
      action,
      args,
    });
    if (rateConsume) {
      if (executionGrant) {
        const released = await this.releaseExecutionGrant(input.approval?.gate, executionGrant);
        if (!released) return governedApprovalReleaseFailure(executionGrant.approvalId);
      }
      return governedRateLimitFailure(rateConsume);
    }

    const initialProvenanceFailure = await this.recordShopifyRun({
      toolId,
      args,
      companyId: String(runContext.companyId),
      userId: String(runContext.userId),
      channel: runContext.channel,
      ...(input.execution ? { execution: input.execution } : {}),
    });
    if (initialProvenanceFailure) {
      const checkpointFailure = await this.failExecutionGrant(
        input.approval?.gate,
        executionGrant,
        initialProvenanceFailure,
      );
      return checkpointFailure ?? governedFailure('tool_error', initialProvenanceFailure);
    }

    const context: ToolExecutionContext = {
      runContext,
      perm,
      ...(input.resultAudience ? { resultAudience: input.resultAudience } : {}),
      correlationId: input.correlationId,
      logger: this.deps.logger.child({ toolId: tool.id, channel: runContext.channel }),
      clock: this.deps.clock,
      ...(executionGrant ? { approvalGrant: executionGrant } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    };

    try {
      if (input.abortSignal?.aborted) {
        if (executionGrant) {
          const released = await this.releaseExecutionGrant(input.approval?.gate, executionGrant);
          if (!released) return governedApprovalReleaseFailure(executionGrant.approvalId);
        }
        return governedFailure(
          'tool_error',
          'Tool execution was cancelled because the parent run ended.',
        );
      }

      const result = await measureRunLatency(
        input.latencyTrace,
        {
          name: 'gateway.tool.execute',
          category: 'tool',
          attributes: { toolId, action },
        },
        () => tool.execute(args, context),
      );
      if (!result.ok) {
        const checkpointFailure = await this.failExecutionGrant(
          input.approval?.gate,
          executionGrant,
          result.error.message,
        );
        if (checkpointFailure) return checkpointFailure;
        const status = result.error.payload.reason === 'bad_args' ? 'invalid_args' : 'tool_error';
        this.deps.logger.warn('gateway.tool.failed', {
          toolId,
          action,
          status,
          reason: result.error.payload.reason,
          message: result.error.message,
          correlationId: context.correlationId,
        });
        return governedFailure(status, result.error.message);
      }

      const validatedResult = validateToolResult(tool, result.value);
      if (!validatedResult.ok) {
        const checkpointFailure = await this.failExecutionGrant(
          input.approval?.gate,
          executionGrant,
          validatedResult.message,
        );
        return checkpointFailure ?? governedFailure('tool_error', validatedResult.message);
      }

      if (executionGrant) {
        const finalized = await input.approval?.gate.completeExecution(executionGrant, {
          status: 'success',
          result: validatedResult.value,
        });
        if (!finalized) return governedApprovalCheckpointFailure(executionGrant.approvalId);
      }

      this.deps.logger.info('gateway.tool.succeeded', {
        toolId,
        action,
        correlationId: context.correlationId,
      });
      const provenanceFailure = await this.recordShopifyRun({
        toolId,
        args,
        companyId: String(runContext.companyId),
        userId: String(runContext.userId),
        channel: runContext.channel,
        ...(input.execution ? { execution: input.execution } : {}),
      });
      if (provenanceFailure) return governedFailure('tool_error', provenanceFailure);
      const protectedData = classifyShopifyProtectedResult({
        toolId,
        args,
        result: validatedResult.value,
      });
      return {
        ok: true,
        result: validatedResult.value,
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
      const checkpointFailure = await this.failExecutionGrant(
        input.approval?.gate,
        executionGrant,
        message,
      );
      return checkpointFailure ?? governedFailure('tool_error', message);
    }
  }

  private async failExecutionGrant(
    approvalGate: ApprovalGateService | undefined,
    executionGrant: ApprovalExecutionGrant | undefined,
    message: string,
  ): Promise<GovernedInvocationOutcome | null> {
    if (!executionGrant) return null;
    const finalized = await approvalGate?.failExecution(executionGrant, {
      status: 'tool_error',
      message,
    });
    return finalized ? null : governedApprovalCheckpointFailure(executionGrant.approvalId);
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
    const resolved = await this.resolveConnectionArgs({
      companyId: String(input.runContext.companyId),
      userId: String(input.runContext.userId),
      toolId: input.toolId,
      args: input.args,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        result: {
          ok: false,
          outcome: runtimeFailure(
            input.toolId,
            resolved.status,
            resolved.message,
          ),
        },
      };
    }
    return resolved;
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

    const connectionArgs = await measureRunLatency(
      input.latencyTrace,
      {
        name: 'gateway.connection.resolve',
        category: 'persistence',
        attributes: { toolId },
      },
      () => this.resolveConnectionArgs({
        companyId: member.companyId,
        userId: member.userId,
        toolId,
        args,
      }),
    );
    if (!connectionArgs.ok) {
      return { ok: false, response: gatewayFailure(connectionArgs.status, connectionArgs.message) };
    }

    const argsParse = tool.argsSchema.safeParse(connectionArgs.args);
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

    const permResult = await measureRunLatency(
      input.latencyTrace,
      {
        name: 'gateway.permission.revalidate',
        category: 'authorization',
        attributes: { toolId },
      },
      () => this.deps.permissions.resolve({
        ...basePermissionQuery,
        ...(effectiveDepartmentId ? { departmentId: asDepartmentId(effectiveDepartmentId) } : {}),
      }),
    );

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

  private async resolveConnectionArgs(input: {
    readonly companyId: string;
    readonly userId: string;
    readonly toolId: string;
    readonly args: Record<string, unknown>;
  }): Promise<
    | { readonly ok: true; readonly args: Record<string, unknown> }
    | { readonly ok: false; readonly status: 'invalid_args' | 'tool_error'; readonly message: string }
  > {
    const requirement = runtimeConnectionRequirement(input.toolId, input.args);
    if (!requirement) {
      return { ok: true, args: input.args };
    }
    if (!this.deps.connectionRegistry) {
      return {
        ok: false,
        status: 'invalid_args',
        message: `No ${runtimeConnectionLabel(requirement.provider)} connectionId was provided and connected-account discovery is unavailable.`,
      };
    }

    const accessible = await listAccessibleConnectionsFor(this.deps.connectionRegistry, {
      companyId: input.companyId,
      userId: input.userId,
    }, requirement.provider);
    if (!accessible.ok) {
      return {
        ok: false,
        status: 'tool_error',
        message: `Accessible ${runtimeConnectionLabel(requirement.provider)} accounts could not be loaded.`,
      };
    }
    const scopeEligible = accessible.value.filter(connection => requirement.scopeEligible(connection.scopes));
    const selection = selectAccessibleConnection({
      connections: scopeEligible,
      filteredOut: accessible.value.filter(connection => !scopeEligible.includes(connection)),
      minimumAccess: requirement.minimumAccess,
      ...(typeof input.args.connectionId === 'string' && input.args.connectionId.length > 0
        ? { connectionId: input.args.connectionId }
        : {}),
      ...(requirement.preferredOwnerType
        ? { preferredOwnerType: requirement.preferredOwnerType }
        : {}),
    });
    if (selection.status === 'unavailable') {
      return {
        ok: false,
        status: 'invalid_args',
        message: selection.reason === 'requested_not_accessible'
          ? `The selected ${runtimeConnectionLabel(requirement.provider)} account is not accessible to this member.`
          : selection.reason === 'insufficient_access'
            ? `The selected ${runtimeConnectionLabel(requirement.provider)} account is not eligible for this action and its required scopes.`
            : `No ${runtimeConnectionLabel(requirement.provider)} account is eligible for this action and its required scopes.`,
      };
    }
    if (selection.status === 'choose_connection') {
      return {
        ok: false,
        status: 'invalid_args',
        message: `More than one ${runtimeConnectionLabel(requirement.provider)} account is eligible. Retry with one exact connectionId: ${JSON.stringify(publicConnectionChoices(selection.connections))}`,
      };
    }
    return { ok: true, args: { ...input.args, connectionId: selection.connection.connectionId } };
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

type RuntimeConnectionProvider = Extract<
  ConnectionProvider,
  'google_workspace' | 'zoho' | 'airtable' | 'lark' | 'shopify'
>;

const GOOGLE_PRODUCT_BY_TOOL_ID = new Map<string, GoogleWorkspaceProductDefinition>(
  GOOGLE_WORKSPACE_PRODUCTS.map(product => [product.toolId, product]),
);
const AIRTABLE_PRODUCT_BY_TOOL_ID = new Map<string, AirtableProductDefinition>(
  AIRTABLE_PRODUCTS.map(product => [product.toolId, product]),
);

interface RuntimeConnectionRequirement {
  readonly provider: RuntimeConnectionProvider;
  readonly minimumAccess: 'read_only' | 'read_write';
  readonly scopeEligible: (scopes: readonly string[]) => boolean;
  readonly preferredOwnerType?: 'company' | 'user';
}

const LARK_USER_CONNECTION_TOOL_IDS = new Set([
  'larkTask',
  'larkMessaging',
  'larkCalendar',
  'larkMeeting',
  'larkDoc',
  'larkBase',
]);

function runtimeConnectionRequirement(
  toolId: string,
  args: Readonly<Record<string, unknown>>,
): RuntimeConnectionRequirement | undefined {
  const googleProduct = GOOGLE_PRODUCT_BY_TOOL_ID.get(toolId);
  if (googleProduct) {
    if (args.op === 'describe') return undefined;
    if (args.op !== 'call') return undefined;
    const action = googleWorkspaceActionFor(
      typeof args.nativeTool === 'string' ? args.nativeTool : '',
      isPlainRecord(args.input) ? args.input : {},
    );
    const requiredScopes = googleWorkspaceScopeGroupsFor(
      googleProduct,
      typeof args.nativeTool === 'string' ? args.nativeTool : '',
      action,
    );
    return {
      provider: 'google_workspace',
      minimumAccess: action === 'read' ? 'read_only' : 'read_write',
      scopeEligible: scopes => hasGoogleScopeGroups(scopes, requiredScopes),
      ...(typeof args.nativeTool === 'string'
        && prefersCompanyGoogleArtifactAccount(args.nativeTool)
        ? { preferredOwnerType: 'company' as const }
        : {}),
    };
  }

  const airtableProduct = AIRTABLE_PRODUCT_BY_TOOL_ID.get(toolId);
  if (airtableProduct) {
    if (args.op === 'describe') return undefined;
    if (args.op !== 'call') return undefined;
    const operation = typeof args.nativeTool === 'string'
      ? airtableOperationFor(toolId, args.nativeTool)
      : undefined;
    const action = operation?.action ?? 'read';
    const requiredScopes = airtableScopeGroupsFor(airtableProduct, action);
    return {
      provider: 'airtable',
      minimumAccess: action === 'read' ? 'read_only' : 'read_write',
      scopeEligible: scopes => hasAirtableScopeGroups(scopes, requiredScopes),
    };
  }

  if (toolId === 'zohoCrm' || toolId === 'zohoBooks') {
    const operation = typeof args.op === 'string' ? args.op : '';
    const action = toolId === 'zohoCrm'
      ? zohoCrmActionFor(operation)
      : zohoBooksActionFor(operation);
    return {
      provider: 'zoho',
      minimumAccess: action === 'read' ? 'read_only' : 'read_write',
      scopeEligible: scopes => hasZohoScope(
        scopes,
        toolId === 'zohoCrm' ? 'crm' : 'books',
        action,
        toolId === 'zohoBooks' ? zohoBooksScopeModuleFor(operation) : undefined,
      ),
    };
  }

  const provider = LARK_USER_CONNECTION_TOOL_IDS.has(toolId)
    ? 'lark'
    : toolId === 'shopifyAnalytics' || toolId === 'shopifyOrders' || toolId === 'shopifyCustomers'
      ? 'shopify'
      : undefined;
  return provider
    ? { provider, minimumAccess: 'read_only', scopeEligible: () => true }
    : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function gatewayOutcome(
  tool: Tool<unknown, unknown>,
  action: ToolActionGroup,
  member: GatewayMemberContext,
  outcome: GovernedInvocationOutcome,
): GatewayResponse {
  if (outcome.ok) {
    return gatewaySuccess({
      toolId: tool.id,
      action,
      result: limitGatewayResult(member, outcome.result),
      ...(outcome.protectedData ? { protectedData: outcome.protectedData } : {}),
      ...(outcome.replayedApprovalId ? {
        replayedApproval: {
          approvalId: outcome.replayedApprovalId,
          status: 'completed' as const,
        },
      } : {}),
    });
  }
  if (outcome.approval) {
    return gatewayFailure(outcome.status, outcome.message, {
      approval: gatewayApprovalPresentation(outcome.approval),
    });
  }
  if (outcome.retryAfterSeconds !== undefined) {
    return gatewayFailure(outcome.status, outcome.message, {
      retryAfterSeconds: outcome.retryAfterSeconds,
    });
  }
  return gatewayFailure(outcome.status, outcome.message);
}

function runtimeOutcome(
  toolId: string,
  action: ToolActionGroup,
  outcome: GovernedInvocationOutcome,
): RuntimeToolExecutionOutcome {
  if (outcome.ok) {
    return {
      status: 'success',
      toolId,
      action,
      result: limitModelFacingResult(outcome.result),
      ...(outcome.protectedData ? { protectedData: outcome.protectedData } : {}),
    };
  }
  return runtimeFailure(
    toolId,
    outcome.status,
    outcome.message,
    action,
    outcome.approval?.approvalId ?? outcome.approvalId,
  );
}

function governedFailure(
  status: GovernedInvocationFailureStatus,
  message: string,
): GovernedInvocationOutcome {
  return { ok: false, status, message };
}

function governedApprovalFailure(
  decision: GovernedApprovalDecision,
): GovernedInvocationOutcome {
  const status = decision.kind === 'pending'
    ? 'approval_required'
    : decision.kind === 'rejected'
      ? 'approval_rejected'
      : 'approval_execution_failed';
  return {
    ok: false,
    status,
    message: decision.message,
    approval: decision,
    approvalId: decision.approvalId,
  };
}

function governedApprovalCheckpointFailure(
  approvalId: string,
): GovernedInvocationOutcome {
  return {
    ok: false,
    status: 'approval_execution_failed',
    message: approvalCheckpointFailureMessage(approvalId),
    approvalId,
  };
}

function governedApprovalReleaseFailure(approvalId: string): GovernedInvocationOutcome {
  return {
    ok: false,
    status: 'approval_misconfigured',
    message: approvalReleaseFailureMessage(approvalId),
    approvalId,
  };
}

function governedRateLimitFailure(response: GatewayResponse): GovernedInvocationOutcome {
  const status = response.status === 'rate_limited' || response.status === 'rate_limit_unavailable'
    ? response.status
    : 'rate_limit_unavailable';
  const retryAfterSeconds = response.error?.retryAfterSeconds;
  return {
    ok: false,
    status,
    message: response.error?.message ?? 'Connection rate limit check failed.',
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

function gatewayApprovalPresentation(decision: GovernedApprovalDecision): {
  readonly approvalId: string;
  readonly message: string;
  readonly status: 'pending' | 'rejected' | 'failed';
  readonly authority: GovernedApprovalDecision['authority'];
  readonly approverName: string;
  readonly scope: 'once';
  readonly requestState: GovernedApprovalDecision['requestState'];
  readonly nextAction: GovernedApprovalDecision['nextAction'];
  readonly retry: GovernedApprovalDecision['retry'];
} {
  return {
    approvalId: decision.approvalId,
    message: decision.message,
    status: decision.kind === 'pending'
      ? 'pending'
      : decision.kind === 'rejected'
        ? 'rejected'
        : 'failed',
    authority: decision.authority,
    approverName: decision.approverName,
    scope: 'once',
    requestState: decision.requestState,
    nextAction: decision.nextAction,
    retry: decision.retry,
  };
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
  if (decision.kind === 'limited') {
    return gatewayFailure('rate_limited', decision.message, {
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  }
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
