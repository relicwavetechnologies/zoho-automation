import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mayPrepareAttachment,
  isUntaggedGroupMessage,
  isSendOnlyDigestRoom,
  mayPrepareAttachments,
  resolveCompanyUntaggedGroupPolicy,
  resolveUntaggedGroupPolicy,
  UNTAGGED_ATTACHMENTS_CONTROL,
} from '../../../src/infrastructure/channels/lark/lark-untagged-policy.ts';

const policy = (attachments: 'ignore' | 'process') => resolveUntaggedGroupPolicy({
  LARK_UNTAGGED_GROUP_ATTACHMENTS: attachments,
});

describe('untagged group policy resolution', () => {
  it('reads the attachment-processing setting', () => {
    assert.deepEqual(policy('ignore'), { processAttachments: false });
    assert.deepEqual(policy('process'), { processAttachments: true });
  });

  it('treats any value other than the opt-in as off', () => {
    // Env validation already constrains these, but the resolver must not turn a
    // malformed or absent value into consent to index files.
    const loose = resolveUntaggedGroupPolicy({} as never);
    assert.deepEqual(loose, { processAttachments: false });
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
      policy: policy('ignore'),
    }), false);
  });

  it('allows untagged attachments only when the company opts in', () => {
    assert.equal(mayPrepareAttachments({
      attachmentCount: 1,
      untagged: true,
      policy: policy('process'),
    }), true);
  });

  it('never blocks attachments on a message addressed to Divo', () => {
    // The policy governs what Divo takes uninvited. Asking Divo to read a file
    // is the invitation, so the opt-in setting must not gate it.
    for (const attachments of ['ignore', 'process'] as const) {
      assert.equal(mayPrepareAttachments({
        attachmentCount: 2,
        untagged: false,
        policy: policy(attachments),
      }), true, `addressed message with attachments=${attachments}`);
    }
  });

  it('has nothing to prepare when the message carries no attachments', () => {
    assert.equal(mayPrepareAttachments({
      attachmentCount: 0,
      untagged: false,
      policy: policy('process'),
    }), false);
  });

  it('does not let room listening imply attachment processing', () => {
    assert.equal(mayPrepareAttachments({
      attachmentCount: 1,
      untagged: true,
      policy: policy('ignore'),
    }), false);
  });
});

