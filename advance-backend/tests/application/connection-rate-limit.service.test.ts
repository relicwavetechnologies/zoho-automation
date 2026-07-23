import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionRateLimitService } from '../../src/application/governance/connection-rate-limit.service.ts';
import type { ConnectionGovernanceRepository } from '../../src/application/governance/connection-governance.repository.ts';
import type { RateLimitCheck, RateLimitStore, RateLimitWindow } from '../../src/application/governance/rate-limit.port.ts';
import { err, ok } from '../../src/shared/result.ts';
import type { InfraError } from '../../src/shared/errors.ts';

const fixedNow = new Date('2026-07-22T12:34:20.000Z');

function policy(action: Record<string, unknown>, actionName = 'read') {
  return { version: 1, actions: { [actionName]: action } };
}

class MemoryRateLimitStore implements RateLimitStore {
  private readonly counts = new Map<string, number>();

  async inspect(windows: readonly RateLimitWindow[]) {
    return ok(this.check(windows, false));
  }

  async consume(windows: readonly RateLimitWindow[]) {
    const check = this.check(windows, false);
    if (check.allowed) this.check(windows, true);
    return ok(check);
  }

  private check(windows: readonly RateLimitWindow[], increment: boolean): RateLimitCheck {
    const states = windows.map(window => {
      const used = this.counts.get(window.key) ?? 0;
      return { ...window, used, retryAfterSeconds: window.ttlSeconds };
    });
    const allowed = states.every(window => window.used < window.limit);
    if (increment && allowed) {
      for (const window of windows) this.counts.set(window.key, (this.counts.get(window.key) ?? 0) + 1);
    }
    return { allowed, windows: states };
  }
}

function service(input: { admin?: unknown; manager?: unknown } = {}) {
  const repository: ConnectionGovernanceRepository = {
    findConnectionGovernance: async () => ok({
      managerPolicyJson: input.manager ?? null,
      adminOverrideJson: input.admin ?? null,
    }),
  };
  return new ConnectionRateLimitService({
    repository,
    store: new MemoryRateLimitStore(),
    clock: { now: () => fixedNow, nowMs: () => fixedNow.getTime() },
  });
}

describe('ConnectionRateLimitService', () => {
  it('does not spend capacity during preflight and blocks the request after the configured budget is consumed', async () => {
    const limits = service({
      admin: policy({ mode: 'enforced', requestsPerMinute: 2, requestsPerDay: null, approval: 'none' }),
    });
    const input = { companyId: 'company-1', connectionId: 'connection-1', action: 'read' as const };

    assert.equal((await limits.preflight(input)).kind, 'allowed');
    assert.equal((await limits.preflight(input)).kind, 'allowed');
    assert.equal((await limits.consume(input)).kind, 'allowed');
    assert.equal((await limits.consume(input)).kind, 'allowed');

    const blocked = await limits.consume(input);
    assert.equal(blocked.kind, 'limited');
    if (blocked.kind === 'limited') {
      assert.match(blocked.message, /2-request rate limit/);
      assert.equal(blocked.policySource, 'company_admin_override');
    }
  });

  it('uses a manager policy only when the company override inherits the action', async () => {
    const limits = service({
      admin: policy({ mode: 'inherit' }),
      manager: policy({ mode: 'enforced', requestsPerMinute: 1, requestsPerDay: null, approval: 'none' }),
    });
    const input = { companyId: 'company-1', connectionId: 'connection-1', action: 'read' as const };

    const first = await limits.consume(input);
    assert.equal(first.kind, 'allowed');
    if (first.kind === 'allowed') assert.equal(first.policySource, 'manager_policy');
    assert.equal((await limits.consume(input)).kind, 'limited');
  });

  it('does not impose a connection policy when an invocation has no exact connection identity', async () => {
    const limits = service({
      admin: policy({ mode: 'enforced', requestsPerMinute: 1, requestsPerDay: null, approval: 'none' }),
    });
    assert.deepEqual(
      await limits.consume({ companyId: 'company-1', action: 'read' }),
      { kind: 'not_governed' },
    );
  });

  it('resolves a connection-owner approval requirement even when the action has no rate cap', async () => {
    const limits = service({
      manager: policy({ mode: 'enforced', requestsPerMinute: null, requestsPerDay: null, approval: 'connection_owner' }),
    });
    assert.deepEqual(
      await limits.approval({ companyId: 'company-1', connectionId: 'connection-1', action: 'read' }),
      { kind: 'required', policySource: 'manager_policy', mode: 'connection_owner' },
    );
    assert.equal(
      (await limits.consume({ companyId: 'company-1', connectionId: 'connection-1', action: 'read' })).kind,
      'not_governed',
    );
  });

  it('lets an explicit no-approval connection policy override only that action', async () => {
    const limits = service({
      admin: policy({ mode: 'enforced', requestsPerMinute: null, requestsPerDay: null, approval: 'none' }, 'send'),
    });
    const decision = await limits.approval({ companyId: 'company-1', connectionId: 'connection-1', action: 'send' });
    assert.deepEqual(decision, { kind: 'not_required', policySource: 'company_admin_override' });
  });

  it('fails closed when policy storage is unavailable instead of allowing a governed call through', async () => {
    const repository: ConnectionGovernanceRepository = {
      findConnectionGovernance: async () => err({} as InfraError),
    };
    const limits = new ConnectionRateLimitService({
      repository,
      store: new MemoryRateLimitStore(),
      clock: { now: () => fixedNow, nowMs: () => fixedNow.getTime() },
    });
    const decision = await limits.consume({ companyId: 'company-1', connectionId: 'connection-1', action: 'read' });
    assert.equal(decision.kind, 'unavailable');
  });
});
