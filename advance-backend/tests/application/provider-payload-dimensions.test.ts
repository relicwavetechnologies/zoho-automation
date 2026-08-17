import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { providerPayloadDimensions } from '../../src/application/observability/provider-payload-dimensions';

describe('providerPayloadDimensions', () => {
  it('counts chat payload dimensions without returning content', () => {
    const result = providerPayloadDimensions({
      messages: [
        { role: 'system', content: 'fixed prompt' },
        { role: 'user', content: 'private question' },
      ],
      tools: [{ function: { name: 'one', parameters: { type: 'object', properties: {} } } }],
    }, false);

    assert.equal(result.systemPromptBytes, Buffer.byteLength('fixed prompt'));
    assert.ok(result.messagesBytes > result.systemPromptBytes);
    assert.ok(result.toolSchemaBytes > 0);
    assert.equal(JSON.stringify(result).includes('private question'), false);
  });

  it('counts Responses instructions and input separately', () => {
    const result = providerPayloadDimensions({
      instructions: 'system',
      input: [{ role: 'user', content: 'question' }],
    }, true);
    assert.equal(result.systemPromptBytes, Buffer.byteLength('system'));
    assert.ok(result.messagesBytes > 0);
    assert.equal(result.toolSchemaBytes, 0);
  });
});
