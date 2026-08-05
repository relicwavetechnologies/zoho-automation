import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shopifyCommerceSkill } from '../../src/application/skills/shopify.skill.ts';

describe('Shopify commerce skill', () => {
  it('documents governed export follow-up for analytics', () => {
    assert.match(shopifyCommerceSkill.instructions, /exportCandidate/);
    assert.match(shopifyCommerceSkill.instructions, /dataExport op=plan/);
    assert.match(shopifyCommerceSkill.instructions, /Never rerun shopifyAnalytics/);
    assert.match(shopifyCommerceSkill.instructions, /top-N rows only/);
    assert.match(shopifyCommerceSkill.instructions, /at most 25 rows/);
    assert.match(shopifyCommerceSkill.instructions, /customer_acquisition \(requires granularity/);
    assert.match(shopifyCommerceSkill.instructions, /shopifyOrders and shopifyCustomers do not expose exportCandidate/);
    assert.match(shopifyCommerceSkill.instructions, /invalid date/);
    assert.match(shopifyCommerceSkill.instructions, /order_utm_source/);
    assert.match(shopifyCommerceSkill.instructions, /not an immutable copy of the chat preview/);
  });
});
