import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUntaggedGroupMessage,
  mayPrepareAttachments,
  resolveCompanyUntaggedGroupPolicy,
  resolveUntaggedGroupPolicy,
  UNTAGGED_ATTACHMENTS_CONTROL,
  UNTAGGED_TEXT_RETENTION_CONTROL,
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

describe('per-company untagged policy', () => {
  const DEPLOYMENT_DEFAULT = {
    LARK_UNTAGGED_GROUP_TEXT_RETENTION: 'retain',
    LARK_UNTAGGED_GROUP_ATTACHMENTS: 'ignore',
  } as const;

  it('falls back to the deployment default when a company has set nothing', () => {
    const resolved = resolveCompanyUntaggedGroupPolicy({
      env: DEPLOYMENT_DEFAULT,
      controls: [],
    });

    assert.equal(resolved.retainText, true);
    assert.equal(resolved.processAttachments, false);
    assert.deepEqual(resolved.attachments, { value: 'ignore', origin: 'deployment' });
  });

  it('lets one company opt in without affecting the deployment default', () => {
    const optedIn = resolveCompanyUntaggedGroupPolicy({
      env: DEPLOYMENT_DEFAULT,
      controls: [{ controlKey: UNTAGGED_ATTACHMENTS_CONTROL, value: 'process' }],
    });
    const untouched = resolveCompanyUntaggedGroupPolicy({
      env: DEPLOYMENT_DEFAULT,
      controls: [],
    });

    // One process serves many companies; a shared switch would turn this on for
    // every other company in it.
    assert.equal(optedIn.processAttachments, true);
    assert.deepEqual(optedIn.attachments, { value: 'process', origin: 'company' });
    assert.equal(untouched.processAttachments, false);
  });

  it('lets a company opt out of retention the deployment enables', () => {
    const resolved = resolveCompanyUntaggedGroupPolicy({
      env: DEPLOYMENT_DEFAULT,
      controls: [{ controlKey: UNTAGGED_TEXT_RETENTION_CONTROL, value: 'off' }],
    });

    assert.equal(resolved.retainText, false);
    assert.deepEqual(resolved.textRetention, { value: 'off', origin: 'company' });
  });

  it('ignores an unrecognised stored value instead of reading it as consent', () => {
    const resolved = resolveCompanyUntaggedGroupPolicy({
      env: DEPLOYMENT_DEFAULT,
      controls: [
        { controlKey: UNTAGGED_ATTACHMENTS_CONTROL, value: 'PROCESS' },
        { controlKey: UNTAGGED_TEXT_RETENTION_CONTROL, value: 'yes' },
      ],
    });

    // A typo in a control row must not start indexing a company's files.
    assert.equal(resolved.processAttachments, false);
    assert.equal(resolved.attachments.origin, 'deployment');
    assert.equal(resolved.retainText, true);
    assert.equal(resolved.textRetention.origin, 'deployment');
  });

  it('keeps the two settings independent', () => {
    const resolved = resolveCompanyUntaggedGroupPolicy({
      env: { LARK_UNTAGGED_GROUP_TEXT_RETENTION: 'off', LARK_UNTAGGED_GROUP_ATTACHMENTS: 'process' },
      controls: [{ controlKey: UNTAGGED_TEXT_RETENTION_CONTROL, value: 'retain' }],
    });

    assert.equal(resolved.retainText, true);
    assert.equal(resolved.textRetention.origin, 'company');
    assert.equal(resolved.processAttachments, true);
    assert.equal(resolved.attachments.origin, 'deployment');
  });
});
