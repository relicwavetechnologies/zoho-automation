/**
 * The AI step, and the two ways it can be dangerously wrong.
 *
 * Both failure modes are silent, which is why they are pinned here rather than
 * left to a live run: a step that lets everything through looks exactly like a
 * step that is working, and a step that holds everything looks exactly like a
 * mailbox nobody is writing to.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  judgeAllowsDelivery,
  judgeFailurePolicy,
  mailRuleJudgeSchema,
  type MailMessageMetadata,
} from '../../src/application/mail-ops/mail-ops.types.ts';
import { createMailRuleJudge } from '../../src/application/mail-ops/mail-rule-judge.ts';
import { parseMailRule } from '../../src/application/mail-ops/mail-rule.matcher.ts';

const message: MailMessageMetadata = {
  from: 'billing@acme-supplies.com',
  to: 'rahul@emiactech.com',
  subject: 'Invoice #4471 — due 14 Aug',
  snippet: 'Please find attached the invoice for July services.',
};

/** A model that answers with whatever text it is given. */
const modelReturning = (text: string) => ({
  specificationVersion: 'v2' as const,
  provider: 'test',
  modelId: 'test',
  supportedUrls: {},
  async doGenerate() {
    return {
      content: [{ type: 'text' as const, text }],
      finishReason: 'stop' as const,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      warnings: [],
    };
  },
  doStream() { throw new Error('not used'); },
});

const modelThrowing = (error: Error) => ({
  ...modelReturning(''),
  async doGenerate(): Promise<never> { throw error; },
});

