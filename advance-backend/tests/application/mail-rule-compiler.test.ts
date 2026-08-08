import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createMailRuleCompiler,
  extractJson,
  type MailRuleCompilation,
} from '../../src/application/mail-ops/mail-rule-compiler';

/**
 * Run the compiler against a fixed model reply.
 *
 * The model is stubbed rather than mocked at the network: what is under test is
 * what this file does with an answer, not whether a model can be reached.
 */
const compileWith = (reply: unknown): Promise<MailRuleCompilation> =>
  createMailRuleCompiler({
    model: {
      specificationVersion: 'v2',
      provider: 'test',
      modelId: 'test',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [{ type: 'text', text: JSON.stringify(reply) }],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        warnings: [],
      }),
      doStream: async () => { throw new Error('not used'); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  })({ sentence: 'test', mailboxEmail: 'abhishek@emiactech.com' });

describe('extractJson', () => {
  it('reads a bare object', () => {
    assert.deepEqual(extractJson('{"understood":false,"reason":"x"}'), {
      understood: false, reason: 'x',
    });
  });

  it('reads it out of a code fence', () => {
    // Models fence JSON however firmly they are told not to, and a rule that
    // fails because of three backticks is a rule the member has to describe
    // twice for no reason they can see.
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  });

  it('reads it out from behind a sentence', () => {
    assert.deepEqual(extractJson('Here you go:\n{"a":1}'), { a: 1 });
  });

  it('throws when there is no object at all', () => {
    assert.throws(() => extractJson('I could not do that.'));
  });
});

/**
 * The compiler could not produce a judge, so it refused the sentences the judge
 * was built for.
 *
 * Its prompt listed "reading the message" among the things to give up on, which
 * was true when it was written and stopped being true when the judge shipped.
 * A member asking for "contracts that actually need my signature" was told the
 * request was unclear — not that Divo needed something, but that it could not
 * be done. These pin the two halves of the fix: a judge survives, and a
 * malformed one is refused rather than quietly dropped.
 */
describe('a sentence whose real content is a judgement', () => {
  const compiled = (over: Record<string, unknown>) => ({
    understood: true,
    name: 'Contracts needing signature',
    match: { from: '@acme.com' },
    destination: { type: 'email', email: 'legal@emiactech.com' },
    ...over,
  });

  it('carries the question through to the draft', async () => {
    const judge = { question: 'Does this contract need the recipient’s signature?' };
    const out = await compileWith(compiled({ judge }));
    assert.equal(out.status, 'compiled');
    assert.deepEqual(out.status === 'compiled' ? out.judge : null, judge);
  });

  it('keeps the failure policy the sentence asked for', async () => {
    const judge = { question: 'Is this invoice overdue?', onFailure: 'open' as const };
    const out = await compileWith(compiled({ judge }));
    assert.deepEqual(out.status === 'compiled' ? out.judge : null, judge);
  });

  it('leaves judge absent when the sentence never asked for one', async () => {
    const out = await compileWith(compiled({}));
    assert.equal(out.status, 'compiled');
    assert.equal(out.status === 'compiled' && 'judge' in out, false);
  });

  /*
   * Refused, not dropped. A rule that lost its question forwards everything it
   * matched while reporting that it understood the sentence — the exact silent
   * failure this compiler was written to avoid.
   */
  it('refuses a question the runtime would not accept, rather than dropping it', async () => {
    for (const judge of [
      { question: 'short' },                                    // under the minimum
      { question: 'Is this urgent?', onFailure: 'maybe' },       // not a policy
      { question: 'Is this urgent?', whenUnsure: 'open' },        // key the schema does not name
      { queston: 'Is this urgent?' },                             // misspelled
    ]) {
      const out = await compileWith(compiled({ judge }));
      assert.equal(out.status, 'unclear', `${JSON.stringify(judge)} must not compile`);
    }
  });
});
