import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shopifyCommerceSkill } from '../../src/application/skills/shopify.skill.ts';

describe('Shopify commerce skill', () => {
  it('documents governed export follow-up for analytics', () => {
    assert.match(shopifyCommerceSkill.instructions, /exportCandidate/);
    assert.match(shopifyCommerceSkill.instructions, /dataExport op=plan/);
    assert.match(shopifyCommerceSkill.instructions, /Never rerun shopifyAnalytics, shopifyOrders, or shopifyCustomers/);
    assert.match(shopifyCommerceSkill.instructions, /When exportCandidate is present, use dataExport op=plan/);
    assert.match(shopifyCommerceSkill.instructions, /invalid date/);
    assert.match(shopifyCommerceSkill.instructions, /order_utm_source/);
    assert.match(shopifyCommerceSkill.instructions, /not an immutable copy of the chat preview/);
  });
});
