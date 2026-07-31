import type { ApprovalResolverService } from '../approval/approval-resolver.service';
import type {
  ApprovalGateService,
  ApprovalAuthority,
  ApprovalRequirement,
} from '../approval/approval-gate.service';
import { buildAutomationPlanApprovalCard } from '../approval/approval-card-builder';
import type { PermissionService } from '../permissions/permission.service';
import { asCompanyId, asDepartmentId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import { sha256, sha256CanonicalJson } from '../../shared/hash';
import type { Logger } from '../../shared/logger';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import type { RuntimeApprovalRepository, RuntimeApprovalRow } from '../../infrastructure/persistence/runtime-approval.repository';
import type { GatewayExecutionContext, GatewayMemberContext, GatewayResponse } from './gateway.types';
import { gatewayFailure, gatewaySuccess } from './gateway.types';
import type { ToolExecutor, PreflightedToolInvocation } from './tool-executor';
import type { SkillCatalogService } from '../skills/skill-catalog.service';
import type { SkillAccessEnforcementPort } from '../skills/skill-access.port';
import { withWorkDiscoveryPermissions } from './work-resolution.service';
import { buildArgsSummary } from './args-summary';
import { SCHEDULED_SESSION_AUTH_PROVIDER } from '../scheduling/scheduled-runtime-session';
import { z } from 'zod';
import {
  approvalDeliveryFailedCheckpoint,
  approvalDeliveryUnknownCheckpoint,
  isDefiniteApprovalNonDelivery,
} from '../approval/approval-delivery';

const AUTOMATION_PLAN_KIND = 'automation_script_plan';
const AUTOMATION_PLAN_VERSION = 2;
const AUTOMATION_PLAN_TTL_MS = 24 * 60 * 60 * 1_000;
const PREFLIGHT_CONCURRENCY = 5;

const automationConnectionScopeSchema = z.object({
  connectionId: z.string().min(1),
  policySource: z.enum(['company_admin_override', 'manager_policy']),
});

export const automationRequiredApprovalSignatureSchema = z.discriminatedUnion('authority', [
  z.object({
    kind: z.literal('required'),
    authority: z.literal('connection_owner'),
    approverUserId: z.string().min(1),
    connectionScope: automationConnectionScopeSchema.extend({
      mode: z.literal('connection_owner'),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('required'),
    authority: z.literal('company_admin'),
    approverUserId: z.string().min(1),
    connectionScope: automationConnectionScopeSchema.extend({
      mode: z.literal('company_admin'),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('required'),
    authority: z.literal('department_manager'),
    approverUserId: z.string().min(1),
    connectionScope: z.null(),
  }).strict(),
]);

export const automationApprovalSignatureSchema = z.union([
  z.object({ kind: z.literal('allowed') }).strict(),
  automationRequiredApprovalSignatureSchema,
]);

export type AutomationApprovalSignature = z.infer<typeof automationApprovalSignatureSchema>;
export type AutomationRequiredApprovalSignature = z.infer<typeof automationRequiredApprovalSignatureSchema>;

export const automationPlanStoredInvocationSchema = z.object({
  skillId: z.string().min(1).optional(),
  toolId: z.string().min(1),
  action: z.enum(['create', 'update', 'delete', 'send', 'execute']),
  args: z.record(z.unknown()),
  argsHash: z.string().length(64),
  validation: z.record(z.unknown()),
  callSummary: z.string().min(1).max(1_000),
  approvalSignature: automationApprovalSignatureSchema,
}).strict().superRefine((invocation, context) => {
  const actualHash = sha256CanonicalJson(invocation.args);
  if (invocation.argsHash !== actualHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['argsHash'],
      message: 'Stored invocation arguments do not match their approved fingerprint.',
    });
  }
});

export const automationPlanStoredPayloadSchema = z.object({
  version: z.literal(AUTOMATION_PLAN_VERSION),
  title: z.string().min(1),
  summary: z.string().min(1),
  approvalSignature: automationRequiredApprovalSignatureSchema,
  invocations: z.array(automationPlanStoredInvocationSchema).min(1),
}).strict();

export type AutomationPlanStoredPayload = z.infer<typeof automationPlanStoredPayloadSchema>;

export interface AutomationPlanServiceDeps {
  readonly toolExecutor: ToolExecutor;
  readonly skillCatalog: SkillCatalogService;
  readonly skillAccessEnforcement: SkillAccessEnforcementPort;
  readonly permissions: PermissionService;
  readonly approvalRepo: RuntimeApprovalRepository;
  readonly approvalResolver: ApprovalResolverService;
  readonly approvalGate: ApprovalGateService;
  readonly larkAdapter: LarkChannelAdapter;
  readonly logger: Logger;
}

/**
 * Creates immutable, server-preflighted batches for a local automation
 * runtime. The local runtime may transform data, but it cannot execute a
 * mutation itself: every stored call is later revalidated and executed by the
 * backend only after the exact policy-selected human approves the batch in Lark.
 */
export class AutomationPlanService {
  constructor(private readonly deps: AutomationPlanServiceDeps) {}

  async create(input: {
    member: GatewayMemberContext;
    departmentId?: string;
    execution?: GatewayExecutionContext;
    title: string;
    summary: string;
    invocations: ReadonlyArray<{ skillId?: string | undefined; toolId: string; args: Record<string, unknown> }>;
  }): Promise<GatewayResponse> {
    const departmentId = input.departmentId;
    if (!departmentId) {
      return gatewayFailure(
        'approval_misconfigured',
        'Automation plans require an explicit department so a manager can approve the exact batch.',
      );
    }

    const permResult = await this.deps.permissions.resolve({
      companyId: asCompanyId(input.member.companyId),
      userId: asUserId(input.member.userId),
      companyRole: asCompanyRoleSlug(input.member.aiRole),
      departmentId: asDepartmentId(departmentId),
      channel: 'desktop',
    });
    if (!permResult.ok) {
      return gatewayFailure('permission_denied', permResult.error.message);
    }
    const grantedSkillIds = await this.deps.skillAccessEnforcement.listGrantedSkillIds(
      input.member.companyId,
      input.member.userId,
    );

    // A plan can contain 100 calls. Keep preflight parallel enough to feel
    // responsive, but bounded so one agent turn cannot overwhelm a connector
    // or its rate limit with an unbounded Promise.all burst.
    const preflighted = await mapWithConcurrency(input.invocations, PREFLIGHT_CONCURRENCY, async (invocation) => {
      if (invocation.skillId) {
        const matches = await this.deps.skillCatalog.authorizesTool({
          companyId: input.member.companyId,
          departmentId,
          permission: withWorkDiscoveryPermissions(permResult.value),
          grantedSkillIds,
          skillId: invocation.skillId,
          toolId: invocation.toolId,
        });
        if (!matches) {
          this.deps.logger.warn('automation_plan.skill_advisory_mismatch', {
            companyId: input.member.companyId,
            userId: input.member.userId,
            departmentId,
            skillId: invocation.skillId,
            toolId: invocation.toolId,
          });
        }
      }
      const response = await this.deps.toolExecutor.preflight({
        member: input.member,
        departmentId,
        toolId: invocation.toolId,
        args: invocation.args,
        ...(input.execution ? { execution: input.execution } : {}),
      });
      return { invocation, response };
    });

    const invalid = preflighted.find(({ response }) => !response.ok || !response.data);
    if (invalid) {
      return gatewayFailure(
        invalid.response.status,
        invalid.response.error?.message ?? `Could not preflight ${invalid.invocation.toolId}.`,
      );
    }

    const calls = preflighted.map(({ response }) => response.data as PreflightedToolInvocation);
    const read = calls.find((call) => call.action === 'read');
    if (read) {
      return gatewayFailure(
        'invalid_args',
        `Automation plans contain mutations only. Run the read-only ${read.toolId} call through tools.invoke before preparing the batch.`,
      );
    }

    const runContext = {
      companyId: asCompanyId(input.member.companyId),
      userId: asUserId(input.member.userId),
      companyRole: asCompanyRoleSlug(input.member.aiRole),
      departmentId: asDepartmentId(departmentId),
      channel: 'desktop' as const,
      requesterAiRole: input.member.aiRole,
      ...(input.member.email ? { requesterEmail: input.member.email } : {}),
      ...(input.member.larkOpenId ? { userExternalId: input.member.larkOpenId } : {}),
      ...(permResult.value.department?.zohoReadScope
        ? { departmentZohoReadScope: permResult.value.department.zohoReadScope }
        : {}),
      ...(input.execution ? {
        traceId: input.execution.runId,
        requestId: input.execution.actionId,
        chatId: input.execution.threadId,
      } : {}),
    };
    const requirements = await Promise.all(calls.map((call) => this.deps.approvalGate.inspect({
      toolId: call.toolId,
      action: call.action,
      args: call.args,
      perm: permResult.value,
      runContext,
    })));
    const invalidRequirement = requirements.find((requirement) => requirement.kind === 'misconfigured');
    if (invalidRequirement?.kind === 'misconfigured') {
      return gatewayFailure('approval_misconfigured', invalidRequirement.message);
    }
    const approvalSignatures = requirements.map(approvalSignatureFromRequirement);
    const requiredAuthorities = requirements.filter(isRequiredApproval);
    const distinctApprovalRoutes = new Map(requiredAuthorities.map((requirement) => {
      const signature = approvalSignatureFromRequirement(requirement);
      return [approvalSignatureKey(signature), requirement] as const;
    }));
    if (distinctApprovalRoutes.size > 1) {
      return gatewayFailure(
        'approval_misconfigured',
        'This batch uses different approval authorities or governed connections. Split it into one batch per exact approval route.',
      );
    }
    const selectedRequirement = distinctApprovalRoutes.values().next().value as typeof requiredAuthorities[number] | undefined;
    const defaultManager = selectedRequirement
      ? null
      : await this.deps.approvalResolver.resolveManager(departmentId, input.member.companyId);
    if (!selectedRequirement && !defaultManager) {
      return gatewayFailure(
        'approval_misconfigured',
        'This automation plan needs a department manager with a connected Lark account. Please contact your administrator.',
      );
    }
    const approver = selectedRequirement?.approver ?? defaultManager!;
    const approvalAuthority: ApprovalAuthority = selectedRequirement?.authority ?? 'department_manager';
    const batchApprovalSignature: AutomationRequiredApprovalSignature = selectedRequirement
      ? requiredApprovalSignature(selectedRequirement)
      : {
          kind: 'required',
          authority: 'department_manager',
          approverUserId: defaultManager!.userId,
          connectionScope: null,
        };

    const stored: AutomationPlanStoredPayload = {
      version: AUTOMATION_PLAN_VERSION,
      title: input.title,
      summary: input.summary,
      approvalSignature: batchApprovalSignature,
      invocations: calls.map((call, index) => ({
        ...(input.invocations[index]!.skillId
          ? { skillId: input.invocations[index]!.skillId }
          : {}),
        toolId: call.toolId,
        action: call.action as z.infer<typeof automationPlanStoredInvocationSchema>['action'],
        args: call.args,
        argsHash: sha256CanonicalJson(call.args),
        validation: call.validation,
        callSummary: buildArgsSummary(call.toolId, call.action, call.args),
        approvalSignature: approvalSignatures[index]!,
      })),
    };
    const planHash = computeAutomationPlanHash(stored);
    const idempotencyKey = sha256([
      'automation-plan',
      input.member.companyId,
      input.member.userId,
      departmentId,
      input.execution?.threadId ?? 'no-thread',
      input.execution?.runId ?? input.member.sessionId,
      planHash,
    ].join(':'));
    const actionCounts = countActions(stored);
    const create = await this.deps.approvalRepo.createOrReuseActive({
      // This is only a durable approval conversation key. It is intentionally
      // not a Lark chat ID: the approval card is delivered directly to the
      // manager, and there is no desktop bearer-token path to resume it.
      chatId: automationApprovalChatId(input.member, input.execution),
      companyId: input.member.companyId,
      toolId: 'automationScript',
      actionGroup: 'execute',
      kind: AUTOMATION_PLAN_KIND,
      summary: `${input.title}: ${input.summary}`,
      payloadJson: stored,
      metadataJson: {
        requesterId: input.member.userId,
        requesterLarkOpenId: input.member.larkOpenId,
        requesterEmail: input.member.email,
        requesterAiRole: input.member.aiRole,
        departmentId,
        execution: input.execution ?? null,
        approvalOrigin: 'automation',
        // Same reason as the single-tool approval path: this batch is approved
        // before any of it runs, so the delivery restriction of the run that
        // prepared it has to survive until someone accepts.
        deliveryMode: input.member.authProvider === SCHEDULED_SESSION_AUTH_PROVIDER
          ? 'scheduled_runtime_delivery'
          : null,
        resolvedManagerOpenId: approver.larkOpenId,
        resolvedManagerUserId: approver.userId,
        resolvedManagerName: approver.displayName,
        approvalAuthority,
        planHash,
        actionCounts,
      },
      channel: 'desktop',
      requestedBy: input.member.userId,
      idempotencyKey,
      expiresAt: new Date(Date.now() + AUTOMATION_PLAN_TTL_MS),
    });
    if (!create.ok) {
      this.deps.logger.error('automation_plan.create_or_reuse_failed', { error: create.error.message });
      return gatewayFailure('tool_error', 'Could not store the automation plan. Please try again.');
    }
    if (!create.value.created) {
      return gatewaySuccess(this.present(create.value.approval, {
        idempotent: true,
        requestState: create.value.approval.status === 'dispatching' ? 'dispatching' : 'reused',
      }));
    }
    const approval = create.value.approval;

    // No card address for the approver. The plan is stored and live; it waits
    // in their Divo approval inbox rather than failing for want of a Lark DM.
    if (!approver.larkOpenId) {
      this.deps.logger.info('automation_plan.created_inbox', {
        planId: approval.id,
        approver: approver.userId,
      });
      return gatewaySuccess(this.present(approval, { actionCounts, requestState: 'created' }));
    }

    const card = buildAutomationPlanApprovalCard({
      approvalId: approval.id,
      title: stored.title,
      summary: stored.summary,
      requesterName: input.member.email ?? input.member.userId,
      departmentName: permResult.value.department?.name ?? 'your department',
      actionCounts,
      invocationCount: stored.invocations.length,
      callPreview: stored.invocations.map((invocation) => invocation.callSummary),
    });
    const sent = await this.deps.larkAdapter.sendDirectCard(approver.larkOpenId, card);
    if (!sent.ok) {
      this.deps.logger.warn('automation_plan.card_send_failed', { planId: approval.id, error: sent.error.message });
      if (!isDefiniteApprovalNonDelivery(sent.error)) {
        const checkpoint = await this.deps.approvalRepo.persistResult(
          approval.id,
          approvalDeliveryUnknownCheckpoint(sent.error.message),
        );
        if (!checkpoint.ok) {
          this.deps.logger.error('automation_plan.delivery_unknown_checkpoint_failed', {
            planId: approval.id,
            error: checkpoint.error.message,
          });
        }
        return gatewayFailure(
          'approval_misconfigured',
          `Divo lost confirmation while delivering the ${approvalAuthority.replaceAll('_', ' ')} approval card. It may still be actionable, so this exact batch is blocked from automatic retry. Contact your administrator with plan ID ${approval.id}.`,
        );
      }
      const markFailed = await this.deps.approvalRepo.markFailed(
        approval.id,
        `card_send_failed:${sent.error.message}`,
      );
      if (!markFailed.ok) {
        this.deps.logger.error('automation_plan.mark_failed_failed', {
          planId: approval.id,
          error: markFailed.error.message,
        });
        const checkpoint = await this.deps.approvalRepo.persistResult(
          approval.id,
          approvalDeliveryFailedCheckpoint(sent.error.message),
        );
        if (!checkpoint.ok) {
          this.deps.logger.error('automation_plan.delivery_failure_checkpoint_failed', {
            planId: approval.id,
            error: checkpoint.error.message,
          });
        }
      }
      return gatewayFailure(
        'approval_misconfigured',
        `The batch was not approved because its ${approvalAuthority.replaceAll('_', ' ')} approval card could not be delivered. Nothing was executed.`,
      );
    }
    const delivered = await this.deps.approvalRepo.setDecisionMessageId(approval.id, sent.value.messageId);
    if (!delivered.ok) {
      this.deps.logger.error('automation_plan.delivery_persist_failed', {
        planId: approval.id,
        error: delivered.error.message,
      });
      // Sending succeeded. Keep the dispatching row as the exact-request
      // barrier: the card contains its approval ID and remains actionable,
      // while an exact retry must not deliver a duplicate card.
      return gatewaySuccess(this.present(approval, {
        actionCounts,
        requestState: 'dispatching',
      }));
    }

    this.deps.logger.info('automation_plan.created', {
      planId: approval.id,
      companyId: input.member.companyId,
      userId: input.member.userId,
      departmentId,
      actionCounts,
      approvalAuthority,
      approverUserId: approver.userId,
    });
    return gatewaySuccess(this.present(approval, {
      actionCounts,
      requestState: create.value.replacedExpired ? 'replaced_expired' : 'created',
    }));
  }

  async status(input: { member: GatewayMemberContext; planId: string }): Promise<GatewayResponse> {
    const found = await this.deps.approvalRepo.findById(input.planId);
    if (!found.ok) {
      return gatewayFailure('tool_error', 'Could not load the automation plan status. Please try again.');
    }
    if (!found.value || found.value.kind !== AUTOMATION_PLAN_KIND) {
      return gatewayFailure('automation_plan_not_found', 'Automation plan not found.');
    }
    if (found.value.requestedBy !== input.member.userId) {
      return gatewayFailure('permission_denied', 'You do not have access to this automation plan.');
    }
    return gatewaySuccess(this.present(found.value));
  }

  private present(row: RuntimeApprovalRow, extra?: {
    idempotent?: boolean;
    actionCounts?: Record<string, number>;
    requestState?: 'dispatching' | 'created' | 'reused' | 'replaced_expired';
  }) {
    const payload = automationPlanStoredPayloadSchema.safeParse(row.payloadJson);
    const meta = asRecord(row.metadataJson);
    const actionCounts = extra?.actionCounts
      ?? asNumberRecord(meta['actionCounts'])
      ?? (payload.success ? countActions(payload.data) : {});
    const result = asRecord(row.executionResultJson);
    return {
      planId: row.id,
      status: normalizePlanStatus(row.status, result),
      ...(payload.success ? {
        title: payload.data.title,
        summary: payload.data.summary,
        invocationCount: payload.data.invocations.length,
      } : {}),
      actionCounts,
      ...(asString(meta['approvalAuthority']) ? { approvalAuthority: asString(meta['approvalAuthority']) } : {}),
      ...(asString(meta['resolvedManagerName']) ? { approverName: asString(meta['resolvedManagerName']) } : {}),
      ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
      ...(extra?.idempotent ? { idempotent: true } : {}),
      ...(extra?.requestState ? { requestState: extra.requestState } : {}),
      ...(Object.keys(result).length > 0 ? { execution: result } : {}),
    };
  }
}

function automationApprovalChatId(
  member: GatewayMemberContext,
  execution: GatewayExecutionContext | undefined,
): string {
  if (!execution) return `automation:${member.sessionId}`;
  return [
    'automation',
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

export function isAutomationPlanApproval(row: RuntimeApprovalRow): boolean {
  return row.kind === AUTOMATION_PLAN_KIND;
}

export function parseAutomationPlanPayload(value: unknown): AutomationPlanStoredPayload | null {
  const parsed = automationPlanStoredPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function computeAutomationPlanHash(plan: AutomationPlanStoredPayload): string {
  return sha256CanonicalJson(plan);
}

export function approvalSignatureFromRequirement(
  requirement: ApprovalRequirement,
): AutomationApprovalSignature {
  if (requirement.kind === 'misconfigured') {
    throw new Error('Cannot bind a misconfigured approval requirement to an automation plan.');
  }
  if (requirement.kind === 'allowed') return { kind: 'allowed' };
  return requiredApprovalSignature(requirement);
}

function requiredApprovalSignature(
  requirement: Extract<ApprovalRequirement, { kind: 'required' }>,
): AutomationRequiredApprovalSignature {
  if (requirement.authority === 'department_manager') {
    return {
      kind: 'required',
      authority: 'department_manager',
      approverUserId: requirement.approver.userId,
      connectionScope: null,
    };
  }
  const scope = requirement.connectionScope;
  if (!scope || scope.mode !== requirement.authority) {
    throw new Error('Connection approval authority does not match its governed connection scope.');
  }
  if (requirement.authority === 'connection_owner') {
    return {
      kind: 'required',
      authority: 'connection_owner',
      approverUserId: requirement.approver.userId,
      connectionScope: {
        connectionId: scope.connectionId,
        mode: 'connection_owner',
        policySource: scope.policySource,
      },
    };
  }
  return {
    kind: 'required',
    authority: 'company_admin',
    approverUserId: requirement.approver.userId,
    connectionScope: {
      connectionId: scope.connectionId,
      mode: 'company_admin',
      policySource: scope.policySource,
    },
  };
}

export function approvalSignaturesEqual(
  expected: AutomationApprovalSignature,
  actual: AutomationApprovalSignature,
): boolean {
  if (expected.kind !== actual.kind) return false;
  if (expected.kind === 'allowed' || actual.kind === 'allowed') return true;
  return expected.authority === actual.authority
    && expected.approverUserId === actual.approverUserId
    && connectionScopesEqual(expected.connectionScope, actual.connectionScope);
}

function approvalSignatureKey(signature: AutomationApprovalSignature): string {
  return JSON.stringify(signature);
}

function connectionScopesEqual(
  expected: Extract<AutomationApprovalSignature, { kind: 'required' }>['connectionScope'],
  actual: Extract<AutomationApprovalSignature, { kind: 'required' }>['connectionScope'],
): boolean {
  if (expected === null || actual === null) return expected === actual;
  return expected.connectionId === actual.connectionId
    && expected.mode === actual.mode
    && expected.policySource === actual.policySource;
}

function isRequiredApproval(
  requirement: ApprovalRequirement,
): requirement is Extract<ApprovalRequirement, { kind: 'required' }> {
  return requirement.kind === 'required';
}

function countActions(plan: AutomationPlanStoredPayload): Record<string, number> {
  return plan.invocations.reduce<Record<string, number>>((counts, invocation) => {
    counts[invocation.action] = (counts[invocation.action] ?? 0) + 1;
    return counts;
  }, {});
}

function normalizePlanStatus(
  status: string,
  execution: Record<string, unknown>,
): 'approval_delivery_unknown' | 'delivering_approval_request' | 'waiting_for_manager_approval' | 'approved' | 'executing' | 'completed' | 'rejected' | 'failed' | 'expired' {
  switch (status) {
    case 'dispatching':
      return execution['status'] === 'approval_delivery_unknown'
        ? 'approval_delivery_unknown'
        : 'delivering_approval_request';
    case 'pending': return 'waiting_for_manager_approval';
    case 'approved': return 'approved';
    case 'executing':
      return execution['status'] === 'terminal_checkpoint_failed' ? 'failed' : 'executing';
    case 'consumed': return 'completed';
    case 'rejected': return 'rejected';
    case 'failed': return 'failed';
    default: return 'expired';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumberRecord(value: unknown): Record<string, number> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = asRecord(value);
  const entries = Object.entries(record).filter(([, count]) => typeof count === 'number');
  return entries.length === Object.keys(record).length
    ? Object.fromEntries(entries) as Record<string, number>
    : null;
}

async function mapWithConcurrency<T, U>(
  values: ReadonlyArray<T>,
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}
