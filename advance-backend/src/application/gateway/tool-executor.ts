import type { ToolRegistry } from '../orchestration/tools/tool-registry';
import type { PermissionService } from '../permissions/permission.service';
import type { PermissionResult } from '../permissions/permission.types';
import type { ApprovalGateService } from '../approval/approval-gate.service';
import { buildArgsSummary } from '../orchestration/tools/ai-sdk-adapter';
import type { ToolExecutionContext } from '../orchestration/tools/tool.contract';
import type { Tool } from '../orchestration/tools/tool.contract';
import type { RunContext } from '../../domain/orchestration/run-context';
import type { Logger } from '../../shared/logger';
import type { Clock } from '../../shared/clock';
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
import { limitModelFacingResult } from './model-facing-result-limit';

export interface ToolExecutorInput {
  readonly member: GatewayMemberContext;
  readonly departmentId?: string;
  readonly toolId: string;
  readonly args: Record<string, unknown>;
  readonly requestId?: string;
  /** Non-authoritative desktop provenance for one isolated Pi action. */
  readonly execution?: GatewayExecutionContext;
  /** Optional invariant used by prepared commits to prevent action reclassification. */
  readonly expectedAction?: ToolActionGroup;
}

export interface ToolExecutorDeps {
  readonly toolRegistry: ToolRegistry;
  readonly permissions: PermissionService;
  readonly approvalGate?: ApprovalGateService;
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
  readonly allowedToolIds?: ReadonlySet<string>;
  readonly approvalGate?: ApprovalGateService;
  readonly chatId?: string;
  readonly onProgress?: (message: string) => void;
  readonly expectedAction?: ToolActionGroup;
}

export interface RuntimeToolExecutionOutcome {
  readonly status: Extract<GatewayResponse['status'],
    'success' | 'unknown_tool' | 'invalid_args' | 'permission_denied'
    | 'approval_required' | 'approval_rejected' | 'approval_misconfigured' | 'tool_error'>;
  readonly toolId: string;
  readonly action?: ToolActionGroup;
  readonly result?: unknown;
  readonly message?: string;
  readonly approvalId?: string;
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

type ResolveToolInvocationResult =
  | { readonly ok: true; readonly value: ResolvedToolInvocation }
  | { readonly ok: false; readonly response: GatewayResponse };

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

    let executionGrant: { approvalId: string } | undefined;

