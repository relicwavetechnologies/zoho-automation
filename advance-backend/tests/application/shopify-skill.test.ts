import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shopifyCommerceSkill } from '../../src/application/skills/shopify.skill.ts';

describe('Shopify commerce skill', () => {
  it('documents truthful bounded reads without a legacy export planner', () => {
    assert.doesNotMatch(shopifyCommerceSkill.instructions, /exportCandidate|dataExport/);
    assert.match(shopifyCommerceSkill.instructions, /remaining cursor as incomplete coverage/);
    assert.match(shopifyCommerceSkill.instructions, /top-N or page-bounded/);
    assert.match(shopifyCommerceSkill.instructions, /invalid date/);
    assert.match(shopifyCommerceSkill.instructions, /order_utm_source/);
  });
});
