/**
 * The recipe is not documentation — it is the instruction the agent acts on.
 *
 * Three places said, in plain words, that a rule's AI step cannot pick a
 * recipient. All three became false the moment routing shipped, and a model
 * that believes them does one of two things: refuses to build a routed rule, or
 * builds a single-destination one and reports success. Neither shows up as an
 * error anywhere.
 *
 * Asserted against the shipped definitions rather than a copy, so this keeps
 * holding as the recipe is edited.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAIL_OPS_SYSTEM_SKILLS } from '../../src/application/skills/mail-ops-system-skills.ts';
import { createMailAutomationsTool } from '../../src/application/tools/families/mail-automations.tool.ts';

const recipe = MAIL_OPS_SYSTEM_SKILLS.find(skill => skill.slug === 'mail-ops')!.markdown;
const instructions = createMailAutomationsTool({} as never).parameterDocs;

describe('what the recipe now says about picking a recipient', () => {
  it('no longer claims the destination cannot change', () => {
    // The exact sentence that used to be there. If it comes back, a routed rule
    // becomes unbuildable from Lark with nothing failing anywhere.
    assert.ok(
      !recipe.includes('The destination is fixed when the rule is written'),
      'the recipe still tells the model a verdict cannot move mail',
    );
    assert.ok(
      !instructions.includes('cannot pick a recipient. It only decides whether'),
      'the tool still tells the model a verdict cannot move mail',
    );
  });

  it('tells the model that different people for different mail is one rule', () => {
    // The commonest wrong turn: building two rules, which costs two model calls
    // per message and forwards twice when both would fire.
    assert.match(recipe, /different people for different kinds of the same mail/i);
    assert.match(recipe, /one\*\* rule with a routing table, not two rules/i);
  });

  it('makes the agent say out loud what happens to everything else', () => {
    /*
     * The decision that is invisible when wrong. A member who assumes unmatched
     * mail still arrives finds out when somebody asks where it went — so the
     * recipe has to make the agent raise it while the rule is being written,
     * not leave it as a default they could read about.
     */
    assert.match(recipe, /held back and shown to you, and nothing is sent/i);
    assert.match(recipe, /Do not create a routed rule without saying which of the two it is doing/i);
    assert.match(instructions, /Tell the user which one the rule is doing before creating it/i);
  });

  it('states the limits the runtime actually enforces', () => {
    // Each of these is refused at parse. A recipe that omits one produces a
    // model that keeps proposing rules the server keeps rejecting.
    assert.match(recipe, /Two to six routes/i);
    assert.match(recipe, /every route must send the same way/i);
    assert.match(recipe, /routed rule takes no .judge./i);
    assert.match(recipe, /One hourly ceiling for the whole rule/i);
  });

  it('says the set of recipients is closed, which is the whole safety case', () => {
    assert.match(recipe, /can never send anywhere else/i);
    assert.match(instructions, /can reach only the destinations written into it/i);
  });

  it('warns that update replaces the table rather than merging it', () => {
    // The trap that already cost a rule its question twice.
    assert.match(recipe, /replaces the whole table/i);
    assert.match(instructions, /update replaces routes and otherwise rather than merging/i);
  });

  it('says test calls no model, so it is not a preview of the sorting', () => {
    assert.match(recipe, /calls no model/i);
  });
});

/**
 * A capability the catalogue cannot be searched for exists only for whoever
 * already knows it does.
 *
 * `scoreRouterCandidate` ranks identity, alias and description tokens, so the
 * recipe body being right is worth nothing if the words a member actually uses
 * score zero against every skill. That failure is silent in the worst way: the
 * model is left guessing between families and picks one, so the member gets a
 * confident answer from the wrong recipe.
 */
describe('whether anybody asking for this can find it', () => {
  const mailOps = MAIL_OPS_SYSTEM_SKILLS.find(skill => skill.slug === 'mail-ops')!;
  const searchable = [
    mailOps.slug, mailOps.name, mailOps.summary,
    ...mailOps.aliases, ...mailOps.tags,
  ].join(' ').toLowerCase();

  it('is findable by the words somebody uses for sorting mail', () => {
    // Not "forward future email", which is what the aliases said and is not how
    // anybody describes wanting their client's mail split between two people.
    for (const word of ['sort', 'route', 'different', 'triage', 'people']) {
      assert.ok(searchable.includes(word), `nothing in mail-ops is searchable by "${word}"`);
    }
  });

  it('says in its summary that a rule can sort, not only forward', () => {
    // The summary is scored too, and it is the one line an operator reads in a
    // list of skills.
    assert.match(mailOps.summary, /sorting each arriving message to the right person/i);
  });

  it('sends the router there for two people rather than two rules', () => {
    // The commonest wrong turn, and the one place it can be headed off before
    // the recipe is even loaded.
    const router = MAIL_OPS_SYSTEM_SKILLS
      .find(skill => skill.slug === 'google-workspace-router')!.markdown;
    assert.match(router, /different kinds of it to different people/i);
    assert.match(router, /one arrival rule that sorts, not two rules/i);
  });
});
