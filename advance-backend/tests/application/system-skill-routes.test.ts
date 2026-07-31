import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from '../../src/application/skills/semrush-system-skill.ts';
import {
  SYSTEM_SKILL_ROUTE_SEEDS,
  unroutedSeededSystemSkillSlugs,
} from '../../src/application/skills/system-skill-routes.ts';

describe('system skill routes', () => {
  it('routes every seeded executable system skill through at least one router', () => {
    assert.deepEqual(unroutedSeededSystemSkillSlugs(), []);
  });

  it('routes Semrush through the research router', () => {
    const research = SYSTEM_SKILL_ROUTE_SEEDS.find(seed => seed.routerSlug === 'research-router');
    assert.ok(research);
    assert.ok(research.targetSlugs.includes(DIVO_SEMRUSH_SYSTEM_SKILL.slug));
  });

  it('keeps each router target list non-empty, unique, and free of self-links', () => {
    for (const seed of SYSTEM_SKILL_ROUTE_SEEDS) {
      assert.ok(seed.targetSlugs.length > 0, `${seed.routerSlug} has no targets`);
      assert.equal(new Set(seed.targetSlugs).size, seed.targetSlugs.length);
      assert.equal(seed.targetSlugs.includes(seed.routerSlug), false);
    }
  });
});
