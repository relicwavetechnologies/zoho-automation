/**
 * The step that chooses a recipient.
 *
 * `mail-rule-judge.ts` used to say, in its own header, that this could never
 * happen — and the sentence it said it in named the reason: *never send it
 * somewhere nobody chose*. That property is kept, and this file is where it is
 * pinned. Everything here is one of two questions:
 *
 *   · can an answer reach a person the member did not write down?
 *   · when the answer is missing or unusable, where does the message go?
 *
 * Both failures are silent in production. A message routed to the wrong
 * colleague looks exactly like a message routed to the right one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  judgedDestination,
  type MailJudgeVerdict,
  type MailMessageMetadata,
  type MailRuleDestination,
} from '../../src/application/mail-ops/mail-ops.types.ts';
import { createMailRuleJudge } from '../../src/application/mail-ops/mail-rule-judge.ts';
import { parseMailRule } from '../../src/application/mail-ops/mail-rule.matcher.ts';
import { MailOpsWorker } from '../../src/application/mail-ops/mail-ops.worker.ts';

const message: MailMessageMetadata = {
  from: 'client@google.com',
  to: 'abhishek@emiactech.com',
  subject: 'Invoice #4471 — due 14 Aug',
  snippet: 'Please find attached the invoice for July services.',
  bodyText: 'Please find attached the invoice for July services.',
  hasAttachment: true,
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

const ROUTES = [
  {
    key: 'invoices',
    when: 'an invoice, bill or payment request',
    destination: { type: 'email' as const, email: 'anish@emiactech.com' },
  },
  {
    key: 'product',
    when: 'about the product, a feature, a bug or development work',
    destination: { type: 'email' as const, email: 'rdx@emiactech.com' },
  },
];

const table = (
  otherwise: MailRuleDestination extends { otherwise: infer O } ? O : never =
    'hold' as never,
): MailRuleDestination => ({ type: 'routed', routes: ROUTES, otherwise });

const judgeWith = (text: string) =>
  createMailRuleJudge({ model: modelReturning(text) as never });

describe('a judge that names a branch', () => {
  it('returns the branch the model chose', async () => {
    const verdict = await judgeWith(JSON.stringify({
      route: 'invoices',
      confidence: 0.9,
      reason: 'It carries an invoice number and a due date.',
    }))({ routes: ROUTES, message });

    assert.equal(verdict.decision, 'routed');
    assert.equal(verdict.route, 'invoices');
    assert.equal(verdict.confidence, 0.9);
  });

  /*
   * The safety case, stated as a test.
   *
   * The response schema is built per call from this rule's own keys, so a key
   * the rule does not carry cannot parse. What must never happen is a repair
   * into the nearest match, or a silent fall to the first branch — either would
   * send somebody's mail to a person on the strength of a made-up word.
   */
  it('refuses a branch this rule does not have, rather than guessing at one', async () => {
    const verdict = await judgeWith(JSON.stringify({
      route: 'finance',
      reason: 'Looks like a finance thing.',
    }))({ routes: ROUTES, message });

    assert.equal(verdict.decision, 'unavailable');
    assert.notEqual(verdict.route, 'finance');
    // And it must not resolve to a recipient either.
    assert.equal(judgedDestination(table(), verdict), null);
  });

  it('takes "none" as a real answer', async () => {
    // The model is told to prefer this over guessing, so it has to be a first
    // class answer rather than something that reads as a failure.
    const verdict = await judgeWith(JSON.stringify({
      route: 'none',
      reason: 'A calendar invitation, which is neither of those kinds.',
    }))({ routes: ROUTES, message });

    assert.equal(verdict.decision, 'routed');
    assert.equal(verdict.route, 'none');
  });

  it('reads a choice through a code fence', async () => {
    // JSON mode is the guarantee; `salvage` is what catches the reply that
    // arrives despite it. The yes/no judge has this and the routed one must not
    // quietly have weaker handling.
    const verdict = await judgeWith(
      '```json\n{"route":"product","reason":"A bug report against the beta."}\n```',
    )({ routes: ROUTES, message });

    assert.equal(verdict.decision, 'routed');
    assert.equal(verdict.route, 'product');
  });

  it('names no policy of its own when it cannot answer', async () => {
    /*
     * A routed rule has no `onFailure`. Its fallback is the member's own
     * `otherwise`, so claiming `appliedFailure: 'closed'` here would report a
     * policy this rule does not have — and would be wrong outright whenever
     * `otherwise` names somebody.
     */
    const verdict = await judgeWith('not json at all')({ routes: ROUTES, message });
    assert.equal(verdict.decision, 'unavailable');
    assert.equal(verdict.appliedFailure, undefined);
  });

  it('never puts a recipient in front of the model', async () => {
    /*
     * The model is shown keys and descriptions, never addresses. A sender who
     * can write into the preview is addressing this prompt directly, and should
     * not be able to learn who the branches reach — nor be given a name to ask
     * for.
     */
    let seen = '';
    const model = {
      ...modelReturning(JSON.stringify({ route: 'invoices', reason: 'An invoice.' })),
      async doGenerate(options: { prompt: unknown }) {
        seen = JSON.stringify(options.prompt);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ route: 'invoices', reason: 'An invoice.' }),
          }],
          finishReason: 'stop' as const,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          warnings: [],
        };
      },
    };
    await createMailRuleJudge({ model: model as never })({ routes: ROUTES, message });

    assert.ok(seen.includes('invoices'), 'the keys are shown');
    assert.ok(!seen.includes('anish@emiactech.com'), 'the recipient is not');
    assert.ok(!seen.includes('rdx@emiactech.com'), 'nor the other one');
  });
});

