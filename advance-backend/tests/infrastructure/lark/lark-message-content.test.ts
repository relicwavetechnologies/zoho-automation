import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractInteractiveCardText } from '../../../src/infrastructure/channels/lark/lark-message-content.ts';

describe('Lark interactive card text extraction', () => {
  it('returns no text for an empty parsed card', () => {
    assert.equal(extractInteractiveCardText({}), '');
  });

  it('stops safely when visible content is nested beyond the depth limit', () => {
    let nested: Record<string, unknown> = { tag: 'plain_text', content: 'too deep' };
    for (let depth = 0; depth < 30; depth++) nested = { elements: [nested] };

    assert.equal(extractInteractiveCardText(nested), '');
  });

  it('caps output and stops walking a wide card after the cap is reached', () => {
    let inspectedPastCap = false;
    const elements = Array.from({ length: 200 }, (_, index) => ({
      tag: 'plain_text',
      content: `${index}:${'x'.repeat(120)}`,
    }));
    Object.defineProperty(elements, 100, {
      get() {
        inspectedPastCap = true;
        throw new Error('walked past output cap');
      },
    });

    const text = extractInteractiveCardText({ elements });

    assert.equal(text.length, 4_000);
    assert.equal(inspectedPastCap, false);
  });
});
