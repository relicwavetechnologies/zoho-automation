import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  initialRemindAt,
  reconcileAnalysis,
} from '../../src/application/follow-ups/follow-up-reconcile.ts';
import type { AnalyzedFollowUp, FollowUpAnalysis } from '../../src/domain/follow-ups/follow-up.ts';

const NOW = new Date('2026-08-25T10:00:00Z');

const item = (over: Partial<AnalyzedFollowUp> = {}): AnalyzedFollowUp => ({
  id: null,
  title: 'Send Priya the Q3 invoice',
  detail: 'Promised on Tuesday.',
  kind: 'commitment',
  owner: 'us',
  counterparty: 'Priya',
  dueDate: null,
  urgency: 'medium',
  confidence: 0.8,
  evidence: ['I will send it tomorrow'],
  suggestedReply: '',
  ...over,
});

const analysis = (over: Partial<FollowUpAnalysis> = {}): FollowUpAnalysis => ({
  openItems: [], resolved: [], ...over,
});

describe('reconcileAnalysis', () => {
  it('creates newly spotted items and updates tracked ones', () => {
    const plan = reconcileAnalysis(
      analysis({ openItems: [item(), item({ id: 'f-1', title: 'Chase the venue' })] }),
      new Set(['f-1']),
      { confidenceFloor: 0.55, now: NOW },
    );

    assert.equal(plan.create.length, 1);
    assert.equal(plan.update.length, 1);
    assert.equal(plan.update[0]!.id, 'f-1');
  });

  it('drops items below the confidence floor and counts them', () => {
    const plan = reconcileAnalysis(
      analysis({ openItems: [item({ confidence: 0.4 }), item({ confidence: 0.9 })] }),
      new Set(),
      { confidenceFloor: 0.55, now: NOW },
    );
    assert.equal(plan.create.length, 1);
    assert.equal(plan.droppedForConfidence, 1);
  });

  it('leaves a tracked item alone when the model says nothing about it', () => {
    // Silence means "the new messages did not mention it", which is not the
    // same as done. This is the difference between a tracker and a shredder.
    const plan = reconcileAnalysis(analysis(), new Set(['f-1', 'f-2']), {
      confidenceFloor: 0.55, now: NOW,
    });
    assert.deepEqual(plan.create, []);
    assert.deepEqual(plan.update, []);
    assert.deepEqual(plan.resolve, []);
  });

  it('refuses to write to an id it was never given', () => {
    // A hallucinated or cross-chat id must not overwrite somebody else's row.
    const plan = reconcileAnalysis(
      analysis({ openItems: [item({ id: 'not-ours' })] }),
      new Set(['f-1']),
      { confidenceFloor: 0.55, now: NOW },
    );
    assert.equal(plan.update.length, 0);
    assert.equal(plan.create.length, 1, 'treated as new instead');
    assert.deepEqual(plan.unknownIds, ['not-ours']);
  });

  it('ignores a resolution for an id it never handed over', () => {
    const plan = reconcileAnalysis(
      analysis({ resolved: [{ id: 'f-1', reason: 'sent' }, { id: 'ghost', reason: 'made up' }] }),
      new Set(['f-1']),
      { confidenceFloor: 0.55, now: NOW },
    );
    assert.deepEqual(plan.resolve, [{ id: 'f-1', reason: 'sent' }]);
    assert.deepEqual(plan.unknownIds, ['ghost']);
  });
});

describe('initialRemindAt', () => {
  it('nudges the morning before a stated deadline', () => {
    const when = initialRemindAt(item({ dueDate: '2026-08-28' }), NOW);
    assert.equal(when.toISOString(), '2026-08-27T09:00:00.000Z');
  });

  it('never arms a reminder in the past for an already-passed deadline', () => {
    // Otherwise discovering an overdue item fires a notification instantly.
    const when = initialRemindAt(item({ dueDate: '2026-08-01' }), NOW);
    assert.ok(when.getTime() > NOW.getTime());
  });

  it('uses urgency when no date was stated', () => {
    assert.equal(initialRemindAt(item({ urgency: 'high' }), NOW).toISOString(),
      '2026-08-25T14:00:00.000Z');
    assert.equal(initialRemindAt(item({ urgency: 'low' }), NOW).toISOString(),
      '2026-08-28T10:00:00.000Z');
  });

  it('ignores an unparseable date rather than crashing', () => {
    const when = initialRemindAt(item({ dueDate: 'next Tuesday' }), NOW);
    assert.equal(when.toISOString(), '2026-08-26T10:00:00.000Z', 'fell back to urgency');
  });
});