describe('mail rule judge', () => {
  describe('what a verdict means', () => {
    it('lets a pass through and stops a rejection', () => {
      assert.equal(
        judgeAllowsDelivery({ decision: 'passed', reason: 'A real invoice.' }),
        true,
      );
      assert.equal(
        judgeAllowsDelivery({ decision: 'rejected', reason: 'Marketing.' }),
        false,
      );
    });

    /*
     * The whole point of `onFailure`. An unreachable model must not quietly
     * become a pass — that would turn every rule with a step into a rule
     * without one at exactly the moment nobody is watching.
     */
    it('an unanswerable question follows the rule, and defaults to holding', () => {
      assert.equal(
        judgeAllowsDelivery({
          decision: 'unavailable', reason: 'timeout', appliedFailure: 'open',
        }),
        true,
      );
      assert.equal(
        judgeAllowsDelivery({
          decision: 'unavailable', reason: 'timeout', appliedFailure: 'closed',
        }),
        false,
      );
      // An `unavailable` verdict that somehow carries no policy is held. There
      // is no reading of "we do not know" that should send mail.
      assert.equal(
        judgeAllowsDelivery({ decision: 'unavailable', reason: 'timeout' }),
        false,
      );
    });

    it('a rule that never said what to do on failure holds', () => {
      assert.equal(judgeFailurePolicy({ question: 'Is this real?' }), 'closed');
      assert.equal(
        judgeFailurePolicy({ question: 'Is this real?', onFailure: 'open' }),
        'open',
      );
    });
  });

  describe('reading the model', () => {
    it('takes a yes with its reasoning and confidence', async () => {
      const judge = createMailRuleJudge({ model: modelReturning(
        '{"answer":true,"confidence":0.94,"reason":"Dated invoice with a total and a PDF."}',
      ) as never });

      assert.deepEqual(
        await judge({ judge: { question: 'Is this a real invoice?' }, message }),
        {
          decision: 'passed',
          reason: 'Dated invoice with a total and a PDF.',
          confidence: 0.94,
        },
      );
    });

    it('takes a no, and reads through a code fence', async () => {
      const judge = createMailRuleJudge({ model: modelReturning(
        '```json\n{"answer":false,"reason":"A webinar promotion with an unsubscribe link."}\n```',
      ) as never });

      const verdict = await judge({
        judge: { question: 'Is this a real invoice?' },
        message,
      });
      assert.equal(verdict.decision, 'rejected');
      assert.equal(verdict.reason, 'A webinar promotion with an unsubscribe link.');
    });

    /*
     * A malformed answer is emphatically not a "no".
     *
     * Reading it as a rejection would put an invented reason beside a message
     * the model never actually judged, and the member would have no way to tell
     * that apart from a real verdict — so it becomes `unavailable` and the
     * rule's own failure policy decides.
     */
    it('treats an unreadable answer as unavailable, not as a rejection', async () => {
      const judge = createMailRuleJudge({
        model: modelReturning('Sure! I think this one is fine.') as never,
      });

      const verdict = await judge({
        judge: { question: 'Is this a real invoice?', onFailure: 'open' },
        message,
      });
      assert.equal(verdict.decision, 'unavailable');
      assert.equal(verdict.appliedFailure, 'open');
      assert.equal(judgeAllowsDelivery(verdict), true);
    });

    it('an answer outside the schema is unavailable rather than coerced', async () => {
      const judge = createMailRuleJudge({ model: modelReturning(
        '{"answer":"probably","reason":"Hard to say."}',
      ) as never });

      const verdict = await judge({
        judge: { question: 'Is this a real invoice?' },
        message,
      });
      assert.equal(verdict.decision, 'unavailable');
      assert.equal(verdict.appliedFailure, 'closed');
    });

    it('a model that cannot be reached applies the rule’s policy', async () => {
      const judge = createMailRuleJudge({
        model: modelThrowing(new Error('connect ECONNREFUSED')) as never,
      });

      const verdict = await judge({
        judge: { question: 'Is this a real invoice?' },
        message,
      });
      assert.equal(verdict.decision, 'unavailable');
      assert.equal(verdict.appliedFailure, 'closed');
      assert.equal(judgeAllowsDelivery(verdict), false);
    });
  });

  describe('what a rule may store', () => {
    it('refuses a question too short to be one', () => {
      assert.equal(mailRuleJudgeSchema.safeParse({ question: 'real?' }).success, false);
    });

    it('refuses an unlisted field', () => {
      assert.equal(
        mailRuleJudgeSchema.safeParse({
          question: 'Is this a real invoice addressed to us?',
          fields: ['code'],
        }).success,
        // O-3: a rule may decide, and may not extract. A shape that could carry
        // an extraction request must not parse in the first place.
        false,
      );
    });

    /*
     * A stored judge that no longer parses must break the rule rather than be
     * skipped. Read leniently, a corrupted gate becomes a rule that silently
     * forwards everything it was written to hold back — and `parseMailRule`
     * throwing is what makes the rule report `broken` and stop.
     */
    it('a corrupt stored judge breaks the rule instead of disappearing', () => {
      const stored = {
        match: { from: 'alerts@example.com' },
        action: { type: 'forward' },
        destination: { type: 'email', email: 'owner@example.com' },
      };

      assert.equal(parseMailRule(stored).judge, undefined);
      assert.equal(parseMailRule({ ...stored, judge: null }).judge, undefined);
      assert.deepEqual(
        parseMailRule({
          ...stored,
          judge: { question: 'Is this a real invoice addressed to us?' },
        }).judge,
        { question: 'Is this a real invoice addressed to us?' },
      );
      assert.throws(() => parseMailRule({ ...stored, judge: { question: '' } }));
      assert.throws(() => parseMailRule({ ...stored, judge: 'yes please' }));
    });
  });
});

/**
 * What happens when the model's answer cannot be used.
 *
 * Two of ten judged messages came back unreadable during a live run, and every
 * one of them was held — `onFailure: closed` doing its job. That is the safe
 * outcome and it is also an invisible one: the reply that caused it was thrown
 * away, so a rule holding one message in five looked exactly like a rule with
 * nothing to hold. These pin the three things that changed.
 */