    if (this.deps.approvalGate && effectiveDepartmentId && tool.id !== asToolId('memoryRecall')) {
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
          approval: { approvalId: decision.approvalId, message: decision.message },
        });
      }

      if (decision.kind === 'rejected') {
        return gatewayFailure('approval_rejected', decision.message, {
          approval: { approvalId: decision.approvalId, message: decision.message },
        });
      }

      if (decision.kind === 'misconfigured') {
        return gatewayFailure('approval_misconfigured', decision.message);
      }

      executionGrant = decision.executionGrant;
    }

    const execCtx: ToolExecutionContext = {
      runContext,
      perm,
      correlationId: input.requestId ?? input.execution?.actionId ?? randomUUID(),
      logger: this.deps.logger.child({ toolId: tool.id }),
      clock: this.deps.clock,
    };

    const result = await tool.execute(validatedArgs, execCtx);
    if (!result.ok) {
      if (executionGrant) {
        await this.deps.approvalGate?.failExecution(executionGrant, {
          status: 'tool_error',
          message: result.error.message,
        });
      }
      return gatewayFailure('tool_error', result.error.message);
    }

    if (executionGrant) {
      await this.deps.approvalGate?.completeExecution(executionGrant, {
        status: 'success',
        result: result.value,
      });
    }

    return gatewaySuccess({
      toolId: tool.id,
      action,
      result: limitModelFacingResult(result.value),
    });
  }

  /**
   * Executes a request-scoped tool call for a backend-hosted channel. The
   * caller must supply the permission snapshot that the orchestration engine
   * just resolved; this method does not create an alternate identity or RBAC
   * decision path.
   */
  async executeForRuntime(input: RuntimeToolExecutionInput): Promise<RuntimeToolExecutionOutcome> {
    const { toolId, args, runContext, perm } = input;

    if (toolId === 'runCommand') {
      return runtimeFailure(toolId, 'permission_denied', 'runCommand is not available through backend-hosted channels.');
    }
    if (input.allowedToolIds && !input.allowedToolIds.has(toolId)) {
      return runtimeFailure(toolId, 'permission_denied', 'This tool is not available for the current member.');
    }

    const tool = this.deps.toolRegistry.byId(toolId as never);
    if (!tool) return runtimeFailure(toolId, 'unknown_tool', `Unknown toolId "${toolId}"`);

    const parsed = tool.argsSchema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.errors
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return runtimeFailure(toolId, 'invalid_args', `Invalid args for "${toolId}" — ${issues}`);
    }

    const validatedArgs = parsed.data as Record<string, unknown>;
    const permissionCheck = tool.permissionCheck(validatedArgs, perm);
    if (!permissionCheck.ok) {
      return runtimeFailure(toolId, 'permission_denied', permissionCheck.error.message);
    }
    const action = permissionCheck.value;
    if (input.expectedAction && action !== input.expectedAction) {
      return runtimeFailure(
        toolId,
        'invalid_args',
        `Tool action changed from "${input.expectedAction}" to "${action}" after approval.`,
        action,
      );
    }

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
      });
      if (decision.kind === 'pending') {
        return runtimeFailure(toolId, 'approval_required', decision.message, action, decision.approvalId);
      }
      if (decision.kind === 'rejected') {
        return runtimeFailure(toolId, 'approval_rejected', decision.message, action, decision.approvalId);
      }
      if (decision.kind === 'misconfigured') {
        return runtimeFailure(toolId, 'approval_misconfigured', decision.message, action);
      }
      executionGrant = decision.executionGrant;
    }

    const context: ToolExecutionContext = {
      runContext,
      perm,
      // A tool ID is global and would make a per-run provider budget shared by
      // every conversation. Prefer the channel's durable run identity instead.
      correlationId: runContext.traceId ?? runContext.requestId ?? runContext.chatId ?? randomUUID(),
      logger: this.deps.logger.child({ toolId: tool.id, channel: runContext.channel }),
      clock: this.deps.clock,
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    };

    try {
      const result = await tool.execute(validatedArgs, context);
      if (!result.ok) {
        if (executionGrant) {
          await input.approvalGate?.failExecution(executionGrant, {
            status: 'tool_error',
            message: result.error.message,
          });
        }
        return runtimeFailure(toolId, 'tool_error', result.error.message, action);
      }

      if (executionGrant) {
        await input.approvalGate?.completeExecution(executionGrant, {
          status: 'success',
          result: result.value,
        });
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
        await input.approvalGate?.failExecution(executionGrant, { status: 'tool_error', message });
      }
      return runtimeFailure(toolId, 'tool_error', message, action);
    }
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
      channel: 'desktop',
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
    return {
      companyId: asCompanyId(member.companyId),
      userId: asUserId(member.userId),
      companyRole: asCompanyRoleSlug(member.aiRole),
      ...(departmentId ? { departmentId: asDepartmentId(departmentId) } : {}),
      channel: 'desktop',
      ...(member.email ? { requesterEmail: member.email } : {}),
      ...(member.larkOpenId ? { userExternalId: member.larkOpenId } : {}),
      ...(departmentZohoReadScope ? { departmentZohoReadScope } : {}),
      requesterAiRole: member.aiRole,
      ...(requestId ? { traceId: requestId, requestId } : {}),
      // Tool runtime context needs the real durable desktop thread so
      // background work can return there. Approval idempotency continues to
      // use the separate, run-scoped gatewayApprovalChatId above.
      chatId: execution?.threadId ?? `gateway:${member.sessionId}`,
    };
  }
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

/**
 * A manager approval may be retried within one run, but must never be shared
 * by two independent desktop chats or two separate user turns. The execution
 * context is not trusted for authorization; it only partitions an already
 * authenticated member session's approval/idempotency namespace.
 */
function gatewayApprovalChatId(
  member: GatewayMemberContext,
  execution: GatewayExecutionContext | undefined,
): string {
  if (!execution) return `gateway:${member.sessionId}`;
  return `gateway:${member.sessionId}:thread:${execution.threadId}:run:${execution.runId}`;
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
