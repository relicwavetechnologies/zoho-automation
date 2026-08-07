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
