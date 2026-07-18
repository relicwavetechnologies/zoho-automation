import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decideAutomaticPromotion,
  type PersonaPromotionCandidate,
} from '../../src/application/persona-learning/persona-learning-promotion.service';

function candidate(overrides: Partial<PersonaPromotionCandidate> = {}): PersonaPromotionCandidate {
  return {
    id: 'candidate-1',
    companyId: 'company-1',
    managerId: 'manager-1',
    departmentId: 'department-1',
    kind: 'preference',
    scopeKey: 'reporting.weekly',
    ruleKey: 'weekly-report.bullets',
    claim: 'Use bullet summaries in weekly reports.',
    rationale: 'The manager explicitly requested this report format.',
    evidenceStrength: 'explicit',
    evidence: { executionRunId: 'run-1', capturedAt: new Date('2026-07-18T00:00:00.000Z') },
    ...overrides,
  };
}

describe('automatic manager persona promotion gate', () => {
  it('promotes only two explicit observations from independent completed runs', () => {
    const result = decideAutomaticPromotion([
      candidate(),
      candidate({ id: 'candidate-2', evidence: { executionRunId: 'run-2', capturedAt: new Date('2026-07-19T00:00:00.000Z') } }),
    ]);

    assert.deepEqual(result, {
      promote: true,
      reason: 'independent_explicit_manager_evidence',
      supportCount: 2,
      confidence: 0.94,
    });
  });

  it('does not treat repeated extraction from one run as independent support', () => {
    const result = decideAutomaticPromotion([
      candidate(),
      candidate({ id: 'candidate-2' }),
    ]);

    assert.equal(result.promote, false);
    assert.equal(result.reason, 'insufficient_independent_explicit_evidence');
    assert.equal(result.supportCount, 1);
  });

  it('requires three explicit runs for general or procedural guidance', () => {
    const general = [
      candidate({ scopeKey: 'general', ruleKey: 'general.concise' }),
      candidate({ id: 'candidate-2', scopeKey: 'general', ruleKey: 'general.concise', evidence: { executionRunId: 'run-2', capturedAt: new Date() } }),
    ];
    assert.equal(decideAutomaticPromotion(general).promote, false);

    assert.equal(decideAutomaticPromotion([
      ...general,
      candidate({ id: 'candidate-3', scopeKey: 'general', ruleKey: 'general.concise', evidence: { executionRunId: 'run-3', capturedAt: new Date() } }),
    ]).promote, true);
  });

  it('never auto-promotes a contradiction or credential-like content', () => {
    assert.equal(decideAutomaticPromotion([
      candidate({ kind: 'contradiction' }),
      candidate({ id: 'candidate-2', kind: 'contradiction', evidence: { executionRunId: 'run-2', capturedAt: new Date() } }),
    ]).reason, 'contradiction_requires_resolution');

    assert.equal(decideAutomaticPromotion([
      candidate({ claim: 'Use api_key = sk-this-is-a-secret-value.' }),
      candidate({ id: 'candidate-2', claim: 'Use api_key = sk-this-is-a-secret-value.', evidence: { executionRunId: 'run-2', capturedAt: new Date() } }),
    ]).reason, 'credential_like_content');
  });
});
