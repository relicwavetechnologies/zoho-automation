/**
 * A sentence, turned into the conditions a rule actually runs on.
 *
 * "Forward anything from acme.com with an invoice attached to books@cpa.com,
 * but skip their noreply address" → a match, a destination, a ceiling.
 *
 * THE RULE THIS FILE IS BUILT AROUND: never guess. A guessed rule is wrong
 * while being reported as right, and the person approving it has no way to
 * tell — they asked Divo to read their sentence and it said it had. So a
 * sentence naming a brand with no domain, or an address that is not an
 * address, comes back `unclear` with the specific thing that is missing. That
 * is a worse demo and a better product.
 *
 * The output is validated against `mailRuleMatchSchema` — the same `.strict()`
 * schema the tool and the route validate against — before it is returned. A
 * model that invents a field, or writes `subject` where the rule says
 * `subjectContains`, produces `unclear` rather than a half-understood rule.
 * Nothing here can widen what a rule may say.
 *
 * It compiles and returns. It does not create: what comes back is a draft the
 * member edits and confirms, and the conditions it produces are the same
 * editable chips they would have filled in by hand.
 */
import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';
import { mailRuleMatchSchema } from './mail-rule.matcher';
import { mailRuleJudgeSchema } from './mail-ops.types';
import type { MailRuleJudge, MailRuleMatch } from './mail-ops.types';

export type MailRuleCompilation =
  | {
      status: 'compiled';
      name: string;
      match: MailRuleMatch;
      destination:
        | { type: 'email'; email: string }
        | { type: 'lark_dm' }
        | { type: 'organize'; label?: string; archive?: boolean; markRead?: boolean };
      rateLimitPerHour?: number;
      /**
       * The part of the sentence no filter can express, kept as a question.
       *
       * Absent unless the sentence actually asked for a judgement. Without this
       * the compiler had to refuse every request whose real content was one —
       * "contracts that actually need my signature" came back `unclear`, which
       * tells a member Divo cannot do the one thing the judge was built for.
       */
      judge?: MailRuleJudge;
      /** What Divo could not take from the sentence, in the member's words. */
      notes?: string[];
    }
  /** Said plainly, with the missing piece named. Never a partial rule. */
  | { status: 'unclear'; reason: string }
  | { status: 'unavailable'; reason: string };

const SYSTEM_PROMPT = `You turn one sentence into a Gmail automation rule for Divo.

Return ONLY JSON. No prose, no code fence.

Shape:
{"understood":true,"name":"...","match":{...},"destination":{...},"rateLimitPerHour":5,"judge":{"question":"...","onFailure":"closed"},"notes":["..."]}
or
{"understood":false,"reason":"..."}

MATCH — use only these keys, omit any you were not told:
  from                 one sender, or "@domain" for a whole domain
  to                   an address the mail was sent to
  subjectContains      a phrase, or an array of phrases (any one counts)
  bodyContains         a phrase, or an array of phrases
  hasAttachment        true or false
  notFrom              a sender to exclude
  notSubjectContains   a phrase, or array, to exclude
  activeWindow         {"days":["mon"],"start":"09:00","end":"18:00","timeZone":"Asia/Kolkata"}

Every condition must hold together. There is no "or" between different keys.
A leading @ covers the domain AND its subdomains: "@acme.com" also matches
"receipts@mail.acme.com".

DESTINATION — exactly one:
  {"type":"email","email":"someone@example.com"}   forwards the whole message
  {"type":"lark_dm"}                               messages the requester on Lark
  {"type":"organize","label":"Invoices","archive":true,"markRead":true}
                                                   files it in their own Gmail

rateLimitPerHour is optional, 1-1000, and only for email or lark_dm.

JUDGE — optional, and only when the sentence asks for something no filter can
decide. The match narrows by what a message *has*; the judge decides what a
message *means*. Divo reads each matched message and answers your question
before the destination runs; "no" stops it there.

  "invoices that are actually overdue"        -> match on the sender/subject,
                                                 judge "Is this invoice overdue?"
  "contracts that really need my signature"   -> judge "Does this contract need
                                                 the recipient's signature?"
  "only the urgent ones"                      -> judge "Is this urgent?"

Write the question so that YES means "go ahead". One question, answerable from
the message alone. Use onFailure:"open" only if the sentence says to let mail
through when Divo cannot decide; otherwise omit it and nothing is sent.

A judge is not a substitute for a match. Still name a sender or a subject —
without one the rule reads every message that arrives.

REFUSE with understood:false when:
- a sender or recipient is named as a brand but no address or domain is given
  ("from Amazon" — say you need the domain, e.g. @amazon.in)
- the destination is unclear or missing
- the sentence asks for something none of the fields above can express
  (matching "or" between conditions, replying, summarising, editing the message)

NEVER invent a domain, an address, a timezone or a phrase that is not in the
sentence. A rule that is wrong is worse than a question.

Put anything you deliberately dropped in "notes", one short sentence each.

The mailbox being watched is: {{MAILBOX}}. "me", "my inbox" and "us" mean it.`;

