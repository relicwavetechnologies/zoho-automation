import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requiresRequesterConfirmation } from '../../src/application/approval/business-action-routing.ts';
import { personalGateFrom } from '../../src/domain/approval/personal-gate.ts';

const gmailSend = { toolId: 'googleGmail', action: 'send' } as const;

describe('business action routing', () => {
  it('keeps requester confirmation only for client-owned channels', () => {
    assert.equal(requiresRequesterConfirmation({ ...gmailSend, action: 'create', channel: 'desktop' }), true);
    assert.equal(requiresRequesterConfirmation({ ...gmailSend, action: 'update', channel: 'airnote' }), true);
    assert.equal(requiresRequesterConfirmation({ ...gmailSend, action: 'delete' }), true);
  });

  it('lets Web and Lark proceed to central governance after conversational review', () => {
    assert.equal(requiresRequesterConfirmation({ ...gmailSend, action: 'create', channel: 'web' }), false);
    assert.equal(requiresRequesterConfirmation({ ...gmailSend, action: 'create', channel: 'lark' }), false);
  });

  it('never repeats review for reads or an already-reviewed mutation', () => {
    assert.equal(requiresRequesterConfirmation({ ...gmailSend, action: 'read', channel: 'web' }), false);
    assert.equal(requiresRequesterConfirmation({
      ...gmailSend,
      action: 'create',
      channel: 'desktop',
      reviewAlreadyRecorded: true,
    }), false);
  });

  it('confirms the actions somebody picked, on a channel that otherwise would not', () => {
    const personal = personalGateFrom(false, [['googleGmail', 'send']]);
    assert.equal(requiresRequesterConfirmation({ ...gmailSend, channel: 'web', personal }), true);
    assert.equal(requiresRequesterConfirmation({ ...gmailSend, channel: 'lark', personal }), true);
  });

  it('leaves the actions they did not pick alone', () => {
    // The point of moving off one boolean. Picking Gmail must not stop Sheets.
    const personal = personalGateFrom(false, [['googleGmail', 'send']]);
    assert.equal(requiresRequesterConfirmation({
      toolId: 'googleSheets', action: 'update', channel: 'web', personal,
    }), false);
  });

  it('confirms everything when somebody asked for everything', () => {
    const personal = personalGateFrom(true, []);
    assert.equal(requiresRequesterConfirmation({
      toolId: 'anythingAtAll', action: 'create', channel: 'web', personal,
    }), true);
    // Except reads, which nothing gates.
    assert.equal(requiresRequesterConfirmation({
      toolId: 'anythingAtAll', action: 'read', channel: 'web', personal,
    }), false);
  });

  it('does not let a reviewed knowledge apply be re-asked by a personal pick', () => {
    /* Ordering that matters: the payload's review is already recorded, and
       asking again would review the same thing twice while granting nothing
       new. The personal gate is about work nobody has confirmed yet. */
    assert.equal(requiresRequesterConfirmation({
      toolId: 'knowledge',
      action: 'create',
      channel: 'web',
      reviewAlreadyRecorded: true,
      personal: personalGateFrom(true, []),
    }), false);
  });
});