describe('where a verdict sends a message', () => {
  const verdict = (over: Partial<MailJudgeVerdict>): MailJudgeVerdict =>
    ({ decision: 'routed', reason: 'because', ...over });

  it('sends it to the branch that was named', () => {
    assert.deepEqual(
      judgedDestination(table(), verdict({ route: 'product' })),
      { type: 'email', email: 'rdx@emiactech.com' },
    );
  });

  it('holds what fits nothing, when that is what the member asked for', () => {
    assert.equal(judgedDestination(table(), verdict({ route: 'none' })), null);
  });

  it('sends what fits nothing to the person named for it', () => {
    const fallback = { type: 'email' as const, email: 'everything-else@emiactech.com' };
    assert.deepEqual(
      judgedDestination(table(fallback as never), verdict({ route: 'none' })),
      fallback,
    );
  });

  it('treats an unreadable answer exactly as "nothing fits"', () => {
    /*
     * This is what replaces `onFailure` on a routed rule. `otherwise: 'hold'`
     * *is* fail-closed and `otherwise: <someone>` is fail-open to a person the
     * member chose — so the two cases below are the whole of the policy.
     */
    const unusable = verdict({ decision: 'unavailable', reason: 'Divo did not answer in time.' });
    assert.equal(judgedDestination(table(), unusable), null);
    const fallback = { type: 'email' as const, email: 'everything-else@emiactech.com' };
    assert.deepEqual(judgedDestination(table(fallback as never), unusable), fallback);
  });

  it('falls back rather than picking a branch when the table has been edited under it', () => {
    // A stored verdict outlives the rule that produced it. `invoices` naming
    // nothing any more is the same fact as "nothing fits" — it is not a licence
    // to use whichever branch happens to be first.
    const narrowed: MailRuleDestination = {
      type: 'routed',
      routes: [ROUTES[1]!, {
        key: 'other',
        when: 'anything else at all',
        destination: { type: 'email', email: 'c@emiactech.com' },
      }],
      otherwise: 'hold',
    };
    assert.equal(judgedDestination(narrowed, verdict({ route: 'invoices' })), null);
  });

  it('leaves a rule with no routes exactly as it was', () => {
    const plain: MailRuleDestination = { type: 'email', email: 'one@emiactech.com' };
    assert.deepEqual(judgedDestination(plain, { decision: 'passed', reason: 'yes' }), plain);
    assert.equal(judgedDestination(plain, { decision: 'rejected', reason: 'no' }), null);
  });
});

describe('a routed rule cannot also carry a question', () => {
  it('refuses the pair rather than deciding which one wins', () => {
    assert.throws(() => parseMailRule({
      match: { from: '@client.com' },
      action: { type: 'forward' },
      destination: table() as unknown as Record<string, unknown>,
      judge: { question: 'Is this really an invoice?' },
    }), /already asks its own question/);
  });
});

/* ── The worker, driven end to end on one routed rule ──────────────────────── */

const logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: function() { return this; },
} as never;

const routedPayload = (otherwise: unknown = 'hold') => ({
  companyId: 'company-1',
  userId: 'user-1',
  subscriptionId: 'mailbox-1',
  connectionId: 'connection-1',
  mailboxEmail: 'abhishek@emiactech.com',
  ruleId: 'rule-1',
  eventId: 'event-1',
  sourceMessageId: 'message-1',
  idempotencyKey: 'mail:key',
  action: { type: 'forward' },
  destination: { type: 'routed', routes: ROUTES, otherwise },
  message,
});

