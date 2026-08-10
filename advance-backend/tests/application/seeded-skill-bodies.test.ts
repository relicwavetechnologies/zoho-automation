import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SEEDED_SYSTEM_SKILLS } from '../../src/application/skills/system-skill-routes.ts';

/**
 * Content checks that must see EVERY seeded skill, driven off the one list the
 * routing guard reads.
 *
 * The older sweep in system-skill-routes.test.ts is a hand-written array of
 * bodies, and that is exactly how a dead call surface survives: the scheduler
 * kept a whole "Required gateway sequence" section through a sweep that never
 * looked at it, and Zoho, Lark, mail-ops, files, presentations and OMS were
 * all missing from the array too. A skill absent from SEEDED_SYSTEM_SKILLS is
 * unrouted and unchecked at once, which is the only way it should ever be
 * exempt from either.
 */
describe('every seeded skill body', () => {
  it('covers the whole provisioned catalogue', () => {
    assert.ok(SEEDED_SYSTEM_SKILLS.length > 40, 'seeded list looks truncated');
    for (const skill of SEEDED_SYSTEM_SKILLS) {
      assert.ok(skill.slug, 'every seeded entry needs a slug');
      assert.ok(skill.markdown.length > 0, `${skill.slug} has an empty body`);
    }
    // Families that were missing from the hand-written sweep.
    for (const slug of [
      'read-understand-files', 'divo-presentations', 'divo-oms-site-inventory',
      'schedule-divo-work', 'share-memory', 'mail-ops', 'lark-messaging',
      'zoho-books-invoice', 'divo-python-automation',
    ]) {
      assert.ok(
        SEEDED_SYSTEM_SKILLS.some(skill => skill.slug === slug),
        `seeded list cannot see ${slug}`,
      );
    }
  });

  /*
   * divo_gateway was the mega-tool every provider skill was written against,
   * with `call_tool` as its server-channel variant. Both are deleted, so a
   * skill still naming either describes a call that cannot succeed.
   */
  it('never teaches a call surface the runtime removed', () => {
    for (const skill of SEEDED_SYSTEM_SKILLS) {
      assert.doesNotMatch(skill.markdown, /divo_gateway|call_tool|payload\.args/, skill.slug);
    }
  });

  /*
   * The gateway ops themselves still exist, so the names are real — but where
   * they are reachable from is not what the skills assumed.
   *
   * `tools.preflight` is reachable only as the typed tool `divo_preflight`
   * (divo-pi typed-platform-tools.ts) and is NOT in the divo-local broker's
   * allowlist, so naming the op is always wrong. `tools.list` and
   * `tools.invoke` ARE in that allowlist (local-broker.ts), so they are legal
   * inside a governed local script and illegal as a model tool call — which is
   * the form every swept skill had used.
   */
  it('names a gateway op only where that op is reachable', () => {
    for (const skill of SEEDED_SYSTEM_SKILLS) {
      assert.doesNotMatch(skill.markdown, /tools\.preflight/, skill.slug);
      for (const line of skill.markdown.split('\n')) {
        if (!/tools\.(list|invoke)/.test(line)) continue;
        assert.match(line, /divo-local/, `${skill.slug}: gateway op outside a divo-local call`);
      }
    }
  });
});