describe('per-company untagged policy', () => {
  const DEPLOYMENT_DEFAULT = {
    LARK_UNTAGGED_GROUP_ATTACHMENTS: 'ignore',
  } as const;

  it('falls back to the deployment default when a company has set nothing', () => {
    const resolved = resolveCompanyUntaggedGroupPolicy({
      env: DEPLOYMENT_DEFAULT,
      controls: [],
    });

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

  it('ignores an unrecognised stored value instead of reading it as consent', () => {
    const resolved = resolveCompanyUntaggedGroupPolicy({
      env: DEPLOYMENT_DEFAULT,
      controls: [{ controlKey: UNTAGGED_ATTACHMENTS_CONTROL, value: 'PROCESS' }],
    });

    // A typo in a control row must not start indexing a company's files.
    assert.equal(resolved.processAttachments, false);
    assert.equal(resolved.attachments.origin, 'deployment');
  });
});


// ─── Documents versus images ────────────────────────────────────────────────

describe('mayPrepareAttachment', () => {
  const ignore = { processAttachments: false };
  const process = { processAttachments: true };

  it('prepares a document even when nobody mentioned Divo', () => {
    // Lark gives a file message no text field, so a document upload cannot
    // carry an @mention. Gating on one would refuse every document ever
    // posted in a group — the mention is structurally impossible, not withheld.
    assert.equal(mayPrepareAttachment({ kind: 'file', untagged: true, policy: ignore }), true);
  });

  it('refuses an untagged image under the default policy', () => {
    // Preparing an image ships the pixels to a third-party vision provider,
    // and an image *can* be posted with a mention, so silence here is a real
    // signal rather than a limitation of the message format.
    assert.equal(mayPrepareAttachment({ kind: 'image', untagged: true, policy: ignore }), false);
  });

  it('prepares an untagged image once a company opts in', () => {
    assert.equal(mayPrepareAttachment({ kind: 'image', untagged: true, policy: process }), true);
  });

  it('prepares anything on a message that addressed Divo', () => {
    assert.equal(mayPrepareAttachment({ kind: 'image', untagged: false, policy: ignore }), true);
    assert.equal(mayPrepareAttachment({ kind: 'file', untagged: false, policy: ignore }), true);
  });
});

describe('mayPrepareAttachments — message-level short circuit', () => {
  const ignore = { processAttachments: false };

  it('stays consistent with the per-attachment gate for documents', () => {
    // These two must agree. If the message-level check said no, the document
    // would be dropped before the per-attachment gate ever ran, and the
    // exemption above would be dead code.
    assert.equal(
      mayPrepareAttachments({ attachmentCount: 1, documentCount: 1, untagged: true, policy: ignore }),
      true,
    );
  });

  it('short-circuits an untagged image-only message', () => {
    assert.equal(
      mayPrepareAttachments({ attachmentCount: 1, documentCount: 0, untagged: true, policy: ignore }),
      false,
    );
  });

  it('lets a mixed message through so the document survives', () => {
    assert.equal(
      mayPrepareAttachments({ attachmentCount: 2, documentCount: 1, untagged: true, policy: ignore }),
      true,
    );
  });

  it('does no work when there is nothing attached', () => {
    assert.equal(
      mayPrepareAttachments({ attachmentCount: 0, documentCount: 0, untagged: false, policy: ignore }),
      false,
    );
  });
});

// ─── Send-only digest rooms ─────────────────────────────────────────────────

describe('isSendOnlyDigestRoom', () => {

const digestPrisma = (row: { sendOnly: boolean } | null, onCall?: (args: unknown) => void) => ({
  followUpDigest: {
    findFirst: async (args: unknown) => { onCall?.(args); return row; },
  },
  });

  it('isSendOnlyDigestRoom: a digest room marked send-only silences replies', async () => {
  assert.equal(
    await isSendOnlyDigestRoom({
      prisma: digestPrisma({ sendOnly: true }),
      companyId: 'c1',
      chatId: 'oc_digest',
    }),
    true,
  );
  });

  it('isSendOnlyDigestRoom: a digest room may opt back into conversation', async () => {
  assert.equal(
    await isSendOnlyDigestRoom({
      prisma: digestPrisma({ sendOnly: false }),
      companyId: 'c1',
      chatId: 'oc_digest',
    }),
    false,
  );
  });

  it('isSendOnlyDigestRoom: an ordinary room is untouched', async () => {
  assert.equal(
    await isSendOnlyDigestRoom({
      prisma: digestPrisma(null),
      companyId: 'c1',
      chatId: 'oc_team',
    }),
    false,
  );
  });

  it('isSendOnlyDigestRoom: scoped to the company, never chatId alone', async () => {
  // One Lark installation can serve more than one Divo company. Matching a room
  // by id alone would let one company's digest room silence Divo in another's.
  let seen: unknown = null;
  await isSendOnlyDigestRoom({
    prisma: digestPrisma({ sendOnly: true }, args => { seen = args }),
    companyId: 'c1',
    chatId: 'oc_digest',
  });
  const where = (seen as { where: Record<string, unknown> }).where;
  assert.equal(where['companyId'], 'c1');
  assert.equal(where['larkChatId'], 'oc_digest');
  });

  it('isSendOnlyDigestRoom: a failed lookup lets Divo answer', async () => {
  // Fails open on purpose. Silencing Divo because a query timed out is the
  // confusing failure — a bot that stopped responding for no visible reason —
  // where the other direction costs one unwanted answer.
  const warnings: string[] = [];
  assert.equal(
    await isSendOnlyDigestRoom({
      prisma: {
        followUpDigest: { findFirst: async () => { throw new Error('db down') } },
      },
      companyId: 'c1',
      chatId: 'oc_digest',
      log: { warn: (m) => { warnings.push(m) } },
    }),
    false,
  );
  assert.equal(warnings.length, 1)
  });

  it('isSendOnlyDigestRoom: nothing to look up is not a send-only room', async () => {
  for (const missing of [{ companyId: undefined }, { chatId: undefined }] as const) {
    assert.equal(
      await isSendOnlyDigestRoom({
        prisma: digestPrisma({ sendOnly: true }),
        companyId: 'c1',
        chatId: 'oc_digest',
        ...missing,
      }),
      false,
    );
  }
  });
});
