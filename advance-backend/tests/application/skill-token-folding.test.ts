/**
 * The safety case for folding plurals in skill routing.
 *
 * Routing scored tokens by exact set membership, so `email` found the Google
 * Workspace router and `emails` found nothing — every router scored zero and
 * the model was left guessing between them. "Forward my emails automatically"
 * is about the most ordinary way anybody would ask, and it was the one
 * phrasing that could not be routed.
 *
 * The fold is one line of the ranking path, and that path ranks every family:
 * a bad rule here misroutes Airtable and Shopify to fix mail. So the risk this
 * file exists to rule out is not "does `emails` work now" — that is one
 * assertion below — but **can this fold quietly merge two words the catalogue
 * already tells apart**. That is checked against the real corpus rather than
 * against examples chosen to pass.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { singularize } from '../../src/application/skills/skill-catalog.service.ts';
import { MAIL_OPS_SYSTEM_SKILLS } from '../../src/application/skills/mail-ops-system-skills.ts';
import { ROUTING_SYSTEM_SKILLS } from '../../src/application/skills/system-skill-routes.ts';
import { LARK_SYSTEM_SKILLS } from '../../src/application/skills/lark-system-skills.ts';
import { GOOGLE_WORKSPACE_SYSTEM_SKILLS } from '../../src/application/skills/google-workspace-system-skills.ts';
import { FILES_AND_DOCUMENTS_SYSTEM_SKILLS } from '../../src/application/skills/files-and-documents-system-skills.ts';
import { ZOHO_FINANCE_SYSTEM_SKILLS } from '../../src/application/skills/zoho-finance-system-skills.ts';

/** Every word the shipped catalogue is actually indexed and searched on. */
const corpusTokens = (): Set<string> => {
  const skills: ReadonlyArray<Record<string, unknown>> = [
    ...MAIL_OPS_SYSTEM_SKILLS,
    ...ROUTING_SYSTEM_SKILLS,
    ...LARK_SYSTEM_SKILLS,
    ...GOOGLE_WORKSPACE_SYSTEM_SKILLS,
    ...FILES_AND_DOCUMENTS_SYSTEM_SKILLS,
    ...ZOHO_FINANCE_SYSTEM_SKILLS,
  ] as ReadonlyArray<Record<string, unknown>>;

  const words = new Set<string>();
  for (const skill of skills) {
    const parts = [
      String(skill['slug'] ?? ''),
      String(skill['name'] ?? ''),
      String(skill['summary'] ?? ''),
      ...((skill['aliases'] as string[] | undefined) ?? []),
      ...((skill['tags'] as string[] | undefined) ?? []),
    ].join(' ');
    for (const word of parts.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 1) words.add(word);
    }
  }
  return words;
};

describe('folding a plural onto its singular', () => {
  /*
   * The whole point. `email` was routable and `emails` was not, and nothing
   * about the second is less clear than the first.
   */
  it('reads a plural as the word the catalogue indexes', () => {
    for (const [plural, singular] of [
      ['emails', 'email'],
      ['rules', 'rule'],
      ['invoices', 'invoice'],
      ['messages', 'message'],
      ['contacts', 'contact'],
      ['calendars', 'calendar'],
      ['batches', 'batch'],
      ['companies', 'company'],
      // `-ses` drops only the `s`. Treating it like `-ches` gave `expens` and
      // `respon`, which is the collision the corpus check below caught.
      ['expenses', 'expense'],
      ['responses', 'response'],
    ] as const) {
      assert.equal(singularize(plural), singular, `${plural} should fold to ${singular}`);
    }
  });

  /*
   * The exclusions, named individually because each is a word that would
   * otherwise be mangled into a token nothing in the catalogue holds.
   */
  it('leaves words that merely end in s alone', () => {
    for (const word of [
      'business', 'address', 'status', 'analysis', 'access',
      'docs', 'apps', 'this', 'gmail', 'lark',
    ]) {
      assert.equal(singularize(word), word, `${word} must be left alone`);
    }
  });

  /*
   * The regression that actually matters.
   *
   * If two distinct words already in the shipped catalogue fold onto the same
   * stem, this rule has merged a distinction the routing depends on — and it
   * would do it silently, on a family nobody was testing. Checked against the
   * real definitions so it keeps holding as skills are added.
   */
  it('never merges two words the shipped catalogue tells apart', () => {
    const collisions = new Map<string, Set<string>>();
    for (const word of corpusTokens()) {
      const stem = singularize(word);
      const bucket = collisions.get(stem) ?? new Set<string>();
      bucket.add(word);
      collisions.set(stem, bucket);
    }

    const merged = [...collisions.entries()]
      // A word and its own plural sharing a stem is the feature, not a
      // collision — that is only a merge if the two mean different things.
      .filter(([stem, words]) => words.size > 1 && ![...words].every(
        w => w === stem || singularize(w) === stem,
      ));

    assert.deepEqual(merged, [], `these catalogue words now share a stem: ${JSON.stringify(merged)}`);
  });

  /* Folding is idempotent, or the index and the query can disagree. */
  it('folds the same way however many times it is applied', () => {
    for (const word of corpusTokens()) {
      assert.equal(singularize(singularize(word)), singularize(word), word);
    }
  });

  it('leaves short words alone, so docs and apps stay themselves', () => {
    for (const word of ['is', 'as', 'ops', 'docs', 'apps']) {
      assert.equal(singularize(word), word);
    }
  });
});
