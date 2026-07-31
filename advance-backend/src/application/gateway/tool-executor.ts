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
import { limitModelFacingResult } from './model-facing-result-limit';

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
}

export interface RuntimeToolPreflightOutcome {
  readonly status: RuntimeToolExecutionOutcome['status'];
  readonly toolId: string;
  readonly action?: ToolActionGroup;
  readonly validation?: Record<string, unknown>;
  readonly message?: string;
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
      action,
      args: validatedArgs,
    });
    if (ratePreflight) return ratePreflight;

    let executionGrant: { approvalId: string } | undefined;

    // A connection policy can require its owner even when the caller did not
    // select a department. The gate itself preserves the old no-department
    // behaviour for ordinary department-based approval rules.
    if (
      this.deps.approvalGate
      && tool.id !== asToolId('memoryRecall')
      && !isCompanyAxisPublishingInvocation(tool.id, validatedArgs)
    ) {
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
        return gatewaySuccess({
          toolId: tool.id,
          action,
          result: limitModelFacingResult(decision.result),
          replayedApproval: {
            approvalId: decision.approvalId,
            status: 'completed',
          },
        });
      }

      executionGrant = decision.executionGrant;
    }

    const rateConsume = await this.consumeRateLimit({
      companyId: runContext.companyId,
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

    const execCtx: ToolExecutionContext = {
      runContext,
      perm,
      correlationId: input.requestId ?? input.execution?.actionId ?? randomUUID(),
      logger: this.deps.logger.child({ toolId: tool.id }),
      clock: this.deps.clock,
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
        return gatewayFailure('tool_error', result.error.message);
      }

      if (executionGrant) {
        const finalized = await this.deps.approvalGate?.completeExecution(executionGrant, {
          status: 'success',
          result: result.value,
        });
        if (!finalized) return approvalCheckpointFailure(executionGrant.approvalId);
      }

      return gatewaySuccess({
        toolId: tool.id,
        action,
        result: limitModelFacingResult(result.value),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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

    const ratePreflight = await this.preflightRateLimit({
      companyId: runContext.companyId,
      action,
      args: validatedArgs,
    });
    if (ratePreflight) return runtimeRateLimitFailure(toolId, ratePreflight, action);

    let executionGrant: { approvalId: string } | undefined;
    if (input.approvalGate && input.chatId && tool.id !== asToolId('memoryRecall')) {
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
        return {
          status: 'success',
          toolId,
          action,
          result: decision.result,
        };
      }
      executionGrant = decision.executionGrant;
    }

    const rateConsume = await this.consumeRateLimit({
      companyId: runContext.companyId,
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

    const context: ToolExecutionContext = {
      runContext,
      perm,
      // A tool ID is global and would make a per-run provider budget shared by
      // every conversation. Prefer the channel's durable run identity instead.
      correlationId: runContext.traceId ?? runContext.requestId ?? runContext.chatId ?? randomUUID(),
      logger: this.deps.logger.child({ toolId: tool.id, channel: runContext.channel }),
      clock: this.deps.clock,
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
        return runtimeFailure(toolId, 'tool_error', result.error.message, action);
      }

      if (executionGrant) {
        const finalized = await input.approvalGate?.completeExecution(executionGrant, {
          status: 'success',
          result: result.value,
        });
        if (!finalized) {
          return runtimeApprovalCheckpointFailure(toolId, action, executionGrant.approvalId);
        }
      }
      return {
        status: 'success',
        toolId,
        action,
        result: limitModelFacingResult(result.value),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
    const accessible = provider === 'zoho'
      ? await this.deps.connectionRegistry.listAccessibleZohoConnections(connectionInput)
      : await this.deps.connectionRegistry.listAccessibleLarkConnections(connectionInput);
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
    if (hasMismatchedMemoryDepartment(toolId, validatedArgs, departmentId)) {
      return {
        ok: false,
        response: gatewayFailure(
          'invalid_args',
          'memoryPublishing departmentId must match the currently selected gateway department.',
        ),
      };
    }
    const publishingDepartmentId = publishingScopedDepartmentId(toolId, validatedArgs, departmentId);
    const companyAxisPublishing = isCompanyAxisPublishingInvocation(toolId, validatedArgs);
    // Recall scope is derived by the tool from every active membership. The
    // generic gateway department is desktop transport context, never a recall
    // selector, so it must not enter permission resolution or run context.
    const effectiveDepartmentId = toolId === 'memoryRecall' || companyAxisPublishing
      ? undefined
      : publishingDepartmentId;

    const basePermissionQuery = {
      companyId: asCompanyId(member.companyId),
      userId: asUserId(member.userId),
      companyRole: asCompanyRoleSlug(member.aiRole),
      channel: member.channel ?? 'desktop',
    } as const;

    let permResult = await this.deps.permissions.resolve({
      ...basePermissionQuery,
      ...(effectiveDepartmentId ? { departmentId: asDepartmentId(effectiveDepartmentId) } : {}),
    });

    if (
      isPublishingAuthorityCheck(toolId, validatedArgs)
      && publishingDepartmentId
    ) {
      const companyPermResult = await this.deps.permissions.resolve(basePermissionQuery);
      if (!companyPermResult.ok) {
        return { ok: false, response: gatewayFailure('permission_denied', companyPermResult.error.message) };
      }

      if (!permResult.ok && toolId !== 'memoryPublishing') {
        return { ok: false, response: gatewayFailure('permission_denied', permResult.error.message) };
      }

      permResult = {
        ok: true,
        value: permResult.ok
          ? mergePublishingAuthority(companyPermResult.value, permResult.value)
          : companyPermResult.value,
      };
    }

    if (!permResult.ok) {
      return { ok: false, response: gatewayFailure('permission_denied', permResult.error.message) };
    }

    const perm = toolId === 'memoryRecall'
      ? withGatewayMemoryRecallAccess(permResult.value)
      : permResult.value;

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
      chatId: larkDelivery?.chatId ?? execution?.threadId ?? `gateway:${member.sessionId}`,
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
    readonly action: ToolActionGroup;
    readonly args: Record<string, unknown>;
  }): Promise<GatewayResponse | null> {
    if (!this.deps.connectionRateLimits) return null;
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
    readonly action: ToolActionGroup;
    readonly args: Record<string, unknown>;
  }): Promise<GatewayResponse | null> {
    if (!this.deps.connectionRateLimits) return null;
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
    grant: { readonly approvalId: string },
  ): Promise<boolean> {
    if (!approvalGate) return false;
    return approvalGate.releaseExecution(grant);
  }
}

type RuntimeConnectionProvider = 'zoho' | 'lark';

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
  return undefined;
}

function runtimeConnectionLabel(provider: RuntimeConnectionProvider): string {
  if (provider === 'lark') return 'Lark';
  return 'Zoho';
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

function isPublishingAuthorityCheck(toolId: string, args: unknown): boolean {
  return (toolId === 'skillPublishing' || toolId === 'memoryPublishing')
    && typeof args === 'object'
    && args !== null
    && (args as { operation?: unknown }).operation === 'check_authority';
}

function hasMismatchedMemoryDepartment(
  toolId: string,
  args: unknown,
  gatewayDepartmentId: string | undefined,
): boolean {
  if (toolId !== 'memoryPublishing' || typeof args !== 'object' || args === null) return false;
  const departmentId = (args as { departmentId?: unknown }).departmentId;
  return typeof departmentId === 'string' && departmentId !== gatewayDepartmentId;
}

function isCompanyAxisPublishingInvocation(toolId: string, args: unknown): boolean {
  return (toolId === 'skillPublishing' || toolId === 'memoryPublishing')
    && typeof args === 'object'
    && args !== null
    && (args as { operation?: unknown }).operation === 'publish'
    && (
      (args as { scope?: unknown }).scope === 'company'
      || (toolId === 'memoryPublishing' && (args as { scope?: unknown }).scope === 'personal')
    );
}

function publishingScopedDepartmentId(
  toolId: string,
  args: unknown,
  gatewayDepartmentId: string | undefined,
): string | undefined {
  if (
    (toolId === 'skillPublishing' || toolId === 'memoryPublishing')
    && typeof args === 'object'
    && args !== null
    && typeof (args as { departmentId?: unknown }).departmentId === 'string'
  ) {
    return (args as { departmentId: string }).departmentId;
  }

  return gatewayDepartmentId;
}

function mergePublishingAuthority(
  companyPerm: PermissionResult,
  departmentPerm: PermissionResult,
): PermissionResult {
  const allowedActionsByTool = new Map(companyPerm.allowedActionsByTool);
  for (const [toolId, actions] of departmentPerm.allowedActionsByTool) {
    const mergedActions = new Set<ToolActionGroup>(allowedActionsByTool.get(toolId) ?? []);
    for (const action of actions) mergedActions.add(action);
    allowedActionsByTool.set(toolId, mergedActions);
  }

  return {
    allowedToolIds: new Set(allowedActionsByTool.keys()),
    allowedActionsByTool,
    decisions: [...companyPerm.decisions, ...departmentPerm.decisions],
    ...(departmentPerm.department ? { department: departmentPerm.department } : {}),
  };
}

function withGatewayMemoryRecallAccess(perm: PermissionResult): PermissionResult {
  const recallToolId = asToolId('memoryRecall');
  const allowedActionsByTool = new Map(perm.allowedActionsByTool);
  const recallActions = new Set<ToolActionGroup>(allowedActionsByTool.get(recallToolId) ?? []);
  recallActions.add('read');
  allowedActionsByTool.set(recallToolId, recallActions);

  return {
    ...perm,
    allowedToolIds: new Set([...perm.allowedToolIds, recallToolId]),
    allowedActionsByTool,
  };
}
