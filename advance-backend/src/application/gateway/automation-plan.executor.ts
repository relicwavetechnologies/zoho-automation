import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { RuntimeApprovalRepository, RuntimeApprovalRow } from '../../infrastructure/persistence/runtime-approval.repository';
import type { Logger } from '../../shared/logger';
import { asCompanyId, asDepartmentId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { PermissionService } from '../permissions/permission.service';
import type { GatewayExecutionContext } from './gateway.types';
import { isAutomationPlanApproval, parseAutomationPlanPayload } from './automation-plan.service';
import type { ToolExecutor } from './tool-executor';

export interface AutomationPlanExecutorDeps {
  readonly approvalRepo: RuntimeApprovalRepository;
  readonly channelIdentityRepo: ChannelIdentityRepoPort;
  readonly permissions: PermissionService;
  readonly toolExecutor: ToolExecutor;
  readonly logger: Logger;
}

/**
 * Server-side executor for a manager-approved automation batch.
 *
 * The only executable source is the immutable payload stored before the Lark
 * approval. The local Python runtime is never involved here, and each call is
 * still schema- and RBAC-validated immediately before it reaches an
 * integration.
 */
export class AutomationPlanExecutor {
  constructor(private readonly deps: AutomationPlanExecutorDeps) {}

  async resume(approval: RuntimeApprovalRow, decision: 'approved' | 'rejected'): Promise<void> {
    if (!isAutomationPlanApproval(approval)) return;
    if (decision === 'rejected') {
      await this.deps.approvalRepo.persistResult(approval.id, {
        status: 'rejected',
        completedCalls: 0,
        totalCalls: parseAutomationPlanPayload(approval.payloadJson)?.invocations.length ?? 0,
      });
      return;
    }

    const requesterId = approval.requestedBy;
    if (!requesterId) {
      await this.fail(approval.id, 'invalid_plan', 'The approved batch does not identify its requester.');
      return;
    }
    const claimed = await this.deps.approvalRepo.claimApprovedExecution(approval.id, requesterId);
    if (!claimed.ok) {
      this.deps.logger.error('automation_plan.claim_failed', { planId: approval.id, error: claimed.error.message });
      return;
    }
    if (!claimed.value) {
      this.deps.logger.info('automation_plan.claim_unavailable', { planId: approval.id });
      return;
    }

    const plan = parseAutomationPlanPayload(claimed.value.payloadJson);
    const meta = asRecord(claimed.value.metadataJson);
    const departmentId = asString(meta['departmentId']);
    if (!plan || !departmentId) {
      await this.fail(claimed.value.id, 'invalid_plan', 'The approved batch is incomplete or invalid.');
      return;
    }

    const identityResult = await this.deps.channelIdentityRepo.resolveByUserId(requesterId);
    if (!identityResult.ok || !identityResult.value) {
      await this.fail(claimed.value.id, 'identity_not_found', 'The requester can no longer be verified.');
      return;
    }
    const identity = identityResult.value;
    const permissionResult = await this.deps.permissions.resolve({
      companyId: asCompanyId(identity.companyId),
      userId: asUserId(identity.userId),
      companyRole: asCompanyRoleSlug(identity.aiRole),
      departmentId: asDepartmentId(departmentId),
      channel: 'desktop',
    });
    if (!permissionResult.ok) {
      await this.fail(claimed.value.id, 'permission_denied', permissionResult.error.message);
      return;
    }

    const execution = parseExecution(meta['execution']);
    const results: Array<Record<string, unknown>> = [];
    const totalCalls = plan.invocations.length;
    await this.persistProgress(claimed.value.id, {
      status: 'executing',
      title: plan.title,
      completedCalls: 0,
      totalCalls,
      current: 'Revalidating the approved batch.',
      results,
    });

    for (const [index, invocation] of plan.invocations.entries()) {
      const callNumber = index + 1;
      await this.persistProgress(claimed.value.id, {
        status: 'executing',
        title: plan.title,
        completedCalls: index,
        totalCalls,
        current: `Executing ${invocation.toolId}.${invocation.action} (${callNumber}/${totalCalls}).`,
        results,
      });

      const outcome = await this.deps.toolExecutor.executeForRuntime({
        toolId: invocation.toolId,
        args: invocation.args,
        runContext: {
          companyId: asCompanyId(identity.companyId),
          userId: asUserId(identity.userId),
          companyRole: asCompanyRoleSlug(identity.aiRole),
          departmentId: asDepartmentId(departmentId),
          channel: 'desktop',
          requesterAiRole: identity.aiRole,
          ...(identity.email ? { requesterEmail: identity.email } : {}),
          ...(identity.larkOpenId ? { userExternalId: identity.larkOpenId } : {}),
          ...(permissionResult.value.department?.zohoReadScope
            ? { departmentZohoReadScope: permissionResult.value.department.zohoReadScope }
            : {}),
          traceId: `automation-plan-${claimed.value.id}`,
          requestId: `automation-plan-${claimed.value.id}-${callNumber}`,
          ...(execution?.threadId ? { chatId: execution.threadId } : {}),
        },
        perm: permissionResult.value,
        expectedAction: invocation.action,
      });
      if (outcome.status !== 'success') {
        const message = outcome.message ?? `The call ${invocation.toolId}.${invocation.action} could not be completed.`;
        results.push({
          index,
          toolId: invocation.toolId,
          action: invocation.action,
          status: 'failed',
          message,
        });
        await this.fail(claimed.value.id, 'execution_failed', message, {
          title: plan.title,
          completedCalls: index,
          totalCalls,
          failedCall: { index, toolId: invocation.toolId, action: invocation.action },
          results,
        });
        return;
      }

      results.push({
        index,
        toolId: invocation.toolId,
        action: invocation.action,
        status: 'completed',
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      });
    }

    const completed = await this.deps.approvalRepo.completeApprovedExecution(claimed.value.id, {
      status: 'completed',
      title: plan.title,
      completedCalls: totalCalls,
      totalCalls,
      results,
    });
    if (!completed.ok) {
      this.deps.logger.error('automation_plan.complete_failed', { planId: claimed.value.id, error: completed.error.message });
    }
  }

  private async persistProgress(planId: string, value: Record<string, unknown>): Promise<void> {
    const saved = await this.deps.approvalRepo.persistExecutingResult(planId, value);
    if (!saved.ok) {
      this.deps.logger.warn('automation_plan.progress_persist_failed', { planId, error: saved.error.message });
    }
  }

  private async fail(
    planId: string,
    status: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const failed = await this.deps.approvalRepo.failApprovedExecution(planId, { status, message, ...extra });
    if (!failed.ok) {
      this.deps.logger.error('automation_plan.fail_persist_failed', { planId, error: failed.error.message });
    }
    this.deps.logger.warn('automation_plan.failed', { planId, status, message });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function parseExecution(value: unknown): GatewayExecutionContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  return candidate['version'] === 1
    && typeof candidate['threadId'] === 'string'
    && typeof candidate['runId'] === 'string'
    && typeof candidate['actionId'] === 'string'
    ? candidate as GatewayExecutionContext
    : undefined;
}
