import type { Clock } from '../../shared/clock';
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import {
  parseConnectionGovernancePolicy,
  type ConnectionGovernancePolicy,
  type ConnectionAction,
  type ConnectionApprovalMode,
} from './connection-governance.policy';
import type { ConnectionGovernanceRepository } from './connection-governance.repository';
import type { RateLimitCheck, RateLimitStore, RateLimitWindow } from './rate-limit.port';

export type ConnectionRateLimitDecision =
  | { readonly kind: 'not_governed' }
  | { readonly kind: 'allowed'; readonly policySource: 'company_admin_override' | 'manager_policy'; readonly check: RateLimitCheck }
  | { readonly kind: 'limited'; readonly policySource: 'company_admin_override' | 'manager_policy'; readonly check: RateLimitCheck; readonly message: string; readonly retryAfterSeconds: number }
  | { readonly kind: 'unavailable'; readonly message: string };

/**
 * Approval is resolved from the same effective action policy as rate limits.
 * A stored connection policy is deliberately authoritative for that
 * connection: it can require the owner/admin, or explicitly leave the action
 * ungated without changing broader RBAC.
 */
export type ConnectionApprovalDecision =
  | { readonly kind: 'not_governed' }
  | { readonly kind: 'not_required'; readonly policySource: 'company_admin_override' | 'manager_policy' }
  | { readonly kind: 'required'; readonly policySource: 'company_admin_override' | 'manager_policy'; readonly mode: Exclude<ConnectionApprovalMode, 'none'> }
  | { readonly kind: 'unavailable'; readonly message: string };

/**
 * Resolves stored operating policy and owns every rate-budget decision. RBAC
 * remains in PermissionService; a policy can only narrow an already-authorized
 * tool invocation.
 */
export class ConnectionRateLimitService {
  constructor(private readonly deps: {
    readonly repository: ConnectionGovernanceRepository;
    readonly store: RateLimitStore;
    readonly clock: Clock;
  }) {}

  async preflight(input: {
    readonly companyId: string;
    readonly connectionId?: string;
    readonly action: ToolActionGroup;
  }): Promise<ConnectionRateLimitDecision> {
    const resolved = await this.resolve(input);
    if (resolved.kind !== 'governed') return resolved;
    const checked = await this.deps.store.inspect(resolved.windows);
    if (!checked.ok) return { kind: 'unavailable', message: 'Divo could not verify the connection rate budget. Please retry; the request was not executed.' };
    return checked.value.allowed
      ? { kind: 'allowed', policySource: resolved.policySource, check: checked.value }
      : limitedDecision(resolved.policySource, checked.value);
  }

  async consume(input: {
    readonly companyId: string;
    readonly connectionId?: string;
    readonly action: ToolActionGroup;
  }): Promise<ConnectionRateLimitDecision> {
    const resolved = await this.resolve(input);
    if (resolved.kind !== 'governed') return resolved;
    const consumed = await this.deps.store.consume(resolved.windows);
    if (!consumed.ok) return { kind: 'unavailable', message: 'Divo could not reserve the connection rate budget. Please retry; the request was not executed.' };
    return consumed.value.allowed
      ? { kind: 'allowed', policySource: resolved.policySource, check: consumed.value }
      : limitedDecision(resolved.policySource, consumed.value);
  }

  async approval(input: {
    readonly companyId: string;
    readonly connectionId?: string;
    readonly action: ToolActionGroup;
  }): Promise<ConnectionApprovalDecision> {
    if (!input.connectionId) return { kind: 'not_governed' };
    const stored = await this.deps.repository.findConnectionGovernance({
      companyId: input.companyId,
      connectionId: input.connectionId,
    });
    if (!stored.ok) {
      return { kind: 'unavailable', message: 'Divo could not load the connection approval policy. Please retry; the request was not executed.' };
    }
    if (!stored.value) return { kind: 'not_governed' };
    const effective = effectiveAction(stored.value.adminOverrideJson, stored.value.managerPolicyJson, input.action);
    if (!effective) return { kind: 'not_governed' };
    return effective.policy.approval === 'none'
      ? { kind: 'not_required', policySource: effective.source }
      : { kind: 'required', policySource: effective.source, mode: effective.policy.approval! };
  }

