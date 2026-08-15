import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requiresRequesterConfirmation } from '../../src/application/approval/business-action-routing.ts';

describe('business action routing', () => {
  it('keeps requester confirmation only for client-owned channels', () => {
    assert.equal(requiresRequesterConfirmation({ action: 'create', channel: 'desktop' }), true);
    assert.equal(requiresRequesterConfirmation({ action: 'update', channel: 'airnote' }), true);
    assert.equal(requiresRequesterConfirmation({ action: 'delete' }), true);
  });

  it('lets Web and Lark proceed to central governance after conversational review', () => {
    assert.equal(requiresRequesterConfirmation({ action: 'create', channel: 'web' }), false);
    assert.equal(requiresRequesterConfirmation({ action: 'create', channel: 'lark' }), false);
  });

  it('never repeats review for reads or an already-reviewed mutation', () => {
    assert.equal(requiresRequesterConfirmation({ action: 'read', channel: 'web' }), false);
    assert.equal(requiresRequesterConfirmation({
      action: 'create',
      channel: 'desktop',
      reviewAlreadyRecorded: true,
    }), false);
  });
});
