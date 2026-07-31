import { randomUUID } from 'node:crypto';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { Clock } from '../../shared/clock';
import type { Logger } from '../../shared/logger';
import { computeArgsHash } from '../approval/approval-policy';
import type {
  GatewayExecutionContext,
  GatewayMemberContext,
  GatewayResponse,
} from './gateway.types';
import { gatewayFailure, gatewaySuccess } from './gateway.types';
import type { PreparedToolInvocation, ToolExecutor } from './tool-executor';
import { googleWorkspaceProductByToolId } from '../google/google-workspace-mcp-manifest';
import { AIRTABLE_PRODUCTS } from '../airtable/airtable-mcp-manifest';
import type { PermissionService } from '../permissions/permission.service';
import type { SkillCatalogService } from '../skills/skill-catalog.service';
import type { SkillAccessEnforcementPort } from '../skills/skill-access.port';
import { asCompanyId, asDepartmentId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import { withWorkDiscoveryPermissions } from './work-resolution.service';

const DEFAULT_INTENT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TOMBSTONE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_INTENTS = 10_000;
const DEFAULT_MAX_ACTIVE_PER_SESSION = 50;

export interface ApprovalPresentation {
  readonly kind: string;
  readonly provider: string;
  readonly title: string;
  readonly action: ToolActionGroup;
  readonly operation: string;
  readonly details: Record<string, unknown>;
}

interface StoredApprovalIntent {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly departmentId: string | null;
  readonly execution?: GatewayExecutionContext;
  readonly skillId?: string;
  readonly toolId: string;
  readonly action: ToolActionGroup;
  readonly args: Record<string, unknown>;
  readonly argsHash: string;
  readonly expiresAtMs: number;
  state: 'pending' | 'claimed' | 'consumed' | 'expired';
  claimToken?: string;
  terminalAtMs?: number;
}

type ClaimResult =
  | { readonly kind: 'claimed'; readonly intent: StoredApprovalIntent; readonly claimToken: string }
  | { readonly kind: 'not_found' | 'expired' | 'consumed' | 'busy' };

export interface InMemoryApprovalIntentRepositoryOptions {
  readonly tombstoneTtlMs?: number;
  readonly maxIntents?: number;
  readonly maxActivePerSession?: number;
}

/**
 * Process-local intent storage. All state transitions are synchronous, making claim/consume
 * atomic inside a Node process. Consumed and expired tombstones are retained briefly so a
 * replay receives a deterministic failure instead of being mistaken for an unknown ID.
 */
export class InMemoryApprovalIntentRepository {
  private readonly intents = new Map<string, StoredApprovalIntent>();
  private readonly tombstoneTtlMs: number;
  private readonly maxIntents: number;
  private readonly maxActivePerSession: number;

  constructor(options: InMemoryApprovalIntentRepositoryOptions = {}) {
    this.tombstoneTtlMs = options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
    this.maxIntents = options.maxIntents ?? DEFAULT_MAX_INTENTS;
    this.maxActivePerSession = options.maxActivePerSession ?? DEFAULT_MAX_ACTIVE_PER_SESSION;
  }

  create(intent: StoredApprovalIntent, nowMs: number): boolean {
    this.sweep(nowMs);
    if (this.intents.size >= this.maxIntents) return false;

    let activeForSession = 0;
    for (const existing of this.intents.values()) {
      if (
        existing.sessionId === intent.sessionId
        && existing.companyId === intent.companyId
        && existing.userId === intent.userId
        && (existing.state === 'pending' || existing.state === 'claimed')
      ) {
        activeForSession++;
      }
    }
    if (activeForSession >= this.maxActivePerSession) return false;

    this.intents.set(intent.id, intent);
    return true;
  }

  claim(
    intentId: string,
    member: GatewayMemberContext,
    departmentId: string | undefined,
    execution: GatewayExecutionContext | undefined,
    nowMs: number,
  ): ClaimResult {
    this.sweep(nowMs);
    const intent = this.intents.get(intentId);
    if (!intent || !ownedBy(intent, member, departmentId, execution)) return { kind: 'not_found' };

    if (intent.state === 'consumed') return { kind: 'consumed' };
    if (intent.state === 'expired' || nowMs >= intent.expiresAtMs) {
      intent.state = 'expired';
      intent.terminalAtMs = nowMs;
      delete intent.claimToken;
      return { kind: 'expired' };
    }
    if (intent.state === 'claimed') return { kind: 'busy' };

    const claimToken = randomUUID();
    intent.state = 'claimed';
    intent.claimToken = claimToken;
    return { kind: 'claimed', intent, claimToken };
  }

  release(intentId: string, claimToken: string): void {
    const intent = this.intents.get(intentId);
    if (!intent || intent.state !== 'claimed' || intent.claimToken !== claimToken) return;
    intent.state = 'pending';
    delete intent.claimToken;
  }

  consume(intentId: string, claimToken: string, nowMs: number): void {
    const intent = this.intents.get(intentId);
    if (!intent || intent.state !== 'claimed' || intent.claimToken !== claimToken) return;
    intent.state = 'consumed';
    intent.terminalAtMs = nowMs;
    delete intent.claimToken;
  }

  private sweep(nowMs: number): void {
    for (const [id, intent] of this.intents) {
      if ((intent.state === 'pending' || intent.state === 'claimed') && nowMs >= intent.expiresAtMs) {
        intent.state = 'expired';
        intent.terminalAtMs = nowMs;
        delete intent.claimToken;
      }
      if (
        (intent.state === 'expired' || intent.state === 'consumed')
        && intent.terminalAtMs !== undefined
        && nowMs - intent.terminalAtMs >= this.tombstoneTtlMs
      ) {
        this.intents.delete(id);
      }
    }
  }
}

function ownedBy(
  intent: StoredApprovalIntent,
  member: GatewayMemberContext,
  departmentId: string | undefined,
  execution: GatewayExecutionContext | undefined,
): boolean {
  return intent.companyId === member.companyId
    && intent.userId === member.userId
    && intent.sessionId === member.sessionId
    && intent.departmentId === (departmentId ?? null)
    && executionMatches(intent.execution, execution);
}

function executionMatches(
  stored: GatewayExecutionContext | undefined,
  requested: GatewayExecutionContext | undefined,
): boolean {
  if (!stored || !requested) return stored === requested;
  return stored.version === requested.version
    && stored.threadId === requested.threadId
    && stored.runId === requested.runId
    && stored.actionId === requested.actionId;
}

export interface LocalApprovalIntentServiceDeps {
  readonly toolExecutor: ToolExecutor;
  readonly permissions: PermissionService;
  readonly skillCatalog: SkillCatalogService;
  readonly skillAccessEnforcement: SkillAccessEnforcementPort;
  readonly repository: InMemoryApprovalIntentRepository;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly intentTtlMs?: number;
}

export class LocalApprovalIntentService {
  private readonly intentTtlMs: number;

  constructor(private readonly deps: LocalApprovalIntentServiceDeps) {
    this.intentTtlMs = deps.intentTtlMs ?? DEFAULT_INTENT_TTL_MS;
  }

  async prepare(input: {
    readonly member: GatewayMemberContext;
    readonly departmentId?: string;
    readonly skillId?: string;
    readonly toolId: string;
    readonly args: Record<string, unknown>;
    readonly execution?: GatewayExecutionContext;
  }): Promise<GatewayResponse> {
    const prepared = await this.deps.toolExecutor.prepare(input);
    if (!prepared.ok || !prepared.data) return prepared;

    return this.createIntentForPreparedInvocation(input, prepared.data);
  }

  /**
   * Create a locally approvable intent from an invocation the gateway has just
   * validated and authorized. This avoids performing the same classification a
   * second time in one request. Commit still revalidates RBAC, args, and action
   * immediately before execution.
   */
  async createIntentForPreparedInvocation(
    input: {
      readonly member: GatewayMemberContext;
      readonly departmentId?: string;
      readonly skillId?: string;
      readonly toolId: string;
      readonly args: Record<string, unknown>;
      readonly execution?: GatewayExecutionContext;
    },
    prepared: PreparedToolInvocation,
  ): Promise<GatewayResponse> {
    if (prepared.toolId !== input.toolId) {
      return gatewayFailure('invalid_args', 'Prepared tool identity does not match the requested tool.');
    }

    const { action, args, toolId } = prepared;
    const argsHash = computeArgsHash(args);
    const presentation = buildApprovalPresentation(toolId, action, args);

    if (action === 'read') {
      return gatewaySuccess({
        action,
        requiresApproval: false,
        kind: presentation.kind,
        title: presentation.title,
        presentation,
        argsHash,
      });
    }

    const nowMs = this.deps.clock.nowMs();
    const expiresAtMs = nowMs + this.intentTtlMs;
    const intentId = randomUUID();
    const storedArgs = cloneJsonRecord(args);
    const created = this.deps.repository.create({
      id: intentId,
      companyId: input.member.companyId,
      userId: input.member.userId,
      sessionId: input.member.sessionId,
      departmentId: input.departmentId ?? null,
      ...(input.execution ? { execution: input.execution } : {}),
      ...(input.skillId ? { skillId: input.skillId } : {}),
      toolId,
      action,
      args: storedArgs,
      argsHash,
      expiresAtMs,
      state: 'pending',
    }, nowMs);

    if (!created) {
      return gatewayFailure('tool_error', 'Too many pending local approvals. Resolve or wait for existing approvals to expire.');
    }

    const expiresAt = new Date(expiresAtMs).toISOString();
    this.deps.logger.info('gateway.local_approval.prepared', {
      intentId,
      toolId,
      action,
      userId: input.member.userId,
      companyId: input.member.companyId,
      departmentId: input.departmentId ?? null,
      threadId: input.execution?.threadId ?? null,
      runId: input.execution?.runId ?? null,
      actionId: input.execution?.actionId ?? null,
      expiresAt,
    });

    return gatewaySuccess({
      action,
      requiresApproval: true,
      intentId,
      kind: presentation.kind,
      title: presentation.title,
      presentation,
      argsHash,
      expiresAt,
    });
  }

  async commit(input: {
    readonly member: GatewayMemberContext;
    readonly departmentId?: string;
    readonly intentId: string;
    readonly execution?: GatewayExecutionContext;
  }): Promise<GatewayResponse> {
    const nowMs = this.deps.clock.nowMs();
    const claimed = this.deps.repository.claim(
      input.intentId,
      input.member,
      input.departmentId,
      input.execution,
      nowMs,
    );

    if (claimed.kind === 'not_found') {
      return gatewayFailure('approval_intent_not_found', 'Approval intent was not found for this session and department.');
    }
    if (claimed.kind === 'expired') {
      return gatewayFailure('approval_intent_expired', 'Approval intent has expired. Prepare the action again.');
    }
    if (claimed.kind === 'consumed') {
      return gatewayFailure('approval_intent_consumed', 'Approval intent has already been used.');
    }
    if (claimed.kind === 'busy') {
      return gatewayFailure('approval_intent_busy', 'Approval intent is already being committed.');
    }
    if (claimed.kind !== 'claimed') {
      return gatewayFailure('tool_error', 'Approval intent could not be claimed.');
    }
    if (computeArgsHash(claimed.intent.args) !== claimed.intent.argsHash) {
      this.deps.repository.consume(input.intentId, claimed.claimToken, this.deps.clock.nowMs());
      this.deps.logger.error('gateway.local_approval.integrity_mismatch', {
        intentId: input.intentId,
        toolId: claimed.intent.toolId,
      });
      return gatewayFailure('invalid_args', 'Prepared approval payload failed its integrity check. Prepare the action again.');
    }
    const permission = await this.deps.permissions.resolve({
      companyId: asCompanyId(input.member.companyId),
      userId: asUserId(input.member.userId),
      companyRole: asCompanyRoleSlug(input.member.aiRole),
      ...(claimed.intent.departmentId
        ? { departmentId: asDepartmentId(claimed.intent.departmentId) }
        : {}),
      channel: 'desktop',
    });
    if (!permission.ok) {
      this.deps.repository.consume(input.intentId, claimed.claimToken, this.deps.clock.nowMs());
      return gatewayFailure('permission_denied', permission.error.message);
    }
    if (claimed.intent.skillId) {
      const grantedSkillIds = await this.deps.skillAccessEnforcement.listGrantedSkillIds(
        input.member.companyId,
        input.member.userId,
      );
      const matches = await this.deps.skillCatalog.authorizesTool({
        companyId: input.member.companyId,
        ...(claimed.intent.departmentId ? { departmentId: claimed.intent.departmentId } : {}),
        permission: withWorkDiscoveryPermissions(permission.value),
        grantedSkillIds,
        skillId: claimed.intent.skillId,
        toolId: claimed.intent.toolId,
      });
      if (!matches) {
        this.deps.logger.warn('gateway.local_approval.skill_advisory_mismatch', {
          intentId: claimed.intent.id,
          skillId: claimed.intent.skillId,
          toolId: claimed.intent.toolId,
        });
      }
    }

    const result = await this.deps.toolExecutor.invoke({
      member: input.member,
      ...(claimed.intent.departmentId ? { departmentId: claimed.intent.departmentId } : {}),
      toolId: claimed.intent.toolId,
      args: cloneJsonRecord(claimed.intent.args),
      expectedAction: claimed.intent.action,
      ...(claimed.intent.execution ? { execution: claimed.intent.execution } : {}),
    });

    // Manager approval can be asynchronous. In that one case the locally-approved exact
    // action remains retryable until its short TTL; all actual execution attempts are terminal.
    if (result.status === 'approval_required') {
      this.deps.repository.release(input.intentId, claimed.claimToken);
    } else {
      this.deps.repository.consume(input.intentId, claimed.claimToken, this.deps.clock.nowMs());
    }

    this.deps.logger.info('gateway.local_approval.committed', {
      intentId: input.intentId,
      toolId: claimed.intent.toolId,
      action: claimed.intent.action,
      status: result.status,
      consumed: result.status !== 'approval_required',
      threadId: claimed.intent.execution?.threadId ?? null,
      runId: claimed.intent.execution?.runId ?? null,
      actionId: claimed.intent.execution?.actionId ?? null,
    });
    return result;
  }
}

function buildApprovalPresentation(
  toolId: string,
  action: ToolActionGroup,
  args: Record<string, unknown>,
): ApprovalPresentation {
  const googleProduct = googleWorkspaceProductByToolId(toolId);
  const operation = googleProduct && typeof args['nativeTool'] === 'string'
    ? args['nativeTool']
    : typeof args['op'] === 'string'
    ? args['op']
    : typeof args['operation'] === 'string'
      ? args['operation']
      : action;

  if (googleProduct) {
    return {
      kind: `google.${googleProduct.service}.${operation}`,
      provider: 'google',
      title: googleApprovalTitle(googleProduct.service, googleProduct.name, operation, action),
      action,
      operation,
      details: pickDefined(args, ['connectionId', 'nativeTool', 'input']),
    };
  }

  const airtableProduct = AIRTABLE_PRODUCTS.find(product => product.toolId === toolId);
  if (airtableProduct) {
    const nativeTool = typeof args['nativeTool'] === 'string' ? args['nativeTool'] : operation;
    return {
      kind: `airtable.${airtableProduct.service}.${nativeTool}`,
      provider: 'airtable',
      title: `Review Airtable ${humanize(nativeTool)}`,
      action,
      operation: nativeTool,
      details: pickDefined(args, ['connectionId', 'nativeTool', 'input']),
    };
  }

  if (toolId === 'zohoCrm') {
    return {
      kind: `zoho.crm.${operation}`,
      provider: 'zoho',
      title: `Review Zoho CRM ${humanize(operation)}`,
      action,
      operation,
      details: pickDefined(args, ['connectionId', 'module', 'recordId', 'fields']),
    };
  }

  if (toolId === 'zohoBooks') {
    return {
      kind: `zoho.books.${operation}`,
      provider: 'zoho',
      title: `Review Zoho Books ${humanize(operation)}`,
      action,
      operation,
      details: cloneJsonRecord(args),
    };
  }

  return {
    kind: `generic.${toolId}.${operation}`,
    provider: 'generic',
    title: `Review ${humanize(toolId)} ${humanize(operation)}`,
    action,
    operation,
    details: cloneJsonRecord(args),
  };
}

function humanize(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').toLowerCase();
}

function googleApprovalTitle(
  service: string,
  productName: string,
  operation: string,
  action: ToolActionGroup,
): string {
  if (service === 'gmail' && action === 'send') return 'Review email before sending';
  return `Review ${productName} ${humanize(operation)}`;
}

function pickDefined(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) selected[key] = cloneJsonValue(source[key]);
  }
  return selected;
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function cloneJsonValue(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