const driveOneDelivery = async (input: {
  verdict: MailJudgeVerdict;
  otherwise?: unknown;
}) => {
  const sentTo: string[] = [];
  let held: { reason: string } | null = null;
  let recorded: Record<string, unknown> | null = null;
  let claimed = false;

  const worker = new MailOpsWorker({
    repo: {
      claimNextWatchRenewal: async () => ({ ok: true, value: null }),
      claimNextDueMailbox: async () => ({ ok: true, value: null }),
      claimNextDueDelivery: async () => {
        if (claimed) return { ok: true, value: null };
        claimed = true;
        return {
          ok: true,
          value: {
            deliveryId: 'delivery-1',
            attempts: 1,
            payload: routedPayload(input.otherwise ?? 'hold'),
          },
        };
      },
      isRuleSendable: async () => ({ ok: true, value: true }),
      markDeliveryHeld: async (arg: { reason: string }) => {
        held = { reason: arg.reason };
        return { ok: true, value: true };
      },
      recordJudgeVerdict: async (arg: { verdict: Record<string, unknown> }) => {
        recorded = arg.verdict;
        return { ok: true, value: true };
      },
      stageDeliveryDraft: async () => ({ ok: true, value: true }),
      markDeliveryDelivered: async () => ({ ok: true, value: true }),
      markDeliveryFailed: async () => ({ ok: true, value: true }),
      markDeliveryAbandoned: async () => ({ ok: true, value: true }),
      stripEventBodies: async () => ({ ok: true, value: 0 }),
      dropTerminalPayloads: async () => ({ ok: true, value: 0 }),
      deleteEventsBefore: async () => ({ ok: true, value: 0 }),
      recordReconciliation: async () => ({ ok: true, value: true }),
    },
    gmail: {
      createForwardDraft: async (arg: { destination: string }) => {
        sentTo.push(arg.destination);
        return 'draft-1';
      },
      sendForwardDraft: async () => 'sent-1',
    },
    resolveAccessToken: async () => 'access-token',
    authorizeRule: async () => ({ verdict: 'allowed' }),
    judgeMessage: async () => input.verdict,
    logger,
  } as never);

  await worker.runOnce();
  return { sentTo, held: held as { reason: string } | null, recorded };
};

describe('the worker delivers to the branch the verdict named', () => {
  it('forwards to that branch and to nobody else', async () => {
    const run = await driveOneDelivery({
      verdict: { decision: 'routed', route: 'product', reason: 'A bug report.' },
    });
    assert.deepEqual(run.sentTo, ['rdx@emiactech.com']);
    assert.equal(run.held, null);
  });

  it('writes where it went onto the row, not just which branch', async () => {
    /*
     * The routing table it was resolved against is frozen in a payload that is
     * swept off terminal rows at thirty days, and the rule's live table may be
     * edited at any time. Without the resolved address on the verdict there is
     * no honest way to tell a member months later where a message actually
     * went.
     */
    const run = await driveOneDelivery({
      verdict: { decision: 'routed', route: 'invoices', reason: 'An invoice.' },
    });
    assert.deepEqual(run.recorded?.['destination'], {
      type: 'email',
      email: 'anish@emiactech.com',
    });
  });

  it('holds a message that fits no branch, and sends nothing', async () => {
    const run = await driveOneDelivery({
      verdict: { decision: 'routed', route: 'none', reason: 'A calendar invite.' },
    });
    assert.deepEqual(run.sentTo, []);
    assert.equal(run.held?.reason, 'A calendar invite.');
  });

  it('sends what fits no branch to the person named for everything else', async () => {
    const run = await driveOneDelivery({
      verdict: { decision: 'routed', route: 'none', reason: 'A calendar invite.' },
      otherwise: { type: 'email', email: 'everything-else@emiactech.com' },
    });
    assert.deepEqual(run.sentTo, ['everything-else@emiactech.com']);
    assert.equal(run.held, null);
  });

  it('holds when the model could not answer and nobody was named for that', async () => {
    const run = await driveOneDelivery({
      verdict: { decision: 'unavailable', reason: 'Divo did not answer in time.' },
    });
    assert.deepEqual(run.sentTo, []);
    assert.equal(run.held?.reason, 'Divo did not answer in time.');
  });
});
