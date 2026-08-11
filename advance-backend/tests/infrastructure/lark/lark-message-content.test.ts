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

  it('extracts visible Card 2.0 final-answer body and table values', () => {
    const text = extractInteractiveCardText({
      schema: '2.0',
      config: {
        summary: { content: 'Here are the latest orders from Airtable.' },
      },
      header: {
        title: { tag: 'plain_text', content: 'Latest orders' },
      },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: 'Here are the latest orders from the live Airtable Orders table.',
          },
          {
            tag: 'table',
            columns: [
              { name: 'order_number', display_name: 'Order #' },
              { name: 'sku', display_name: 'SKU' },
            ],
            rows: [
              { order_number: 'MH24129995', sku: 'MEN-GRO-TRI-PRO-BLU' },
            ],
          },
          {
            tag: 'collapsible_panel',
            header: { title: { tag: 'plain_text', content: 'Execution trace' } },
            elements: [{ tag: 'markdown', content: '✓ Airtable' }],
          },
        ],
      },
    });

    assert.match(text, /Latest orders/);
    assert.match(text, /Here are the latest orders from the live Airtable Orders table/);
    assert.match(text, /Order #/);
    assert.match(text, /MH24129995/);
    assert.match(text, /MEN-GRO-TRI-PRO-BLU/);
    assert.doesNotMatch(text, /order_number/);
  });
});
