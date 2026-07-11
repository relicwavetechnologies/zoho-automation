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
import type {
  GatewayMemberContext,
  GatewayResponse,
} from './gateway.types';
import { gatewayFailure, gatewaySuccess } from './gateway.types';

export interface ToolExecutorInput {
  readonly member: GatewayMemberContext;
  readonly departmentId?: string;
  readonly toolId: string;
  readonly args: Record<string, unknown>;
  readonly requestId?: string;
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

export interface PreparedToolInvocation {
  readonly toolId: string;
  readonly action: ToolActionGroup;
  readonly args: Record<string, unknown>;
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
        chatId: `gateway:${member.sessionId}`,
        argsSummary,
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
      correlationId: tool.id,
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

    return gatewaySuccess({ toolId: tool.id, action, result: result.value });
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

    const runContext = this.buildRunContext(member, effectiveDepartmentId, perm.department?.zohoReadScope, input.requestId);
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
      chatId: `gateway:${member.sessionId}`,
    };
  }
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
