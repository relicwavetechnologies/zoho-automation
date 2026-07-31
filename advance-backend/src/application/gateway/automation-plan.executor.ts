import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { RuntimeApprovalRepository, RuntimeApprovalRow } from '../../infrastructure/persistence/runtime-approval.repository';
import type { Logger } from '../../shared/logger';
import { asCompanyId, asDepartmentId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { PermissionService } from '../permissions/permission.service';
import type { ApprovalGateService } from '../approval/approval-gate.service';
import type { ApprovalResolverService } from '../approval/approval-resolver.service';
import type { RunContext } from '../../domain/orchestration/run-context';
import type { GatewayExecutionContext } from './gateway.types';
import {
  type AutomationApprovalSignature,
  type AutomationRequiredApprovalSignature,
  approvalSignatureFromRequirement,
  approvalSignaturesEqual,
  computeAutomationPlanHash,
  isAutomationPlanApproval,
  parseAutomationPlanPayload,
} from './automation-plan.service';
import type { ToolExecutor } from './tool-executor';
import type { SkillCatalogService } from '../skills/skill-catalog.service';
import type { SkillAccessEnforcementPort } from '../skills/skill-access.port';
import { withWorkDiscoveryPermissions } from './work-resolution.service';

export interface AutomationPlanExecutorDeps {
  readonly approvalRepo: RuntimeApprovalRepository;
  readonly channelIdentityRepo: ChannelIdentityRepoPort;
  readonly permissions: PermissionService;
  readonly approvalGate: ApprovalGateService;
  readonly approvalResolver: ApprovalResolverService;
  readonly toolExecutor: ToolExecutor;
  readonly skillCatalog: SkillCatalogService;
  readonly skillAccessEnforcement: SkillAccessEnforcementPort;
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

    const claimedApproval = claimed.value;
    let recoveryContext: Record<string, unknown> = {};
    try {
      const plan = parseAutomationPlanPayload(claimedApproval.payloadJson);
      const meta = asRecord(claimedApproval.metadataJson);
      const departmentId = asString(meta['departmentId']);
      if (!plan || !departmentId) {
        await this.fail(claimedApproval.id, 'invalid_plan', 'The approved batch is incomplete or invalid.');
        return;
      }
      const results: Array<Record<string, unknown>> = [];
      const totalCalls = plan.invocations.length;
      recoveryContext = {
        title: plan.title,
        completedCalls: 0,
        totalCalls,
        results,
      };
      const storedPlanHash = asString(meta['planHash']);
      if (!storedPlanHash || storedPlanHash !== computeAutomationPlanHash(plan)) {
        await this.fail(
          claimedApproval.id,
          'invalid_plan',
          'The approved batch no longer matches its stored approval fingerprint.',
        );
        return;
      }

      const approvalCompanyId = claimedApproval.companyId;
      if (!approvalCompanyId) {
        await this.fail(claimedApproval.id, 'invalid_plan', 'The approved batch has no authoritative company.');
        return;
      }
      const identityResult = await this.deps.channelIdentityRepo.resolveByUserId(
        requesterId,
        approvalCompanyId,
      );
      if (!identityResult.ok || !identityResult.value) {
        await this.fail(claimedApproval.id, 'identity_not_found', 'The requester can no longer be verified.');
        return;
      }
      const identity = identityResult.value;
      if (identity.companyId !== approvalCompanyId || identity.userId !== requesterId) {
        await this.fail(
          claimedApproval.id,
          'identity_scope_mismatch',
          'The requester no longer matches the approved company.',
        );
        return;
      }
      const permissionResult = await this.resolvePermissions(identity, departmentId);
      if (!permissionResult.ok) {
        await this.fail(claimedApproval.id, 'permission_denied', permissionResult.error.message);
        return;
      }
      const grantedSkillIds = await this.deps.skillAccessEnforcement.listGrantedSkillIds(
        identity.companyId,
        requesterId,
      );

      const execution = parseExecution(meta['execution']);
      const deliveryMode = meta['deliveryMode'] === 'scheduled_runtime_delivery'
        ? 'scheduled_runtime_delivery' as const
        : undefined;
      const approvedByUserId = asString(meta['resolvedManagerUserId']);
      if (!approvedByUserId || plan.approvalSignature.approverUserId !== approvedByUserId) {
        await this.fail(claimedApproval.id, 'invalid_plan', 'The approved batch does not identify its approval authority.');
        return;
      }
      const inconsistentApproval = plan.invocations.find((invocation) => (
        invocation.approvalSignature.kind === 'required'
        && !approvalSignaturesEqual(plan.approvalSignature, invocation.approvalSignature)
      ));
      if (inconsistentApproval) {
        await this.fail(claimedApproval.id, 'invalid_plan', 'The approved batch contains an inconsistent approval signature.');
        return;
      }
      const currentBatchSignature = await this.resolveCurrentBatchSignature(
        plan.approvalSignature,
        departmentId,
        identity.companyId,
      );
      if (!currentBatchSignature || !approvalSignaturesEqual(plan.approvalSignature, currentBatchSignature)) {
        await this.fail(
          claimedApproval.id,
          'approval_changed',
          'The human authority for this batch changed after approval. Prepare a new batch for the current policy.',
        );
        return;
      }

      const runContext = this.buildRunContext({
        identity,
        departmentId,
        approvalId: claimedApproval.id,
        ...(deliveryMode ? { deliveryMode } : {}),
        ...(execution ? { execution } : {}),
        ...(permissionResult.value.department?.zohoReadScope
          ? { departmentZohoReadScope: permissionResult.value.department.zohoReadScope }
          : {}),
      });
      const currentInvocationSignatures: AutomationApprovalSignature[] = [];
      for (const invocation of plan.invocations) {
        if (invocation.skillId) {
          const matches = await this.deps.skillCatalog.authorizesTool({
            companyId: identity.companyId,
            departmentId,
            permission: withWorkDiscoveryPermissions(permissionResult.value),
            grantedSkillIds,
            skillId: invocation.skillId,
            toolId: invocation.toolId,
          });
          if (!matches) {
            this.deps.logger.warn('automation_plan.skill_advisory_mismatch', {
              planId: claimedApproval.id,
              skillId: invocation.skillId,
              toolId: invocation.toolId,
              stage: 'pre_execution',
            });
          }
        }
        const approvalRequirement = await this.deps.approvalGate.inspect({
          toolId: invocation.toolId,
          action: invocation.action,
          args: invocation.args,
          perm: permissionResult.value,
          runContext,
        });
        if (approvalRequirement.kind === 'misconfigured') {
          await this.fail(claimedApproval.id, 'approval_misconfigured', approvalRequirement.message);
          return;
        }
        const currentSignature = approvalSignatureFromRequirement(approvalRequirement);
        if (!approvalSignaturesEqual(invocation.approvalSignature, currentSignature)) {
          await this.fail(
            claimedApproval.id,
            'approval_changed',
            'The approval authority or governed connection policy changed after this batch was approved. Prepare a new batch for the current policy.',
          );
          return;
        }
        const runtimePreflight = await this.deps.toolExecutor.preflightForRuntime({
          toolId: invocation.toolId,
          args: invocation.args,
          runContext,
          perm: permissionResult.value,
          expectedAction: invocation.action,
        });
        if (runtimePreflight.status !== 'success') {
          await this.fail(
            claimedApproval.id,
            'preflight_failed',
            runtimePreflight.message
              ?? `The call ${invocation.toolId}.${invocation.action} is no longer ready to execute.`,
            {
              title: plan.title,
              completedCalls: 0,
              totalCalls: plan.invocations.length,
              failedCall: {
                index: currentInvocationSignatures.length,
                toolId: invocation.toolId,
                action: invocation.action,
              },
            },
          );
          return;
        }
        currentInvocationSignatures.push(currentSignature);
      }

      if (!await this.persistProgress(claimedApproval.id, {
        status: 'executing',
        title: plan.title,
        completedCalls: 0,
        totalCalls,
        current: 'Revalidating the approved batch.',
        results,
      })) {
        await this.fail(claimedApproval.id, 'checkpoint_failed', 'The batch could not store its initial execution checkpoint. Nothing was executed.');
        return;
      }

      for (const [index, invocation] of plan.invocations.entries()) {
        const callNumber = index + 1;
        if (!await this.persistProgress(claimedApproval.id, {
          status: 'executing',
          title: plan.title,
          completedCalls: index,
          totalCalls,
          current: `Executing ${invocation.toolId}.${invocation.action} (${callNumber}/${totalCalls}).`,
          results,
        })) {
          await this.fail(claimedApproval.id, 'checkpoint_failed', 'The batch could not store its pre-call checkpoint. No further actions were executed.', {
            title: plan.title,
            completedCalls: index,
            totalCalls,
            results,
          });
          return;
        }

        const currentPermissionResult = await this.resolvePermissions(identity, departmentId);
        if (!currentPermissionResult.ok) {
          await this.fail(
            claimedApproval.id,
            'permission_denied',
            currentPermissionResult.error.message,
            { title: plan.title, completedCalls: index, totalCalls, results },
          );
          return;
        }
        if (invocation.skillId) {
          const currentGrantedSkillIds = await this.deps.skillAccessEnforcement.listGrantedSkillIds(
            identity.companyId,
            requesterId,
          );
          const matches = await this.deps.skillCatalog.authorizesTool({
            companyId: identity.companyId,
            departmentId,
            permission: withWorkDiscoveryPermissions(currentPermissionResult.value),
            grantedSkillIds: currentGrantedSkillIds,
            skillId: invocation.skillId,
            toolId: invocation.toolId,
          });
          if (!matches) {
            this.deps.logger.warn('automation_plan.skill_advisory_mismatch', {
              planId: claimedApproval.id,
              skillId: invocation.skillId,
              toolId: invocation.toolId,
              stage: 'per_call',
            });
          }
        }
        const currentBatchApproval = await this.resolveCurrentBatchSignature(
          plan.approvalSignature,
          departmentId,
          identity.companyId,
        );
        if (!currentBatchApproval || !approvalSignaturesEqual(plan.approvalSignature, currentBatchApproval)) {
          await this.fail(
            claimedApproval.id,
            'approval_changed',
            'The human authority for this batch changed after approval. Prepare a new batch for the current policy.',
            { title: plan.title, completedCalls: index, totalCalls, results },
          );
          return;
        }
        const currentRunContext = {
          ...this.buildRunContext({
            identity,
            departmentId,
            approvalId: claimedApproval.id,
            ...(deliveryMode ? { deliveryMode } : {}),
            ...(execution ? { execution } : {}),
            ...(currentPermissionResult.value.department?.zohoReadScope
              ? { departmentZohoReadScope: currentPermissionResult.value.department.zohoReadScope }
              : {}),
          }),
          requestId: `automation-plan-${claimedApproval.id}-${callNumber}`,
        };
        const approvalRequirement = await this.deps.approvalGate.inspect({
          toolId: invocation.toolId,
          action: invocation.action,
          args: invocation.args,
          perm: currentPermissionResult.value,
          runContext: currentRunContext,
        });
        if (approvalRequirement.kind === 'misconfigured') {
          await this.fail(claimedApproval.id, 'approval_misconfigured', approvalRequirement.message, {
            title: plan.title,
            completedCalls: index,
            totalCalls,
            results,
          });
          return;
        }
        const currentApprovalSignature = approvalSignatureFromRequirement(approvalRequirement);
        if (!approvalSignaturesEqual(currentInvocationSignatures[index]!, currentApprovalSignature)) {
          await this.fail(
            claimedApproval.id,
            'approval_changed',
            'The approval authority or governed connection policy changed after this batch was approved. Prepare a new batch for the current policy.',
            { title: plan.title, completedCalls: index, totalCalls, results },
          );
          return;
        }
        const runtimePreflight = await this.deps.toolExecutor.preflightForRuntime({
          toolId: invocation.toolId,
          args: invocation.args,
          runContext: currentRunContext,
          perm: currentPermissionResult.value,
          expectedAction: invocation.action,
        });
        if (runtimePreflight.status !== 'success') {
          await this.fail(
            claimedApproval.id,
            'preflight_failed',
            runtimePreflight.message
              ?? `The call ${invocation.toolId}.${invocation.action} is no longer ready to execute.`,
            {
              title: plan.title,
              completedCalls: index,
              totalCalls,
              failedCall: { index, toolId: invocation.toolId, action: invocation.action },
              results,
            },
          );
          return;
        }

        const outcome = await this.deps.toolExecutor.executeForRuntime({
          toolId: invocation.toolId,
          args: invocation.args,
          runContext: currentRunContext,
          perm: currentPermissionResult.value,
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
          await this.fail(claimedApproval.id, 'execution_failed', message, {
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
        recoveryContext = {
          title: plan.title,
          completedCalls: callNumber,
          totalCalls,
          results,
        };
        if (!await this.persistProgress(claimedApproval.id, {
          status: 'executing',
          title: plan.title,
          completedCalls: callNumber,
          totalCalls,
          current: `Completed ${invocation.toolId}.${invocation.action} (${callNumber}/${totalCalls}).`,
          results,
        })) {
          await this.fail(claimedApproval.id, 'checkpoint_failed', 'The action completed, but its durable checkpoint could not be stored. No further actions were executed.', {
            title: plan.title,
            completedCalls: callNumber,
            totalCalls,
            results,
          });
          return;
        }
      }

      const completed = await this.deps.approvalRepo.completeApprovedExecution(claimedApproval.id, {
        status: 'completed',
        title: plan.title,
        completedCalls: totalCalls,
        totalCalls,
        results,
      });
      if (!completed.ok || !completed.value) {
        await this.fail(
          claimedApproval.id,
          'completion_checkpoint_failed',
          'All approved actions completed, but Divo could not store the terminal batch checkpoint.',
          recoveryContext,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error('automation_plan.unexpected_failure', {
        planId: claimedApproval.id,
        error: message,
      });
      await this.fail(
        claimedApproval.id,
        'execution_exception',
        `The approved batch stopped after an unexpected execution error: ${message}`,
        recoveryContext,
      );
    }
  }

  private async persistProgress(planId: string, value: Record<string, unknown>): Promise<boolean> {
    const saved = await this.deps.approvalRepo.persistExecutingResult(planId, value);
    if (!saved.ok || !saved.value) {
      this.deps.logger.warn('automation_plan.progress_persist_failed', {
        planId,
        error: saved.ok ? 'approval_not_executing' : saved.error.message,
      });
      return false;
    }
    return true;
  }

  private resolvePermissions(
    identity: {
      companyId: string;
      userId: string;
      aiRole: string;
    },
    departmentId: string,
  ): ReturnType<PermissionService['resolve']> {
    return this.deps.permissions.resolve({
      companyId: asCompanyId(identity.companyId),
      userId: asUserId(identity.userId),
      companyRole: asCompanyRoleSlug(identity.aiRole),
      departmentId: asDepartmentId(departmentId),
      channel: 'desktop',
    });
  }

  private async resolveCurrentBatchSignature(
    expected: AutomationRequiredApprovalSignature,
    departmentId: string,
    companyId: string,
  ): Promise<AutomationApprovalSignature | null> {
    const approver = expected.authority === 'connection_owner'
      ? await this.deps.approvalResolver.resolveConnectionOwner(expected.connectionScope.connectionId, companyId)
      : expected.authority === 'company_admin'
        ? await this.deps.approvalResolver.resolveCompanyAdmin(companyId)
        : await this.deps.approvalResolver.resolveManager(departmentId, companyId);
    if (!approver) return null;
    return {
      ...expected,
      approverUserId: approver.userId,
    };
  }

  private buildRunContext(input: {
    identity: {
      companyId: string;
      userId: string;
      aiRole: string;
      email?: string | null;
      larkOpenId?: string | null;
    };
    departmentId: string;
    approvalId: string;
    execution?: GatewayExecutionContext;
    departmentZohoReadScope?: string | null;
    deliveryMode?: RunContext['deliveryMode'];
  }): RunContext {
    const {
      identity, departmentId, approvalId, execution, departmentZohoReadScope, deliveryMode,
    } = input;
    return {
      companyId: asCompanyId(identity.companyId),
      userId: asUserId(identity.userId),
      companyRole: asCompanyRoleSlug(identity.aiRole),
      departmentId: asDepartmentId(departmentId),
      channel: 'desktop',
      requesterAiRole: identity.aiRole,
      ...(identity.email ? { requesterEmail: identity.email } : {}),
      ...(identity.larkOpenId ? { userExternalId: identity.larkOpenId } : {}),
      ...(departmentZohoReadScope ? { departmentZohoReadScope } : {}),
      ...(deliveryMode ? { deliveryMode } : {}),
      traceId: `automation-plan-${approvalId}`,
      requestId: `automation-plan-${approvalId}-preflight`,
      ...(execution?.threadId ? { chatId: execution.threadId } : {}),
    };
  }

  private async fail(
    planId: string,
    status: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const terminalResult = { status, message, ...extra };
    const failed = await this.deps.approvalRepo.failApprovedExecution(planId, terminalResult);
    if (!failed.ok || !failed.value) {
      this.deps.logger.error('automation_plan.fail_persist_failed', {
        planId,
        error: failed.ok ? 'approval_not_executing' : failed.error.message,
      });
      // Keep the `executing` state as the exact-once barrier, but attach a
      // durable terminal checkpoint so status callers see that processing
      // stopped and retain every partial result needed for reconciliation.
      const checkpoint = await this.deps.approvalRepo.persistExecutingResult(planId, {
        ...terminalResult,
        intendedStatus: status,
        status: 'terminal_checkpoint_failed',
        outcomeUncertain: true,
        nextAction: 'inspect_destination',
        retry: 'do_not_retry',
      });
      if (!checkpoint.ok || !checkpoint.value) {
        this.deps.logger.error('automation_plan.terminal_checkpoint_failed', {
          planId,
          error: checkpoint.ok ? 'approval_not_executing' : checkpoint.error.message,
        });
      } else {
        this.deps.logger.warn('automation_plan.terminal_checkpointed', {
          planId,
          intendedStatus: status,
        });
      }
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
