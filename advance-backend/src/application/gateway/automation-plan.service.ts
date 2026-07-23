import type { ApprovalResolverService } from '../approval/approval-resolver.service';
import { buildAutomationPlanApprovalCard } from '../approval/approval-card-builder';
import type { PermissionService } from '../permissions/permission.service';
import { asCompanyId, asDepartmentId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import { sha256 } from '../../shared/hash';
import type { Logger } from '../../shared/logger';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import type { RuntimeApprovalRepository, RuntimeApprovalRow } from '../../infrastructure/persistence/runtime-approval.repository';
import type { GatewayExecutionContext, GatewayMemberContext, GatewayResponse } from './gateway.types';
import { gatewayFailure, gatewaySuccess } from './gateway.types';
import type { ToolExecutor, PreflightedToolInvocation } from './tool-executor';
import { buildArgsSummary } from '../orchestration/tools/ai-sdk-adapter';
import { z } from 'zod';

const AUTOMATION_PLAN_KIND = 'automation_script_plan';
const AUTOMATION_PLAN_VERSION = 1;
const AUTOMATION_PLAN_TTL_MS = 24 * 60 * 60 * 1_000;
const PREFLIGHT_CONCURRENCY = 5;

export const automationPlanStoredInvocationSchema = z.object({
  toolId: z.string().min(1),
  action: z.enum(['create', 'update', 'delete', 'send', 'execute']),
  args: z.record(z.unknown()),
  argsHash: z.string().length(64),
  validation: z.record(z.unknown()),
  callSummary: z.string().min(1).max(1_000),
}).strict();

export const automationPlanStoredPayloadSchema = z.object({
  version: z.literal(AUTOMATION_PLAN_VERSION),
  title: z.string().min(1),
  summary: z.string().min(1),
  invocations: z.array(automationPlanStoredInvocationSchema).min(1),
}).strict();

export type AutomationPlanStoredPayload = z.infer<typeof automationPlanStoredPayloadSchema>;

export interface AutomationPlanServiceDeps {
  readonly toolExecutor: ToolExecutor;
  readonly permissions: PermissionService;
  readonly approvalRepo: RuntimeApprovalRepository;
  readonly approvalResolver: ApprovalResolverService;
  readonly larkAdapter: LarkChannelAdapter;
  readonly logger: Logger;
}

/**
 * Creates immutable, server-preflighted batches for a local automation
 * runtime. The local runtime may transform data, but it cannot execute a
 * mutation itself: every stored call is later revalidated and executed by the
 * backend only after the department manager approves the exact batch in Lark.
 */
export class AutomationPlanService {
  constructor(private readonly deps: AutomationPlanServiceDeps) {}

  async create(input: {
    member: GatewayMemberContext;
    departmentId?: string;
    execution?: GatewayExecutionContext;
    title: string;
    summary: string;
    invocations: ReadonlyArray<{ toolId: string; args: Record<string, unknown> }>;
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

    // A plan can contain 100 calls. Keep preflight parallel enough to feel
    // responsive, but bounded so one agent turn cannot overwhelm a connector
    // or its rate limit with an unbounded Promise.all burst.
    const preflighted = await mapWithConcurrency(input.invocations, PREFLIGHT_CONCURRENCY, async (invocation) => {
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

    const manager = await this.deps.approvalResolver.resolveManager(departmentId, input.member.companyId);
    if (!manager) {
      return gatewayFailure(
        'approval_misconfigured',
        'This automation plan needs a department manager with a connected Lark account. Please contact your administrator.',
      );
    }

    const stored: AutomationPlanStoredPayload = {
      version: AUTOMATION_PLAN_VERSION,
      title: input.title,
      summary: input.summary,
      invocations: calls.map((call) => ({
        toolId: call.toolId,
        action: call.action as z.infer<typeof automationPlanStoredInvocationSchema>['action'],
        args: call.args,
        argsHash: sha256(JSON.stringify(call.args)),
        validation: call.validation,
        callSummary: buildArgsSummary(call.toolId, call.action, call.args),
      })),
    };
    const planHash = sha256(JSON.stringify(stored));
    const idempotencyKey = sha256([
      'automation-plan',
      input.member.companyId,
      input.member.userId,
      departmentId,
      input.execution?.threadId ?? 'no-thread',
      planHash,
    ].join(':'));
    const existing = await this.deps.approvalRepo.findActiveByIdempotencyKey(idempotencyKey);
    if (!existing.ok) {
      this.deps.logger.error('automation_plan.idempotency_lookup_failed', { error: existing.error.message });
      return gatewayFailure('tool_error', 'Could not check an existing automation plan. Please try again.');
    }
    if (existing.value) {
      return gatewaySuccess(this.present(existing.value, { idempotent: true }));
    }

    const actionCounts = countActions(stored);
    const create = await this.deps.approvalRepo.create({
      // This is only a durable approval conversation key. It is intentionally
      // not a Lark chat ID: the approval card is delivered directly to the
      // manager, and there is no desktop bearer-token path to resume it.
      chatId: `automation:${input.member.sessionId}:${input.execution?.threadId ?? 'no-thread'}`,
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
        resolvedManagerOpenId: manager.larkOpenId,
        resolvedManagerUserId: manager.userId,
        resolvedManagerName: manager.displayName,
        planHash,
        actionCounts,
      },
      channel: 'desktop',
      requestedBy: input.member.userId,
      idempotencyKey,
      expiresAt: new Date(Date.now() + AUTOMATION_PLAN_TTL_MS),
    });
    if (!create.ok) {
      this.deps.logger.error('automation_plan.create_failed', { error: create.error.message });
      return gatewayFailure('tool_error', 'Could not store the automation plan. Please try again.');
    }

    const card = buildAutomationPlanApprovalCard({
      approvalId: create.value.id,
      title: stored.title,
      summary: stored.summary,
      requesterName: input.member.email ?? input.member.userId,
      departmentName: permResult.value.department?.name ?? 'your department',
      actionCounts,
      invocationCount: stored.invocations.length,
      callPreview: stored.invocations.map((invocation) => invocation.callSummary),
    });
    const sent = await this.deps.larkAdapter.sendDirectCard(manager.larkOpenId, card);
    if (!sent.ok) {
      await this.deps.approvalRepo.markFailed(create.value.id, `card_send_failed:${sent.error.message}`);
      this.deps.logger.warn('automation_plan.card_send_failed', { planId: create.value.id, error: sent.error.message });
      return gatewayFailure(
        'approval_misconfigured',
        'The batch was not approved because the manager approval card could not be delivered. Nothing was executed.',
      );
    }
    await this.deps.approvalRepo.setDecisionMessageId(create.value.id, sent.value.messageId);

    this.deps.logger.info('automation_plan.created', {
      planId: create.value.id,
      companyId: input.member.companyId,
      userId: input.member.userId,
      departmentId,
      actionCounts,
    });
    return gatewaySuccess(this.present(create.value, { actionCounts }));
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

  private present(row: RuntimeApprovalRow, extra?: { idempotent?: boolean; actionCounts?: Record<string, number> }) {
    const payload = automationPlanStoredPayloadSchema.safeParse(row.payloadJson);
    const meta = asRecord(row.metadataJson);
    const actionCounts = extra?.actionCounts
      ?? asNumberRecord(meta['actionCounts'])
      ?? (payload.success ? countActions(payload.data) : {});
    const result = asRecord(row.executionResultJson);
    return {
      planId: row.id,
      status: normalizePlanStatus(row.status),
      ...(payload.success ? {
        title: payload.data.title,
        summary: payload.data.summary,
        invocationCount: payload.data.invocations.length,
      } : {}),
      actionCounts,
      ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
      ...(extra?.idempotent ? { idempotent: true } : {}),
      ...(Object.keys(result).length > 0 ? { execution: result } : {}),
    };
  }
}

export function isAutomationPlanApproval(row: RuntimeApprovalRow): boolean {
  return row.kind === AUTOMATION_PLAN_KIND;
}

export function parseAutomationPlanPayload(value: unknown): AutomationPlanStoredPayload | null {
  const parsed = automationPlanStoredPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function countActions(plan: AutomationPlanStoredPayload): Record<string, number> {
  return plan.invocations.reduce<Record<string, number>>((counts, invocation) => {
    counts[invocation.action] = (counts[invocation.action] ?? 0) + 1;
    return counts;
  }, {});
}

function normalizePlanStatus(status: string): 'waiting_for_manager_approval' | 'approved' | 'executing' | 'completed' | 'rejected' | 'failed' | 'expired' {
  switch (status) {
    case 'pending': return 'waiting_for_manager_approval';
    case 'approved': return 'approved';
    case 'executing': return 'executing';
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
