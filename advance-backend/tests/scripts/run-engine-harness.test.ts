import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertHarnessChatBinding,
  parseEngineHarnessArgs,
} from '../../scripts/run-engine-harness';

describe('run-engine-harness delivery binding', () => {
  it('requires an explicit chat for every non-default principal even without final delivery', () => {
    assert.throws(
      () => parseEngineHarnessArgs([
        '--allow-impersonation',
        '--user',
        'Anish Suman',
        '--no-final-delivery',
        'test',
      ], {}),
      /requires an explicit --chat-id.*even with --no-final-delivery/i,
    );
  });

  it('accepts only an explicitly allowlisted chat for a non-default principal', () => {
    const options = parseEngineHarnessArgs([
      '--allow-impersonation',
      '--user',
      'Anish Suman',
      '--chat-id',
      'oc_anish',
      '--no-final-delivery',
      'test',
    ], {
      HARNESS_LARK_ALLOWED_CHAT_IDS: 'oc_anish',
    });

    assert.equal(options.userSelector, 'Anish Suman');
    assert.equal(options.chatId, 'oc_anish');
    assert.equal(options.deliverToLark, false);
  });

  it('rejects the misleading legacy no-delivery flag', () => {
    assert.throws(
      () => parseEngineHarnessArgs(['--no-delivery', 'test'], {}),
      /falsely implied a side-effect-free run.*--no-final-delivery/i,
    );
  });

  it('fails closed when provider chat mode or live membership disagrees', () => {
    assert.throws(
      () => assertHarnessChatBinding({
        chatId: 'oc_anish',
        expectedChatType: 'p2p',
        actualMode: 'group',
        selectedOpenId: 'ou_anish',
        memberOpenIds: ['ou_anish'],
      }),
      /provider mode group, not configured p2p/,
    );
    assert.throws(
      () => assertHarnessChatBinding({
        chatId: 'oc_anish',
        expectedChatType: 'p2p',
        actualMode: 'p2p',
        selectedOpenId: 'ou_anish',
        memberOpenIds: ['ou_someone_else'],
      }),
      /is not a live member/,
    );
  });

  it('accepts an exact provider mode and live principal membership', () => {
    assert.doesNotThrow(() => assertHarnessChatBinding({
      chatId: 'oc_anish',
      expectedChatType: 'p2p',
      actualMode: 'p2p',
      selectedOpenId: 'ou_anish',
      memberOpenIds: ['ou_anish'],
    }));
  });

  it('treats a provider topic as a group audience without weakening p2p checks', () => {
    assert.doesNotThrow(() => assertHarnessChatBinding({
      chatId: 'oc_topic',
      expectedChatType: 'group',
      actualMode: 'topic',
      selectedOpenId: 'ou_anish',
      memberOpenIds: ['ou_anish'],
    }));
    assert.throws(
      () => assertHarnessChatBinding({
        chatId: 'oc_topic',
        expectedChatType: 'p2p',
        actualMode: 'topic',
        selectedOpenId: 'ou_anish',
        memberOpenIds: ['ou_anish'],
      }),
      /provider mode topic, not configured p2p/,
    );
  });
});
