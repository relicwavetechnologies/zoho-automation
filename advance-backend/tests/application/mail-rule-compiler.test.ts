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

/**
 * The sentence this whole feature was built for.
 *
 * The old prompt had exactly one DESTINATION and refused an "or" between
 * conditions — so "invoices to Anish, product mail to Rakshit" came back
 * `unclear`, which tells a member Divo cannot do the one thing that was just
 * built for them.
 */
describe('a sentence that names different people for different mail', () => {
  const routed = (over: Record<string, unknown> = {}) => ({
    understood: true,
    name: 'Client mail, sorted',
    match: { from: 'client@google.com' },
    destination: {
      type: 'routed',
      routes: [
        { key: 'invoices', when: 'an invoice, bill or payment request', destination: { type: 'email', email: 'anish@emiactech.com' } },
        { key: 'product', when: 'about the product, a feature or a bug', destination: { type: 'email', email: 'rdx.omega2678@gmail.com' } },
      ],
      otherwise: 'hold',
      ...over,
    },
  });

  it('compiles it into one rule with both branches', async () => {
    const out = await compileWith(routed());
    assert.equal(out.status, 'compiled');
    if (out.status !== 'compiled') return;
    assert.equal(out.destination.type, 'routed');
    assert.deepEqual(
      out.destination.type === 'routed'
        ? out.destination.routes.map(r => r.destination)
        : null,
      [
        { type: 'email', email: 'anish@emiactech.com' },
        { type: 'email', email: 'rdx.omega2678@gmail.com' },
      ],
    );
  });

  it('defaults an unstated fallback to holding, never to a silent drop', async () => {
    const { otherwise: _drop, ...withoutFallback } = routed().destination;
    const out = await compileWith({ ...routed(), destination: withoutFallback });
    assert.equal(out.status, 'compiled');
    assert.equal(
      out.status === 'compiled' && out.destination.type === 'routed'
        ? out.destination.otherwise
        : null,
      'hold',
    );
  });

  it('keeps a named fallback, which is a recipient like any other', async () => {
    const out = await compileWith(routed({
      otherwise: { type: 'email', email: 'everything-else@emiactech.com' },
    }));
    assert.deepEqual(
      out.status === 'compiled' && out.destination.type === 'routed'
        ? out.destination.otherwise
        : null,
      { type: 'email', email: 'everything-else@emiactech.com' },
    );
  });

  /*
   * Refused, not trimmed. A table that quietly lost a branch, or had a mixed
   * one repaired, is a rule that sends somebody's mail to the wrong colleague
   * while reporting that Divo understood the sentence.
   */
  it('refuses a table the runtime would not accept', async () => {
    const cases = [
      // One branch — that is a plain destination with a model call in front.
      { routes: [{ key: 'invoices', when: 'an invoice', destination: { type: 'email', email: 'a@b.com' } }] },
      // Mixed kinds: one rule cannot be both a forward and a Lark delivery.
      { routes: [
        { key: 'invoices', when: 'an invoice', destination: { type: 'email', email: 'a@b.com' } },
        { key: 'product', when: 'the product', destination: { type: 'lark_chat', chatId: 'oc_1' } },
      ] },
      // Two branches no answer could tell apart.
      { routes: [
        { key: 'invoices', when: 'an invoice', destination: { type: 'email', email: 'a@b.com' } },
        { key: 'invoices', when: 'a bill', destination: { type: 'email', email: 'c@d.com' } },
      ] },
      // `none` is the answer that means "nothing fits".
      { routes: [
        { key: 'none', when: 'an invoice', destination: { type: 'email', email: 'a@b.com' } },
        { key: 'product', when: 'the product', destination: { type: 'email', email: 'c@d.com' } },
      ] },
      // Seven branches.
      { routes: Array.from({ length: 7 }, (_, i) => ({
        key: `k${i}`, when: `kind number ${i}`, destination: { type: 'email', email: `a${i}@b.com` },
      })) },
    ];
    for (const over of cases) {
      const out = await compileWith(routed(over));
      assert.equal(out.status, 'unclear', `${JSON.stringify(over).slice(0, 60)} must not compile`);
    }
  });

  it('refuses a table that also carries a question', async () => {
    // Two AI steps with no stated order between them. `parseMailRule` refuses
    // the pair outright, so compiling it would produce a draft that cannot be
    // saved — a worse answer than a sentence.
    const out = await compileWith({
      ...routed(),
      judge: { question: 'Is this actually from the client?' },
    });
    assert.equal(out.status, 'unclear');
  });

  it('reads a routed reply out of a code fence', async () => {
    // JSON mode is the guarantee and `extractJson` is the salvage path. The
    // longest, most structured output this prompt produces is exactly where a
    // fenced reply used to cost somebody their rule.
    const out = await createMailRuleCompiler({
      model: {
        specificationVersion: 'v2',
        provider: 'test',
        modelId: 'test',
        supportedUrls: {},
        doGenerate: async () => ({
          content: [{
            type: 'text',
            text: '```json\n' + JSON.stringify(routed()) + '\n```',
          }],
          finishReason: 'stop',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          warnings: [],
        }),
        doStream: async () => { throw new Error('not used'); },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    })({ sentence: 'test', mailboxEmail: 'abhishek@emiactech.com' });
    assert.equal(out.status, 'compiled');
  });
});