  private async resolve(input: {
    readonly companyId: string;
    readonly connectionId?: string;
    readonly action: ToolActionGroup;
  }): Promise<
    | { readonly kind: 'not_governed' }
    | { readonly kind: 'unavailable'; readonly message: string }
    | { readonly kind: 'governed'; readonly policySource: 'company_admin_override' | 'manager_policy'; readonly windows: readonly RateLimitWindow[] }
  > {
    if (!input.connectionId) return { kind: 'not_governed' };
    const stored = await this.deps.repository.findConnectionGovernance({
      companyId: input.companyId,
      connectionId: input.connectionId,
    });
    if (!stored.ok) return { kind: 'unavailable', message: 'Divo could not load connection policy. Please retry; the request was not executed.' };
    if (!stored.value) return { kind: 'not_governed' };

    const effective = effectiveAction(stored.value.adminOverrideJson, stored.value.managerPolicyJson, input.action);
    if (!effective) return { kind: 'not_governed' };
    const windows = windowsFor(input.companyId, input.connectionId, input.action, effective.policy, this.deps.clock.now());
    return windows.length === 0
      ? { kind: 'not_governed' }
      : { kind: 'governed', policySource: effective.source, windows };
  }
}

function effectiveAction(
  adminOverrideJson: unknown | null,
  managerPolicyJson: unknown | null,
  action: ConnectionAction,
): { readonly source: 'company_admin_override' | 'manager_policy'; readonly policy: NonNullable<ConnectionGovernancePolicy['actions'][ConnectionAction]> } | null {
  const admin = adminOverrideJson ? parseConnectionGovernancePolicy(adminOverrideJson).actions[action] : undefined;
  if (admin?.mode === 'enforced') return { source: 'company_admin_override', policy: admin };
  const manager = managerPolicyJson ? parseConnectionGovernancePolicy(managerPolicyJson).actions[action] : undefined;
  if (manager?.mode === 'enforced') return { source: 'manager_policy', policy: manager };
  return null;
}

function windowsFor(
  companyId: string,
  connectionId: string,
  action: ConnectionAction,
  policy: NonNullable<ConnectionGovernancePolicy['actions'][ConnectionAction]>,
  now: Date,
): RateLimitWindow[] {
  const base = `governance:rate:v1:connection:${companyId}:${connectionId}:${action}`;
  const windows: RateLimitWindow[] = [];
  if (policy.requestsPerMinute) {
    const minute = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
    windows.push({
      key: `${base}:minute:${minute}`,
      limit: policy.requestsPerMinute,
      ttlSeconds: secondsUntilNextUtcMinute(now),
    });
  }
  if (policy.requestsPerDay) {
    const day = now.toISOString().slice(0, 10).replace(/-/g, '');
    windows.push({ key: `${base}:day:${day}`, limit: policy.requestsPerDay, ttlSeconds: secondsUntilUtcTomorrow(now) });
  }
  return windows;
}

function secondsUntilNextUtcMinute(now: Date): number {
  const nextMinute = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  return Math.max(1, Math.ceil((nextMinute - now.getTime()) / 1000));
}

function secondsUntilUtcTomorrow(now: Date): number {
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((tomorrow - now.getTime()) / 1000));
}

function blockedMessage(check: RateLimitCheck): string {
  const exceeded = exceededWindows(check)[0] ?? check.windows[0];
  if (!exceeded) return 'This connection is temporarily unavailable. Please retry shortly.';
  return `This connection has reached its ${exceeded.limit}-request rate limit. Try again in about ${retryAfterSeconds(check)} seconds.`;
}

function limitedDecision(
  policySource: 'company_admin_override' | 'manager_policy',
  check: RateLimitCheck,
): Extract<ConnectionRateLimitDecision, { kind: 'limited' }> {
  return {
    kind: 'limited',
    policySource,
    check,
    message: blockedMessage(check),
    retryAfterSeconds: retryAfterSeconds(check),
  };
}

function exceededWindows(check: RateLimitCheck): RateLimitCheck['windows'] {
  return check.windows.filter(window => window.used >= window.limit);
}

function retryAfterSeconds(check: RateLimitCheck): number {
  const blocked = exceededWindows(check);
  const windows = blocked.length > 0 ? blocked : check.windows;
  return Math.max(1, ...windows.map(window => window.retryAfterSeconds));
}
