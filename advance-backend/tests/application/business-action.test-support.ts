import { randomUUID } from 'node:crypto';
import type {
  CreateApprovalInput,
  RuntimeApprovalRow,
  RuntimeApprovalRepository,
} from '../../src/infrastructure/persistence/runtime-approval.repository.ts';
import { ok } from '../../src/shared/result.ts';

/** In-memory adapter at the durable approval seam; production uses Postgres. */
export class InMemoryBusinessActionApprovals {
  readonly rows = new Map<string, RuntimeApprovalRow>();

  asRepository(): RuntimeApprovalRepository {
    return this as unknown as RuntimeApprovalRepository;
  }

  async createOrReuseActive(input: CreateApprovalInput) {
    const existing = [...this.rows.values()].find(row =>
      row.idempotencyKey === input.idempotencyKey
      && !['rejected'].includes(row.status));
    if (existing) return ok({ approval: existing, created: false, replacedExpired: false });
    const now = new Date();
    const row: RuntimeApprovalRow = {
      id: randomUUID(),
      companyId: input.companyId,
      conversationId: randomUUID(),
      runId: randomUUID(),
      toolId: input.toolId,
      actionGroup: input.actionGroup,
      kind: input.kind,
      summary: input.summary,
      payloadJson: input.payloadJson,
      metadataJson: input.metadataJson,
      status: input.initialStatus ?? 'dispatching',
      channel: input.channel,
      requestedBy: input.requestedBy ?? null,
      approvedBy: null,
      approvedAt: null,
      rejectedAt: null,
      expiresAt: input.expiresAt,
      executionResultJson: null,
      idempotencyKey: input.idempotencyKey,
      decisionMessageId: null,
      resolutionReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return ok({ approval: row, created: true, replacedExpired: false });
  }

  async findById(id: string) {
    return ok(this.rows.get(id) ?? null);
  }

  async atomicResolve(id: string, decision: 'approved' | 'rejected', actor: string, reason?: string) {
    const row = this.rows.get(id);
    if (!row || !['pending', 'dispatching'].includes(row.status)) return ok(null);
    const now = new Date();
    const changed: RuntimeApprovalRow = {
      ...row,
      status: decision,
      approvedBy: actor,
      approvedAt: decision === 'approved' ? now : null,
      rejectedAt: decision === 'rejected' ? now : null,
      resolutionReason: reason ?? null,
      updatedAt: now,
    };
    this.rows.set(id, changed);
    return ok(changed);
  }

  async claimApprovedExecution(id: string, requestedBy: string) {
    const row = this.rows.get(id);
    if (!row || row.status !== 'approved' || row.requestedBy !== requestedBy) return ok(null);
    const changed = { ...row, status: 'executing', updatedAt: new Date() };
    this.rows.set(id, changed);
    return ok(changed);
  }

  async persistResult(id: string, result: unknown) {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, executionResultJson: result, updatedAt: new Date() });
    return ok(undefined);
  }

  async completeApprovedExecution(id: string, result: unknown) {
    return this.transition(id, ['approved', 'executing'], 'consumed', result);
  }

  async failApprovedExecution(id: string, result: unknown) {
    return this.transition(id, ['approved', 'executing'], 'failed', result);
  }

  async markAwaitingGovernance(id: string, result: unknown) {
    return this.transition(id, ['executing'], 'awaiting_governance', result);
  }

  async completeLinkedDecision(id: string, result: unknown) {
    return this.transition(id, ['awaiting_governance'], 'consumed', result);
  }

  async failLinkedDecision(id: string, status: 'rejected' | 'failed', result: unknown) {
    return this.transition(id, ['awaiting_governance'], status, result);
  }

  private async transition(id: string, from: readonly string[], status: string, result: unknown) {
    const row = this.rows.get(id);
    if (!row || !from.includes(row.status)) return ok(false);
    this.rows.set(id, { ...row, status, executionResultJson: result, updatedAt: new Date() });
    return ok(true);
  }
}
