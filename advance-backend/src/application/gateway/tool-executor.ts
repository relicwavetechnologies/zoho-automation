import type { ToolRegistry } from '../orchestration/tools/tool-registry';
import type { PermissionService } from '../permissions/permission.service';
import type { ApprovalGateService } from '../approval/approval-gate.service';
import { buildArgsSummary } from '../orchestration/tools/ai-sdk-adapter';
import type { ToolExecutionContext } from '../orchestration/tools/tool.contract';
import type { RunContext } from '../../domain/orchestration/run-context';
import type { Logger } from '../../shared/logger';
import type { Clock } from '../../shared/clock';
import { asCompanyId, asDepartmentId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
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
}

export interface ToolExecutorDeps {
  readonly toolRegistry: ToolRegistry;
  readonly permissions: PermissionService;
  readonly approvalGate?: ApprovalGateService;
  readonly logger: Logger;
  readonly clock: Clock;
}

export class ToolExecutor {
  constructor(private readonly deps: ToolExecutorDeps) {}

  async invoke(input: ToolExecutorInput): Promise<GatewayResponse> {
    const { member, departmentId, toolId, args } = input;

    if (toolId === 'runCommand') {
      return gatewayFailure(
        'permission_denied',
        'runCommand is not available through the company gateway',
      );
    }

    const tool = this.deps.toolRegistry.byId(toolId as never);
    if (!tool) {
      return gatewayFailure('unknown_tool', `Unknown toolId "${toolId}"`);
    }

    const argsParse = tool.argsSchema.safeParse(args);
    if (!argsParse.success) {
      const issues = argsParse.error.errors
        .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
        .join('; ');
      return gatewayFailure('invalid_args', `Invalid args for "${toolId}" — ${issues}`);
    }

    const validatedArgs = argsParse.data;

    const permResult = await this.deps.permissions.resolve({
      companyId: asCompanyId(member.companyId),
      userId: asUserId(member.userId),
      companyRole: asCompanyRoleSlug(member.aiRole),
      ...(departmentId ? { departmentId: asDepartmentId(departmentId) } : {}),
      channel: 'desktop',
    });

    if (!permResult.ok) {
      return gatewayFailure('permission_denied', permResult.error.message);
    }

    const perm = permResult.value;

    const permCheck = tool.permissionCheck(validatedArgs, perm);
    if (!permCheck.ok) {
      return gatewayFailure('permission_denied', permCheck.error.message);
    }

    const action = permCheck.value;

    const runContext = this.buildRunContext(member, departmentId, perm.department?.zohoReadScope, input.requestId);
    let executionGrant: { approvalId: string } | undefined;

    if (this.deps.approvalGate && departmentId) {
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