const responseSchema = z.union([
  z.object({
    understood: z.literal(true),
    name: z.string().trim().min(1).max(120),
    match: z.record(z.unknown()),
    destination: z.union([
      z.object({ type: z.literal('email'), email: z.string().trim().email() }),
      z.object({ type: z.literal('lark_dm') }),
      z.object({
        type: z.literal('organize'),
        label: z.string().trim().min(1).max(225).optional(),
        archive: z.boolean().optional(),
        markRead: z.boolean().optional(),
      }),
    ]),
    rateLimitPerHour: z.number().int().min(1).max(1000).optional(),
    judge: z.unknown().optional(),
    notes: z.array(z.string().trim().min(1)).max(6).optional(),
  }),
  z.object({
    understood: z.literal(false),
    reason: z.string().trim().min(1).max(400),
  }),
]);

/** A model that answers in a fence, or with a sentence before the JSON. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1]?.trim() ?? trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object in the reply.');
  return JSON.parse(body.slice(start, end + 1));
}

export interface MailRuleCompilerDeps {
  readonly model: LanguageModel;
}

export function createMailRuleCompiler(deps: MailRuleCompilerDeps) {
  return async function compileMailRule(input: {
    sentence: string;
    mailboxEmail: string;
  }): Promise<MailRuleCompilation> {
    let text: string;
    try {
      const result = await generateText({
        model: deps.model,
        system: SYSTEM_PROMPT.replace('{{MAILBOX}}', input.mailboxEmail),
        prompt: input.sentence,
        temperature: 0,
        maxOutputTokens: 800,
        abortSignal: AbortSignal.timeout(25_000),
      });
      text = result.text;
    } catch (cause) {
      // Distinct from "I did not understand". A model that could not be reached
      // says nothing about the sentence, and reporting it as unclear would send
      // somebody rewriting a request that was perfectly clear.
      return {
        status: 'unavailable',
        reason: cause instanceof Error && cause.name === 'TimeoutError'
          ? 'Divo took too long to read that. Try again, or set the conditions yourself.'
          : 'Divo could not read that just now. Try again, or set the conditions yourself.',
      };
    }

    let parsed: z.infer<typeof responseSchema>;
    try {
      parsed = responseSchema.parse(extractJson(text));
    } catch {
      return {
        status: 'unclear',
        reason: 'Divo could not turn that into a rule. Try naming the sender and where it should go.',
      };
    }

    if (!parsed.understood) return { status: 'unclear', reason: parsed.reason };

    // The last word on what a rule may say belongs to the schema the runtime
    // enforces, not to the model. An invented key or a misspelled one fails
    // here and becomes a question rather than a rule nobody can run.
    const match = mailRuleMatchSchema.safeParse(parsed.match);
    if (!match.success) {
      return {
        status: 'unclear',
        reason: 'Divo read that as conditions Mail Ops cannot express. Set them yourself below.',
      };
    }
    // An empty match would act on every message that arrives — almost never
    // what anybody meant, and expensive to discover after the fact.
    if (Object.keys(match.data).length === 0) {
      return {
        status: 'unclear',
        reason: 'That did not name anything to look for, so it would act on every message. Say who it is from, or what the subject contains.',
      };
    }

    /*
     * The judge answers to the runtime's schema too, and a malformed one is
     * refused rather than dropped.
     *
     * Dropping it would be the worst of the three outcomes: the member asked
     * for "only the ones that actually need me", and a rule that quietly lost
     * that question forwards everything it matched while reporting that it
     * understood. Silence is what this whole file exists to avoid.
     */
    let judge: MailRuleJudge | undefined;
    if (parsed.judge !== undefined && parsed.judge !== null) {
      const read = mailRuleJudgeSchema.safeParse(parsed.judge);
      if (!read.success) {
        return {
          status: 'unclear',
          reason: 'Divo could not turn that into a question it can ask about each message. Say what it should check, in one sentence.',
        };
      }
      judge = read.data;
    }

    return {
      status: 'compiled',
      name: parsed.name,
      match: match.data as MailRuleMatch,
      ...(judge ? { judge } : {}),
      // Cast only bridges `exactOptionalPropertyTypes`: zod emits
      // `label?: string | undefined` where the type wants optional-not-undefined.
      destination: parsed.destination as MailRuleCompilation extends { destination: infer D } ? D : never,
      ...(parsed.rateLimitPerHour !== undefined
        ? { rateLimitPerHour: parsed.rateLimitPerHour }
        : {}),
      ...(parsed.notes && parsed.notes.length > 0 ? { notes: parsed.notes } : {}),
    };
  };
}
