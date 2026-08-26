import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAnalysisPrompt } from '../../src/application/follow-ups/follow-up-analysis.ts';
import type { TrackedFollowUp } from '../../src/domain/follow-ups/follow-up.ts';

/**
 * Closing a follow-up has to stay closed.
 *
 * The failure this guards is quiet and complete: a person dismisses an item, the
 * next sweep reads the same transcript, the model cannot see the dismissal
 * because nothing showed it one, and files the same commitment as new. The team
 * sees a dismiss button that does not work, and the returning row has a
 * different id so nothing connects it to what they cleared.
 */

const tracked = (over: Partial<TrackedFollowUp> = {}): TrackedFollowUp => ({
  id: 'f-1',
  title: 'Send Priya the pricing sheet',
  kind: 'commitment',
  owner: 'us',
  counterparty: 'Priya',
  dueDate: null,
  ...over,
});

const input = (items: TrackedFollowUp[]) => ({
  chatName: 'Venue — Priya',
  isGroup: false,
  timeZone: 'Asia/Kolkata',
  messages: [],
  tracked: items,
  now: new Date('2026-08-25T10:00:00Z'),
});

describe('the analysis prompt', () => {
  it('lists an open item as tracked', () => {
    const prompt = buildAnalysisPrompt(input([tracked()]));
    assert.match(prompt, /Already tracked for this chat:\n- id=f-1/);
    assert.doesNotMatch(prompt, /Already closed by the team/);
  });

  it('lists a closed item under closed, and never under tracked', () => {
    const prompt = buildAnalysisPrompt(input([
      tracked(),
      tracked({ id: 'f-2', title: 'Confirm the mandap size', closedByTeam: true }),
    ]));

    const trackedBlock = prompt.split('Already tracked for this chat:')[1]!
      .split('Already closed by the team')[0]!;
    // The closed one must not appear as still open, or the model refreshes it
    // and `applyPlan` silently drops the update.
    assert.match(trackedBlock, /id=f-1/);
    assert.doesNotMatch(trackedBlock, /id=f-2/);

    assert.match(prompt, /Already closed by the team[^\n]*do NOT report these again/);
    assert.match(prompt.split('Already closed by the team')[1]!, /id=f-2/);
  });

  it('says this is the first pass when every item is closed', () => {
    // Not "here are your tracked items" followed by an empty list — the model
    // is told plainly that nothing is open, and separately what was closed.
    const prompt = buildAnalysisPrompt(input([tracked({ closedByTeam: true })]));
    assert.match(prompt, /Already tracked for this chat:\nNone yet/);
    assert.match(prompt, /Already closed by the team/);
  });

  it('omits the closed section entirely when nothing was closed', () => {
    const prompt = buildAnalysisPrompt(input([tracked()]));
    assert.equal(prompt.includes('Already closed'), false);
  });
});
