import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  meetsConfidenceFloor,
  ownerLabel,
  type AnalyzedFollowUp,
} from '../../src/domain/follow-ups/follow-up.ts';

const item = (confidence: number): AnalyzedFollowUp => ({
  id: null,
  title: 'Send Priya the Q3 invoice',
  detail: 'Promised on Tuesday, not sent.',
  kind: 'commitment',
  owner: 'us',
  counterparty: 'Priya',
  dueDate: null,
  urgency: 'medium',
  confidence,
  evidence: ['I will send it tomorrow'],
  suggestedReply: '',
});

describe('follow-up domain', () => {
  it('admits an item at or above the floor and rejects one below', () => {
    assert.equal(meetsConfidenceFloor(item(0.55), 0.55), true);
    assert.equal(meetsConfidenceFloor(item(0.9), 0.55), true);
    assert.equal(meetsConfidenceFloor(item(0.54), 0.55), false);
  });

  it('rejects a non-numeric confidence rather than letting it through', () => {
    // A model that returns null or NaN must not be read as "certain".
    assert.equal(meetsConfidenceFloor(item(Number.NaN), 0.55), false);
    assert.equal(meetsConfidenceFloor(item(undefined as unknown as number), 0.55), false);
  });

  it('speaks as a team, never as a person', () => {
    // The whole point of owner being a side rather than an assignee.
    assert.equal(ownerLabel('us', 'Priya'), 'We owe');
    assert.equal(ownerLabel('them', 'Priya'), 'Waiting on Priya');
  });

  it('falls back gracefully when the counterparty is unknown', () => {
    assert.equal(ownerLabel('them', ''), 'Waiting on them');
    assert.equal(ownerLabel('them', '   '), 'Waiting on them');
  });
});
