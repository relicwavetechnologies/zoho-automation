import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Client as LarkSdkClient } from '@larksuiteoapi/node-sdk';
import type { TypedEnv } from '../../../src/config/env.ts';
import type { Logger } from '../../../src/shared/logger.ts';
import type { ChannelIdentityRepoPort } from '../../../src/infrastructure/persistence/channel-identity.repository.ts';
import {
  buildParentContextPrefix,
  classifyParentFetchFailure,
  fetchParentMessage,
} from '../../../src/infrastructure/channels/lark/lark-parent-message.ts';

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return this; },
};

const identityLookups: Array<{ openId: string; tenantKey: string }> = [];
const identityRepo = {
  resolveByLarkTenantIdentity: async (openId: string, tenantKey: string) => {
    identityLookups.push({ openId, tenantKey });
    return {
    ok: true as const,
    value: {
      userId: 'user-1',
      companyId: 'company-1',
      aiRole: 'MEMBER',
      channel: 'lark',
      displayName: 'Alice',
    },
    };
  },
} as ChannelIdentityRepoPort;

function sdkClient(
  response: unknown,
  imageBytes: Buffer = Buffer.from('image'),
  onImageDownload?: () => void,
): LarkSdkClient {
  return {
    im: {
      v1: {
        message: {
          get: async () => {
            if (response instanceof Error) throw response;
            return response;
          },
        },
        messageResource: {
          get: async () => {
            onImageDownload?.();
            return {
              async *getReadableStream() {
                yield imageBytes;
              },
            };
          },
        },
      },
    },
  } as unknown as LarkSdkClient;
}

function fetchWith(
  response: unknown,
  options: { imageBytes?: Buffer; onImageDownload?: () => void } = {},
) {
  identityLookups.length = 0;
  return fetchParentMessage({
    parentMessageId: 'om_parent',
    env: {} as TypedEnv,
    logger,
    channelIdentityRepo: identityRepo,
    companyId: 'company-1',
    userId: 'user-1',
    chatId: 'oc_expected',
    tenantKey: 'tenant-1',
    sdkClient: sdkClient(response, options.imageBytes, options.onImageDownload),
  });
}

describe('Lark parent message references', () => {
  it('classifies documented deleted, invisible, and forbidden failures', () => {
    assert.equal(classifyParentFetchFailure(230110), 'deleted');
    assert.equal(classifyParentFetchFailure(230073), 'invisible');
    assert.equal(classifyParentFetchFailure(230027), 'forbidden');
    assert.equal(classifyParentFetchFailure(55001), 'unavailable');
  });

  it('returns bounded available context from the expected chat', async () => {
    const result = await fetchWith({
      code: 0,
      data: {
        items: [{
          chat_id: 'oc_expected',
          msg_type: 'text',
          sender: { id: 'ou_alice' },
          body: { content: JSON.stringify({ text: 'Please review this.' }) },
        }],
      },
    });

    assert.equal(result.status, 'available');
    assert.equal(result.senderName, 'Alice');
    assert.deepEqual(identityLookups, [{ openId: 'ou_alice', tenantKey: 'tenant-1' }]);
    assert.equal(
      buildParentContextPrefix(result),
      '[Referenced message from Alice: "Please review this."]',
    );
  });

  it('does not expose content from a different chat', async () => {
    const result = await fetchWith({
      code: 0,
      data: {
        items: [{
          chat_id: 'oc_other',
          msg_type: 'text',
          sender: { id: 'ou_alice' },
          body: { content: JSON.stringify({ text: 'Secret text' }) },
        }],
      },
    });

    assert.equal(result.status, 'forbidden');
    assert.doesNotMatch(buildParentContextPrefix(result), /Secret text/);
  });

  it('fails closed when Lark omits the parent chat identity', async () => {
    const result = await fetchWith({
      code: 0,
      data: {
        items: [{
          msg_type: 'text',
          sender: { id: 'ou_alice' },
          body: { content: JSON.stringify({ text: 'Secret text' }) },
        }],
      },
    });

    assert.equal(result.status, 'forbidden');
    assert.doesNotMatch(buildParentContextPrefix(result), /Secret text/);
  });

  it('preserves an explicit deleted state instead of returning empty context', async () => {
    const result = await fetchWith({ code: 230110, msg: 'message deleted' });

    assert.equal(result.status, 'deleted');
    assert.match(buildParentContextPrefix(result), /deleted or recalled/);
    assert.match(buildParentContextPrefix(result), /do not infer or guess/);
  });

  it('reports transport failures as temporary unavailability', async () => {
    const result = await fetchWith(new Error('network timeout'));

    assert.equal(result.status, 'unavailable');
    assert.match(buildParentContextPrefix(result), /temporarily unavailable/);
    assert.match(buildParentContextPrefix(result), /do not infer or guess/);
  });

  it('marks unknown message formats as unsupported', async () => {
    const result = await fetchWith({
      code: 0,
      data: {
        items: [{
          chat_id: 'oc_expected',
          msg_type: 'system',
          sender: { id: 'ou_alice' },
          body: { content: '{}' },
        }],
      },
    });

    assert.equal(result.status, 'unsupported');
    assert.match(buildParentContextPrefix(result), /unsupported message type \(system\)/);
  });

  it('caps rich-text parent images before downloading them', async () => {
    let downloads = 0;
    const result = await fetchWith({
      code: 0,
      data: {
        items: [{
          chat_id: 'oc_expected',
          msg_type: 'post',
          sender: { id: 'ou_alice' },
          body: {
            content: JSON.stringify({
              content: [[1, 2, 3, 4, 5].map(index => ({
                tag: 'img',
                image_key: `img_${index}`,
              }))],
            }),
          },
        }],
      },
    }, {
      onImageDownload: () => { downloads += 1; },
    });

    assert.equal(result.status, 'available');
    assert.equal(downloads, 4);
    assert.equal(result.imageUrls.length, 4);
    assert.equal(result.omittedImageCount, 1);
    assert.match(buildParentContextPrefix(result), /1 additional image was omitted/);
  });

  it('stops reading an oversized parent image before upload or prompt injection', async () => {
    const result = await fetchWith({
      code: 0,
      data: {
        items: [{
          chat_id: 'oc_expected',
          msg_type: 'image',
          sender: { id: 'ou_alice' },
          body: { content: JSON.stringify({ image_key: 'large_image' }) },
        }],
      },
    }, {
      imageBytes: Buffer.alloc(10 * 1_024 * 1_024 + 1),
    });

    assert.equal(result.status, 'available');
    assert.deepEqual(result.imageUrls, []);
  });
});
