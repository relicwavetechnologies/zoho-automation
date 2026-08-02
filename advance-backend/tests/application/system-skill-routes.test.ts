import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DIVO_SEMRUSH_SYSTEM_SKILL } from '../../src/application/skills/semrush-system-skill.ts';
import { DATA_EXPORT_SYSTEM_SKILL } from '../../src/application/skills/data-export-system-skill.ts';
import {
  ROUTING_SYSTEM_SKILLS,
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

  it('keeps Semrush complete-data exports on the governed offer route', () => {
    const research = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'research-router');
    assert.ok(research);
    assert.match(research.markdown, /preview\.exportOfferId/);
    assert.match(research.markdown, /through `data-router`/);
    assert.match(research.markdown, /never through provider pagination or a local workflow/);
  });

  it('routes pasted Google Sheets and Drive Excel workbooks through the data router', () => {
    const data = SYSTEM_SKILL_ROUTE_SEEDS.find(seed => seed.routerSlug === 'data-router');
    assert.ok(data);
    assert.ok(data.targetSlugs.includes('google-sheets'));
    const router = ROUTING_SYSTEM_SKILLS.find(skill => skill.slug === 'data-router')!;
    assert.match(router.markdown, /drive\.google\.com\/file\/d/);
    assert.match(router.markdown, /before Google Drive/);
    assert.match(router.markdown, /never request a download URL or import it directly/);
    assert.ok(router.aliases.includes('convert excel to google sheet'));
  });

  it('keeps provider previews, offers, scripts, Sheets, and attached files on distinct data routes', () => {
    const data = SYSTEM_SKILL_ROUTE_SEEDS.find(seed => seed.routerSlug === 'data-router');
    assert.ok(data);
    assert.ok(data.targetSlugs.includes(DATA_EXPORT_SYSTEM_SKILL.slug));
    assert.ok(data.targetSlugs.includes('divo-python-automation'));
    assert.ok(data.targetSlugs.includes('google-sheets'));
    assert.ok(data.targetSlugs.includes('read-understand-files'));
  });

  it('keeps each router target list non-empty, unique, and free of self-links', () => {
    for (const seed of SYSTEM_SKILL_ROUTE_SEEDS) {
      assert.ok(seed.targetSlugs.length > 0, `${seed.routerSlug} has no targets`);
      assert.equal(new Set(seed.targetSlugs).size, seed.targetSlugs.length);
      assert.equal(seed.targetSlugs.includes(seed.routerSlug), false);
    }
  });
});