describe('when the answer cannot be used', () => {
  const capture = () => {
    const lines: Array<{ event: string; data: Record<string, unknown> }> = [];
    const log = {
      warn: (event: string, data: Record<string, unknown>) => lines.push({ event, data }),
      info: () => {}, error: () => {}, debug: () => {},
      child: () => log,
    };
    return { lines, log };
  };

  const judgeWith = (text: string) => {
    const { lines, log } = capture();
    return {
      lines,
      run: () => createMailRuleJudge({
        model: modelReturning(text) as never,
        logger: log as never,
      })({ judge: { question: 'Is this a real invoice?' }, message }),
    };
  };

  /*
   * The reply is the whole diagnosis, and it used to be discarded. It is Divo's
   * own answer about a message rather than any part of the message, which is
   * what makes it loggable at all.
   */
  it('records the reply it could not read', async () => {
    const { lines, run } = judgeWith('I think this is probably an invoice, yes.');
    const verdict = await run();

    assert.equal(verdict.decision, 'unavailable');
    const logged = lines.find(l => l.event === 'mail_ops.judge_unreadable');
    assert.ok(logged, 'the unreadable reply must be recorded');
    assert.match(String(logged.data['reply']), /probably an invoice/);
    assert.equal(logged.data['empty'], false);
  });

  /*
   * DeepSeek documents empty content as a known JSON-mode outcome. Reporting it
   * as "answered in a way this rule could not read" sends somebody rewriting a
   * question that was never answered at all.
   */
  it('says nothing came back, rather than blaming the answer', async () => {
    const { lines, run } = judgeWith('');
    const verdict = await run();

    assert.equal(verdict.decision, 'unavailable');
    assert.match(verdict.reason, /returned nothing/);
    assert.equal(lines.find(l => l.event === 'mail_ops.judge_unreadable')?.data['empty'], true);
  });

  /*
   * A reply cut off mid-object is the failure the token budget was raised for.
   * It must still be reported rather than guessed at.
   */
  it('holds on a truncated reply instead of inventing a verdict', async () => {
    const verdict = await judgeWith('{"answer":true,"reason":"A dated invoice with a to').run();
    assert.equal(verdict.decision, 'unavailable');
    assert.equal(verdict.appliedFailure, 'closed');
  });

  /*
   * Valid JSON of the wrong shape. DeepSeek guarantees the syntax and nothing
   * about the fields, so this is a real outcome rather than a defensive branch.
   */
  it('refuses valid JSON that is not a verdict', async () => {
    for (const reply of [
      '{"answer":"yes","reason":"Looks like one."}',
      '{"answer":true,"confidence":4,"reason":"Certain."}',
      '{"answer":true}',
    ]) {
      const verdict = await judgeWith(reply).run();
      assert.equal(verdict.decision, 'unavailable', `${reply} must not become a verdict`);
    }
  });

  /*
   * The tolerance that came free with the old text path must not be lost to
   * gain the provider's JSON flag. A fenced reply is still a usable verdict,
   * and it is recorded so the frequency is visible rather than invisible.
   */
  it('still salvages a fenced reply, and says that it did', async () => {
    const { lines, run } = judgeWith(
      '```json\n{"answer":false,"reason":"A webinar promotion, not an invoice."}\n```',
    );
    const verdict = await run();

    assert.equal(verdict.decision, 'rejected');
    assert.ok(lines.some(l => l.event === 'mail_ops.judge_salvaged'));
  });
});

/**
 * The reason this step uses `generateObject` at all.
 *
 * Asking for JSON in a prompt is a request. Only this path sets
 * `responseFormat` on the call, which `@ai-sdk/deepseek` turns into
 * `response_format: {type: 'json_object'}` on the wire — the provider's own
 * guarantee that the reply is syntactically valid JSON. `generateText` never
 * sets it, with or without an output helper, so a well-meaning switch back to
 * it would quietly remove the guarantee and leave every other line here
 * passing.
 */
describe('what actually reaches the provider', () => {
  const callOptions = async () => {
    let seen: Record<string, unknown> | undefined;
    const model = {
      specificationVersion: 'v2' as const,
      provider: 'test', modelId: 'test', supportedUrls: {},
      async doGenerate(options: Record<string, unknown>) {
        seen = options;
        return {
          content: [{ type: 'text' as const, text: '{"answer":true,"reason":"A dated invoice."}' }],
          finishReason: 'stop' as const,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          warnings: [],
        };
      },
      doStream() { throw new Error('not used'); },
    };
    await createMailRuleJudge({ model: model as never })({
      judge: { question: 'Is this a real invoice?' }, message,
    });
    return seen ?? {};
  };

  it('asks for JSON at the provider, not only in the prompt', async () => {
    const format = (await callOptions())['responseFormat'] as { type?: string } | undefined;
    assert.equal(format?.type, 'json');
  });

  /*
   * The budget a truncated reply is invalid JSON because of. DeepSeek's own
   * guidance is to set it generously; 300 had to cover a 600-character reason
   * plus the JSON around it.
   */
  it('leaves room for the longest reason the schema allows', async () => {
    assert.ok(Number((await callOptions())['maxOutputTokens']) >= 700);
  });
});
