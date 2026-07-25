import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUntaggedGroupMessage,
  mayPrepareAttachments,
  resolveUntaggedGroupPolicy,
} from '../../../src/infrastructure/channels/lark/lark-untagged-policy.ts';

const policy = (
  text: 'retain' | 'off',
  attachments: 'ignore' | 'process',
) => resolveUntaggedGroupPolicy({
  LARK_UNTAGGED_GROUP_TEXT_RETENTION: text,
  LARK_UNTAGGED_GROUP_ATTACHMENTS: attachments,
});

describe('untagged group policy resolution', () => {
  it('reads each setting independently', () => {
    assert.deepEqual(policy('retain', 'ignore'), { retainText: true, processAttachments: false });
    assert.deepEqual(policy('off', 'process'), { retainText: false, processAttachments: true });
  });

  it('treats any value other than the opt-in as off', () => {
    // Env validation already constrains these, but the resolver must not turn a
    // malformed or absent value into consent to index files.
    const loose = resolveUntaggedGroupPolicy({} as never);
    assert.deepEqual(loose, { retainText: false, processAttachments: false });
  });
});

describe('untagged group message classification', () => {
  it('classifies a group message that does not mention Divo as untagged', () => {
    assert.equal(isUntaggedGroupMessage({ chatType: 'group', mentionsSelf: false }), true);
  });

  it('does not classify a mentioned group message as untagged', () => {
    assert.equal(isUntaggedGroupMessage({ chatType: 'group', mentionsSelf: true }), false);
  });

  it('never classifies a DM as untagged ambient context', () => {
    // Sending Divo a direct message is itself the address, so a DM must not
    // fall under a policy written for conversation Divo merely overhears.
    assert.equal(isUntaggedGroupMessage({ chatType: 'p2p', mentionsSelf: false }), false);
  });
});

describe('attachment preparation gate', () => {
  it('blocks untagged attachments under the default policy', () => {
    assert.equal(mayPrepareAttachments({
      attachmentCount: 1,
      untagged: true,
      policy: policy('retain', 'ignore'),
    }), false);
  });

  it('allows untagged attachments only when the company opts in', () => {
    assert.equal(mayPrepareAttachments({
      attachmentCount: 1,
      untagged: true,
      policy: policy('retain', 'process'),
    }), true);
  });

  it('never blocks attachments on a message addressed to Divo', () => {
    // The policy governs what Divo takes uninvited. Asking Divo to read a file
    // is the invitation, so the opt-in setting must not gate it.
    for (const attachments of ['ignore', 'process'] as const) {
      assert.equal(mayPrepareAttachments({
        attachmentCount: 2,
        untagged: false,
        policy: policy('retain', attachments),
      }), true, `addressed message with attachments=${attachments}`);
    }
  });

  it('has nothing to prepare when the message carries no attachments', () => {
    assert.equal(mayPrepareAttachments({
      attachmentCount: 0,
      untagged: false,
      policy: policy('retain', 'process'),
    }), false);
  });

  it('does not let text retention imply attachment processing', () => {
    // The two settings govern different costs: retained text is already visible
    // to the room, while a processed attachment leaves Lark entirely.
    assert.equal(mayPrepareAttachments({
      attachmentCount: 1,
      untagged: true,
      policy: policy('retain', 'ignore'),
    }), false);
    assert.equal(mayPrepareAttachments({
      attachmentCount: 1,
      untagged: true,
      policy: policy('off', 'process'),
    }), true);
  });
});
