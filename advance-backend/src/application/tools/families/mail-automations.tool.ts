import { z } from 'zod';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../shared/result';
import { err, ok } from '../../../shared/result';
import { PermissionError, ToolError } from '../../../shared/errors';
import type { PermissionResult } from '../../permissions/permission.types';
import type { ToolActionGroup } from '../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../shared/ids';
import type { MailOpsRepository } from '../../../infrastructure/persistence/mail-ops.repository';
import type {
  BeginGoogleWorkspaceAuthorization,
  GoogleWorkspaceMcpConnectionChoice,
} from './google-workspace-mcp.tool';
import { SELF_SERVICE_CONNECT_HINT } from './google-workspace-mcp.tool';
import { mailRuleMatchSchema, parseMailRule } from '../../mail-ops/mail-rule.matcher';
import {
  mailRuleActionGroup,
  mailRulePermission,
  mailRuleRefusal,
} from '../../mail-ops/mail-rule-permission';
import {
  dryRunMailRule,
  type MailRuleDryRunEvent,
} from '../../mail-ops/mail-rule-dry-run';
import {
  mailRuleDedupeKey, mailRuleJudgeSchema,
} from '../../mail-ops/mail-ops.types';
import type { MailRuleAction, MailRuleIdentity } from '../../mail-ops/mail-ops.types';
import type {
  AuthorizeLarkChatDestination,
  LarkChatDestinationVerdict,
} from '../../mail-ops/lark-chat-destination';

const destinationSchema = z.union([
  z.object({ type: z.literal('email'), email: z.string().email() }).strict(),
  z.object({ type: z.literal('current_lark_chat') }).strict(),
  /**
   * The requester's own Lark DM. No id, because the runtime supplies it from
   * the run's own identity — a model naming an open id would be naming a
   * person, and the one person this may ever reach is whoever asked.
   */
  z.object({ type: z.literal('lark_dm') }).strict(),
  z.object({
    type: z.literal('lark_chat'),
    chatId: z.string().trim().min(1),
  }).strict(),
  /**
   * Filing mail where it already is. No address, because nothing leaves the
   * mailbox — this is the destination a rule has when the answer to "where does
   * it go" is "nowhere, it stays here and gets tidied".
   */
  z.object({
    type: z.literal('organize'),
    label: z.string().trim().min(1).max(225).optional(),
    archive: z.boolean().optional(),
    markRead: z.boolean().optional(),
  }).strict().refine(
    value => value.label !== undefined
      || value.archive === true
      || value.markRead === true,
    {
      message: 'Say what to do with the message: label, archive, or markRead.',
    },
  ),
]);

/**
 * How many messages an hour this rule may send.
 *
 * Only meaningful when something is being sent, which is why it sits beside the
 * destination rather than inside the match: an `organize` rule has no ceiling
 * because filing a member's own mail floods nobody.
 */
const rateLimitPerHourSchema = z.number().int().min(1).max(1000).optional();

/**
 * The rule's optional AI step, offered on the same terms the browser offers it.
 *
 * Here rather than only on the web route because the two surfaces have to be
 * able to build the same rule. A member who asks Divo in Lark to "forward real
 * invoices, not the marketing ones" and gets a rule with no step would have
 * been given a rule that forwards the marketing ones — and no way to tell,
 * short of watching their finance inbox fill up.
 */
const judgeSchema = mailRuleJudgeSchema.optional();

export const mailAutomationsArgsSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('create'),
    connectionId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    match: mailRuleMatchSchema,
    destination: destinationSchema,
    rateLimitPerHour: rateLimitPerHourSchema,
    judge: judgeSchema,
  }).strict(),
  z.object({
    operation: z.literal('list'),
    includeInactive: z.boolean().optional(),
  }).strict(),
  z.object({
    operation: z.literal('test'),
    ruleId: z.string().uuid(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),
  z.object({
    operation: z.literal('update'),
    ruleId: z.string().uuid(),
    connectionId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    match: mailRuleMatchSchema,
    destination: destinationSchema,
    rateLimitPerHour: rateLimitPerHourSchema,
    judge: judgeSchema,
  }).strict(),
  z.object({
    operation: z.literal('pause'),
    ruleId: z.string().uuid(),
  }).strict(),
  z.object({
    operation: z.literal('resume'),
    ruleId: z.string().uuid(),
  }).strict(),
  z.object({
    operation: z.literal('archive'),
    ruleId: z.string().uuid(),
  }).strict(),
]);

type Args = z.infer<typeof mailAutomationsArgsSchema>;

const ruleSummarySchema = z.object({
  ruleId: z.string(),
  name: z.string(),
  status: z.string(),
  mailboxEmail: z.string(),
  connectionId: z.string(),
  match: z.record(z.unknown()),
  action: z.record(z.unknown()),
  destination: z.record(z.unknown()),
  /**
   * The rule's AI step, and it must be listed here or it does not survive.
   *
   * Every tool result is re-parsed against this schema and the *parsed* value is
   * what the model sees, so zod's default strip silently drops any key missing
   * from it. Left out, `list` would answer without `judge` while the tool's own
   * instructions tell the model to read it from `list` and carry it forward —
   * so renaming a rule in Lark would delete the question that was doing the
   * work, with nothing anywhere saying so.
   */
  judge: z.record(z.unknown()).nullable().optional(),
  createdAt: z.string(),
  valid: z.boolean(),
  invalidReason: z.string().optional(),
});

const resultSchema = z.object({
  success: z.boolean(),
  operation: z.enum([
    'create',
    'list',
    'test',
    'update',
    'pause',
    'resume',
    'archive',
  ]),
  code: z.enum([
    'google_workspace_authorization_pending',
    'google_workspace_connection_selection_required',
    'mail_ops_configuration_required',
  ]).optional(),
  intentId: z.string().optional(),
  connections: z.array(z.object({
    connectionId: z.string(),
    label: z.string(),
    accountEmail: z.string().optional(),
    accountName: z.string().optional(),
    access: z.enum(['read_only', 'read_write', 'admin']),
  })).optional(),
  rule: ruleSummarySchema.optional(),
  rules: z.array(ruleSummarySchema).optional(),
  dryRun: z.object({
    ruleId: z.string(),
    name: z.string(),
    mailboxEmail: z.string(),
    consideredCount: z.number(),
    matchedCount: z.number(),
    predatingCount: z.number(),
    bodyUnavailableCount: z.number(),
    matched: z.array(z.object({
      occurredAt: z.string(),
      from: z.string(),
      subject: z.string(),
      predatesRule: z.boolean(),
    })),
  }).optional(),
  /**
   * What was already there when a `create` landed on a rule that exists.
   *
   * Declared here or it does not survive: every result is re-parsed against
   * this schema and a key it does not name is stripped without complaint.
   *
   * `create` is an upsert on the rule's own content, so asking for a rule that
   * already exists updates its name, its ceiling and its question, and brings
   * it back if it was paused or archived. The tool used to report all of that
   * as a plain creation, so an agent told a member it had made them a new rule
   * when what it had actually done was overwrite one — or resurrect one they
   * archived months ago.
   */
  existing: z.enum(['active', 'paused', 'archived']).nullable().optional(),
  /**
   * What question the rule carries after an `update`, declared for the same
   * reason and stripped without it.
   *
   * `update` replaces the judge rather than merging it, so an edit about
   * something else — a rename, a new address — removes it unless the caller
   * re-sent it. This is the answer to the call that did it, which is a better
   * place to notice than a warning read once at the top of the turn.
   */
  judge: z.record(z.unknown()).nullable().optional(),
  message: z.string().optional(),
});

type Res = z.infer<typeof resultSchema>;

export type MailAutomationConnectionResolution =
  | {
      status: 'resolved';
      connectionId: string;
      mailboxEmail: string;
    }
  | {
      status: 'choose_connection';
      connections: readonly GoogleWorkspaceMcpConnectionChoice[];
    }
  | {
      status: 'unavailable';
      reason: string;
      /**
       * Which of the four unavailable states this is. Carried separately from
       * the sentence so a caller can behave differently without matching on
       * prose — an account that exists but lacks a scope is not the same
       * problem as no account at all.
       */
      connectionState?: MailOpsConnectionState;
    };

export type MailOpsConnectionState =
  | 'none_accessible'
  | 'insufficient_access'
  | 'requested_not_accessible'
  | 'reauthorization_required';

/**
 * Four different problems with four different remedies.
 *
 * They used to share one sentence — "Connect or reconnect Google to continue" —
 * which sent a member with a scope-limited account off to connect an account
 * they already had, and a member with no account off to grant scopes on one
 * that did not exist.
 *
 * `reauthorization_required` is the newest and was the worst of the four to get
 * wrong: a revoked account is simply absent from the accessible list, so it fell
 * through to `none_accessible` and Divo told somebody looking straight at their
 * connected Gmail that they had never connected Google.
 */
export function mailOpsConnectionUnavailableMessage(
  state: MailOpsConnectionState,
): string {
  if (state === 'reauthorization_required') {
    return 'Google has ended Divo\'s authorisation on your connected account, so '
      + 'nothing can be read or sent with it until you sign in again. Reconnect '
      + 'Google — it is the same account, not a new one, and your existing rules '
      + 'resume once it is back.';
  }
  if (state === 'insufficient_access') {
    return 'Your Google account is connected but Divo cannot read, watch, and '
      + 'send mail with it — it is shared read-only or missing Gmail scopes. '
      + 'Reconnect it and grant the full Gmail access.';
  }
  if (state === 'requested_not_accessible') {
    return 'That connectionId is not a Google account you own, so Mail Ops '
      + 'cannot use it. Name one of your own connected accounts.';
  }
  return 'Mail Ops needs a Google account you own, with Gmail read, watch, '
    + 'and send access. Connect Google to continue.';
}

/**
 * Why a chat was refused, in terms the member can act on — except for the one
 * case that is not theirs to act on, which says so rather than sending them
 * off to fix a room in a company they cannot see.
 */
/**
 * What a person reads when their rule goes live.
 *
 * "Mail automation is active" alone is the whole of what the approver and the
 * requester were told, and it names nothing that was decided — least of all
 * where the mail now goes, which is the entire subject of the approval that
 * had to be granted for it. Naming the destination lets somebody catch a wrong
 * address in the confirmation rather than in a week of forwarded mail.
 */
function mailRuleActivatedMessage(destination: {
  readonly type: string;
  readonly email?: string;
}): string {
  if (destination.type === 'email' && destination.email) {
    return 'Mail automation is active. Matching mail is now forwarded whole to '
      + `${destination.email} — HTML, attachments and inline images kept as `
      + 'they were sent.';
  }
  // `lark_dm` names one recipient — the rule's own owner — and `lark_chat` a
  // room. Both leave the mailbox, and neither carries the mail itself, so they
  // read alike and must not fall through to the `organize` sentence below.
  if (destination.type === 'lark_chat' || destination.type === 'lark_dm') {
    const where = destination.type === 'lark_dm'
      ? 'your Divo chat'
      : 'the chosen Lark chat';
    return `Mail automation is active. Matching mail is now announced in ${where}`
      + ': sender, subject and a short preview, with a link to the message '
      + 'itself.';
  }
  return 'Mail automation is active. Matching mail is now organised in place, '
    + 'and nothing leaves the mailbox.';
}

/**
 * What `create` actually did, which is not always create.
 *
 * The operation is an upsert on the rule's own content, so a member asking for
 * a rule they already have gets that rule's name, ceiling and question
 * rewritten — and if it was paused or archived, restarted. Reporting every one
 * of those as "Mail automation is active" told an agent it had built something
 * new when it had overwritten, or resurrected, something the member had already
 * decided about. The archived case is the one that stings: a rule retired in
 * March comes back to life in August and starts moving mail again.
 */
/**
 * What a rule with a question does, said on the answer that created it.
 *
 * The recipe tells the model to explain that rejected mail is held rather than
 * lost, because a member who thinks it vanishes will not trust the step. The
 * tool's own confirmation said only where mail goes — so a rule whose entire
 * point was "only the real ones" was reported as an ordinary forward, and the
 * one sentence that makes the step trustworthy depended on the model
 * remembering to add it.
 */
const judgeAddendum = (judge: { readonly question: string } | undefined): string =>
  judge
    ? ` Before anything is sent, Divo asks “${judge.question}” of each matching `
      + 'message; anything it answers no to is held back and recorded with its '
      + 'reason, not deleted.'
    : '';

function mailRuleCreatedMessage(
  destination: { readonly type: string; readonly email?: string },
  existing: 'active' | 'paused' | 'archived' | null,
  judge?: { readonly question: string },
): string {
  const active = `${mailRuleActivatedMessage(destination)}${judgeAddendum(judge)}`;
  if (!existing) return active;
  const what = existing === 'archived'
    ? 'You already had this exact rule, archived. It has been brought back and '
      + 'is running again'
    : existing === 'paused'
      ? 'You already had this exact rule, paused. It is running again'
      : 'You already had this exact rule and it was already running. Nothing '
        + 'was duplicated';
  return `${what}, and its name, its hourly ceiling and its AI question now `
    + `match what you just asked for. ${active}`;
}

function larkChatRefusalMessage(verdict: LarkChatDestinationVerdict): string {
  if (verdict.status === 'other_company') {
    return 'That Lark chat belongs to a different company, so Divo will not '
      + 'deliver mail into it. Choose a chat in your own workspace.';
  }
  if (verdict.status === 'unavailable') {
    return `Divo could not check that Lark chat right now (${verdict.reason}). `
      + 'Try again shortly.';
  }
  return 'Divo has never seen that Lark chat, so it cannot confirm the chat '
    + 'belongs to your company. Add Divo to the chat and send one message '
    + 'there, or create the rule from inside the chat itself.';
}

type MailRepo = Pick<
  MailOpsRepository,
  | 'createRuleForMailbox'
  | 'listRulesForUser'
  | 'replaceRule'
  | 'setRuleStatus'
>;

// The mapping and the decision both live in `mail-rule-permission`, because
// the browser asks the same question of the same grants and the two answers
// have to be one answer. See the note there.
const actionFor = (operation: Args['operation']): ToolActionGroup =>
  mailRuleActionGroup(operation);

export function createMailAutomationsTool(deps: {
  repo: MailRepo;
  /**
   * Everything that has to be true for a created rule to actually run.
   *
   * These were two independent flags read in two different layers, and the
   * tool could only see one of them. With Pub/Sub configured and background
   * workers switched off — which is how a cloned environment boots — `create`
   * cheerfully answered "Mail automation is active" for a rule that nothing
   * would ever pick up.
   */
  runtime: MailOpsRuntime;
  resolveConnection(input: {
    companyId: string;
    userId: string;
    connectionId?: string;
    abortSignal?: AbortSignal;
  }): Promise<MailAutomationConnectionResolution>;
  beginAuthorization?: BeginGoogleWorkspaceAuthorization;
  /**
   * Grounds a named Lark chat against the company that would deliver into it.
   * Optional so the tool still constructs in tests and in deployments with no
   * Lark channel, where a `lark_chat` destination cannot be reached anyway.
   */
  authorizeLarkChat?: AuthorizeLarkChatDestination;
  /**
   * The stored operating policy for the Google connection a rule will run on.
   *
   * Asked against the *resolved* connection, not the one named in arguments:
   * `connectionId` is optional on `create`, and the gateway's own governance
   * short-circuits to "not governed" when it is absent — so a connection-owner
   * approval policy used to be bypassed by simply not naming the connection.
   */
  connectionApproval?(input: {
    readonly companyId: string;
    readonly connectionId: string;
    readonly action: 'execute';
  }): Promise<{ readonly kind: string; readonly message?: string }>;
  /**
   * Loads one rule and the recent mail on its mailbox, for `test`.
   *
   * Reaches the read repository rather than the write one, which is the whole
   * reason it is a separate dependency: a dry run must not be able to touch a
   * lease, a cursor, or a status even by accident.
   */
  dryRun?(input: {
    companyId: string;
    userId: string;
    ruleId: string;
    limit: number;
  }): Promise<Result<
    (Parameters<typeof dryRunMailRule>[0]['rule'] & {
      ruleId: string;
      name: string;
      mailboxEmail: string;
      events: MailRuleDryRunEvent[];
    }) | null,
    Error
  >>;
}): Tool<Args, Res> {
  return {
    id: asToolId('mailAutomations'),
    family: 'scheduling',
    actionGroups: new Set([
      'read',
      'create',
      'update',
      'delete',
      'execute',
    ]),
    argsSchema: mailAutomationsArgsSchema,
    resultSchema,
    description:
      'Create and manage durable Gmail-only rules that react to future inbox arrivals and forward the whole matching message to an email address or deliver it to a Lark chat.',
    parameterDocs: [
      'Gmail only. There is no Outlook, Microsoft 365, or IMAP support.',
      'Use this only for arrival-triggered mail rules: "whenever/when a matching email arrives".',
      'Use googleGmail for immediate mail reading, searching, drafting, sending, or one-time forwarding.',
      'Use scheduledWorkflows for time-triggered inbox work such as a daily summary.',
      'A rule delivers the entire message. It cannot extract a code, link, amount, or any part of the mail, and nothing it delivers is ever rewritten or summarised. When the user asks for "just the OTP" or similar, say the whole email arrives instead and continue; do not look for another Divo path that extracts it, because none exists. The optional judge below reads a message to decide yes or no, and that is the only reading any rule does.',
      'Only mail arriving in the INBOX triggers a rule. Mail that a Gmail filter archives, or that lands in Spam, is never seen.',
      'create requires name, a deterministic match, and one destination. Match supports from, to, subjectContains, bodyContains, hasAttachment, notFrom, notSubjectContains, and activeWindow; at least one of from, to, subjectContains, or bodyContains is required. from, to, and notFrom must each be one exact mailbox address or an exact @domain, never a brand or display-name substring.',
      'Match fields are combined with AND. There is no OR.',
      'notFrom and notSubjectContains exclude. They only narrow a rule that already has a positive match field; a rule of exclusions alone is rejected. An exclusion that cancels its own match, such as from=@acme.com with notFrom=@acme.com, is also rejected.',
      'activeWindow limits a rule to part of the week: {days?, start, end, timeZone}. start and end are 24-hour HH:MM local times, the window is half-open (09:00-18:00 includes 09:00 and excludes 18:00), and an end at or before start means overnight. timeZone is a required IANA name such as Asia/Kolkata. Ask the user which timezone if it is not obvious; never guess. It is judged on when the mail arrived, not when Divo processed it.',
      'subjectContains, bodyContains and notSubjectContains are literal case-insensitive substring tests — never regex or wildcards. To match any of several phrases, pass a list: subjectContains: ["OTP", "verification code"]. Do not write alternatives as "OTP|verification code"; a "|" is refused, because a subject line can legitimately contain one.',
      '@domain matches that domain and every subdomain, so @example.com covers alerts@example.com and receipts@mail.example.com. It never matches a lookalike: @example.com does not match billing@notexample.com. There is no way to ask for a domain without its subdomains.',
      'A bare registry such as @com or @co.uk is rejected, because with subdomains included it would match almost any sender. Name the organisation: @acme.co.uk.',
      'from, to, and notFrom accept what a user is likely to say: acme.com without the @, Alerts <alerts@acme.com> pasted from a mail client, mailto: prefixes, https://acme.com, a trailing dot, and any capitalisation. All are normalised. Pass the user\'s wording through rather than rewriting it yourself.',
      'A brand or team name alone — "Stripe", "the finance team" — is still rejected and is never guessed into a domain. When that happens, do not retry with an invented domain: ask the user for the sending address, or read one real message with googleGmail to find it.',
      'to matches the To, Cc, Bcc, and Delivered-To headers together, so mail the user was copied on counts. There is no separate cc field.',
      'hasAttachment is true only for an attached file; inline images such as signature logos do not count. hasAttachment alone is rejected.',
      'Unlisted match keys are rejected. Never invent a field such as cc or labelIs; if the user wants narrowing this tool cannot express, say so instead of creating a broader rule.',
      'destination=email forwards matching mail to that exact grounded address.',
      'Email forwarding preserves the original Gmail MIME content, including HTML, inline images, and attachments, inside a new message sent by the connected mailbox.',
      'destination=current_lark_chat delivers to the current Lark conversation; it is invalid outside Lark and is rejected on desktop and web.',
      'destination=lark_chat requires an exact chatId returned by governed Lark chat discovery. Never invent it. Lark delivery posts up to 20,000 characters of plain text with no HTML and no attachments.',
      'destination=organize sends nothing. It files the message in the user\'s own Gmail: label applies a Gmail label and creates it if missing, archive removes it from the inbox, markRead marks it read. Set at least one. Use this for "label these", "auto-archive these", "keep these out of my inbox" — never for anything that has to reach another person.',
      'rateLimitPerHour caps how many messages one rule may send in a rolling hour, 1-1000. It applies to email and Lark destinations only. Over the cap the message is dropped and recorded, not queued, so nothing is delivered late in a burst. Offer it when a rule could match a busy sender or a mailing list.',
      'test replays a rule against mail Divo already recorded for that mailbox and reports what it would have matched. It sends nothing and changes nothing. Use it before telling the user a new or edited rule is right, and when they ask why a rule is quiet. An empty result on a new mailbox means Divo has no recorded mail yet, not that the rule is wrong.',
      'connectionId is optional only when exactly one eligible user-owned Google account exists. If several exist the tool returns google_workspace_connection_selection_required with a connections list; that is a normal step, not a failure. Retry with one exact returned connectionId.',
      'No LLM runs for matching or delivery unless the rule has a judge. Do not request per-message approval after the user creates the rule.',
      'judge is an optional AI step that runs after the match and before the action: {question, onFailure?}. Divo asks the question of each matched message and only acts when the answer is yes. A rejected message is recorded as held with the reason, and is visible to the user; nothing is sent.',
      'Offer judge whenever the user describes what they want in terms a substring cannot express — "real invoices, not marketing", "actual customer complaints", "only the ones that need me to reply". A match alone will catch the wrong mail there, and the user will not find out until it has been forwarding for a week.',
      'Write question as one closed yes/no question about a single message, in the user\'s own terms: "Is this a real invoice addressed to us, rather than marketing, a quote, or a reminder for something already paid?" Never write an instruction, a list of steps, or anything that asks for a value out of the message.',
      'The judge sees only headers and a short preview, never the full body and never attachments. Do not promise the user it can answer questions that need the whole document, such as "is the total over 50,000".',
      'The judge cannot change where mail goes, and cannot pick a recipient. It only decides whether the rule acts at all.',
      'onFailure says what happens when the model cannot answer — open acts anyway, closed sends nothing. It defaults to closed. Use open only when the rule exists to cut noise and the user would rather have a false forward than a missed message; never use open on a rule whose destination is outside the company.',
      'A judge costs a model call per matched message, so narrow the match first. Adding notFrom for a noisy no-reply address is free and stops those messages before the judge ever runs.',
      'update replaces judge too rather than merging it, so a rule that had one loses it unless you re-send it. Read the current value from that rule\'s judge in list and carry it forward unless the user asked to change or remove it.',
      'list returns valid for every rule, plus invalidReason when valid is false, meaning that rule matches no mail and needs repair. Report those instead of presenting them as working.',
      'list hides paused and archived rules unless includeInactive is true.',
      'list, pause, resume, and archive operate only on rules owned by the authenticated user. Never invent ruleId.',
      'update replaces the complete deterministic match and destination for one rule; include the ruleId, connectionId, and name returned by list. update also resumes a paused rule.',
      'update replaces rateLimitPerHour too rather than merging it, so a rule that had a cap loses it unless you re-send it. Read the current value from that rule\'s action.rateLimitPerHour in list and carry it forward unless the user asked to change or remove it.',
      'archive is final: an archived rule cannot be resumed.',
    ].join('\n'),

    permissionCheck(
      args: Args,
      permission: PermissionResult,
    ): Result<ToolActionGroup, PermissionError> {
      const action = actionFor(args.operation);
      const grantedActions = permission.allowedActionsByTool
        .get(asToolId('mailAutomations'));
      const verdict = mailRulePermission(args.operation, grantedActions);
      return verdict.allowed
        ? ok(action)
        : err(new PermissionError({
            toolId: 'mailAutomations',
            // The action actually withheld, not the one asked for: reporting
            // `create` when what is missing is background `execute` sends
            // somebody asking for access they already have.
            action: verdict.missing === 'execute' ? 'execute' : action,
            reason: 'not_allowed',
            message: mailRuleRefusal(args.operation, verdict.missing),
          }));
    },

    async execute(
      args: Args,
      ctx: ToolExecutionContext,
    ): Promise<Result<Res, ToolError>> {
      try {
        if (args.operation === 'list') {
          const listed = await deps.repo.listRulesForUser({
            companyId: String(ctx.runContext.companyId),
            userId: String(ctx.runContext.userId),
            includeInactive: args.includeInactive ?? false,
          });
          if (!listed.ok) throw listed.error;
          return ok({
            success: true,
            operation: 'list',
            rules: listed.value.map(rule => {
              const validity = storedRuleValidity(rule);
              return {
                ...rule,
                createdAt: rule.createdAt.toISOString(),
                ...validity,
              };
            }),
          });
        }

        if (args.operation === 'test') {
          if (!deps.dryRun) {
            return err(new ToolError({
              toolId: 'mailAutomations',
              reason: 'unrecoverable',
              message: 'Testing a mail rule is not available in this Divo '
                + 'environment.',
            }));
          }
          const loaded = await deps.dryRun({
            companyId: String(ctx.runContext.companyId),
            userId: String(ctx.runContext.userId),
            ruleId: args.ruleId,
            limit: args.limit ?? 50,
          });
          if (!loaded.ok) throw loaded.error;
          if (loaded.value === null) {
            return err(new ToolError({
              toolId: 'mailAutomations',
              reason: 'bad_args',
              message: 'Mail automation rule was not found in your account.',
            }));
          }
          const outcome = dryRunMailRule({
            rule: loaded.value,
            events: loaded.value.events,
          });
          if (outcome.status === 'rule_invalid') {
            return ok({
              success: false,
              operation: 'test',
              message: `This rule cannot run as written: ${outcome.reason}`,
            });
          }
          return ok({
            success: true,
            operation: 'test',
            dryRun: {
              ruleId: loaded.value.ruleId,
              name: loaded.value.name,
              mailboxEmail: loaded.value.mailboxEmail,
              consideredCount: outcome.consideredCount,
              matchedCount: outcome.matched.length,
              predatingCount: outcome.predatingCount,
              bodyUnavailableCount: outcome.bodyUnavailableCount,
              matched: outcome.matched.map(hit => ({
                occurredAt: hit.occurredAt.toISOString(),
                from: hit.from,
                subject: hit.subject,
                predatesRule: hit.predatesRule,
              })),
            },
            message: dryRunSummary(
              outcome.consideredCount,
              outcome.matched.length,
              outcome.bodyUnavailableCount,
            ),
          });
        }

        if (args.operation === 'resume' && !mailOpsReady(deps.runtime)) {
          return ok(mailOpsConfigurationRequired(args.operation, deps.runtime));
        }

        if (
          args.operation === 'pause'
          || args.operation === 'resume'
          || args.operation === 'archive'
        ) {
          const status = args.operation === 'resume'
            ? 'active'
            : args.operation === 'pause'
              ? 'paused'
              : 'archived';
          const changed = await deps.repo.setRuleStatus({
            companyId: String(ctx.runContext.companyId),
            userId: String(ctx.runContext.userId),
            ruleId: args.ruleId,
            status,
          });
          if (!changed.ok) throw changed.error;
          /*
           * Checked before the falsy test, because `'archived'` is truthy and
           * would otherwise be reported to the member as a completed pause.
           */
          if (changed.value === 'archived') {
            return err(new ToolError({
              toolId: 'mailAutomations',
              reason: 'bad_args',
              message:
                'That rule is archived, and archiving is final — it cannot be paused or '
                + 'restarted. Create a new rule with the same conditions instead.',
            }));
          }
          if (!changed.value) {
            return err(new ToolError({
              toolId: 'mailAutomations',
              reason: 'bad_args',
              message: 'Mail automation rule was not found in your account.',
            }));
          }
          return ok({
            success: true,
            operation: args.operation,
            message: `Mail automation ${args.operation} completed.`,
          });
        }

        if (!mailOpsReady(deps.runtime)) {
          return ok(mailOpsConfigurationRequired(args.operation, deps.runtime));
        }

        const connection = await deps.resolveConnection({
          companyId: String(ctx.runContext.companyId),
          userId: String(ctx.runContext.userId),
          ...(args.connectionId ? { connectionId: args.connectionId } : {}),
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
        });
        if (connection.status === 'choose_connection') {
          return ok({
            success: false,
            operation: args.operation,
            code: 'google_workspace_connection_selection_required',
            connections: [...connection.connections],
            message: 'Choose one user-owned Google account for this rule.',
          });
        }
        if (connection.status === 'unavailable') {
          if (deps.beginAuthorization) {
            const authorization = await deps.beginAuthorization({
              toolId: 'mailAutomations',
              reason: connection.reason,
              runContext: ctx.runContext,
            });
            if (authorization.status !== 'unavailable') {
              return ok({
                success: false,
                operation: args.operation,
                code: 'google_workspace_authorization_pending',
                intentId: authorization.intentId,
                message:
                  'The Google connection card was sent. End this run now; '
                  + 'Divo will start a fresh run automatically after OAuth completes.',
              });
            }
          }
          // No card is coming: either this run has no conversation to send one
          // into (a desktop session), or delivery failed. Either way the member
          // can still do it themselves, and saying so is the difference between
          // a dead end and an instruction.
          return err(new ToolError({
            toolId: 'mailAutomations',
            reason: 'unrecoverable',
            message: `${connection.reason} ${SELF_SERVICE_CONNECT_HINT}`,
          }));
        }

        // Creating a rule is not one action — it authorizes unbounded future
        // background execution on this connection. A policy that gates
        // `execute` has to gate the act of granting it, or the gate means
        // nothing: approval is asked per interactive call, and a rule makes
        // calls nobody is present for.
        if (deps.connectionApproval) {
          const policy = await deps.connectionApproval({
            companyId: String(ctx.runContext.companyId),
            connectionId: connection.connectionId,
            action: 'execute',
          });
          if (policy.kind === 'required') {
            return err(new ToolError({
              toolId: 'mailAutomations',
              reason: 'unrecoverable',
              message:
                'The owner of this Google connection requires approval before '
                + 'it runs anything in the background, and a mail rule runs '
                + 'with nobody present to approve it. Ask them to allow '
                + 'background execution on this connection first.',
            }));
          }
          if (policy.kind === 'unavailable') {
            return err(new ToolError({
              toolId: 'mailAutomations',
              reason: 'upstream_failure',
              message: policy.message
                ?? 'Divo could not read the connection policy. Try again shortly.',
            }));
          }
        }

        const destination = resolveDestination(args.destination, ctx);
        // A named chat is grounded here, in code, once — not on every delivery,
        // and not by asking the model nicely in prompt text, which is all that
        // stood between a rule and any room the bot could reach.
        if (args.destination.type === 'lark_chat' && deps.authorizeLarkChat) {
          const verdict = await deps.authorizeLarkChat({
            companyId: String(ctx.runContext.companyId),
            chatId: args.destination.chatId,
          });
          if (verdict.status !== 'allowed') {
            return err(new ToolError({
              toolId: 'mailAutomations',
              reason: verdict.status === 'unavailable' ? 'upstream_failure' : 'bad_args',
              message: larkChatRefusalMessage(verdict),
            }));
          }
        }
        const action = resolveAction(args.destination, args.rateLimitPerHour);
        const parsed = parseMailRule({
          match: args.match,
          action,
          destination,
        });
        // Built once, so the canonical key and the key this rule would have
        // carried before canonicalisation describe the very same request.
        const identity: MailRuleIdentity = {
          companyId: String(ctx.runContext.companyId),
          userId: String(ctx.runContext.userId),
          connectionId: connection.connectionId,
          ...parsed,
        };
        if (args.operation === 'update') {
          const updated = await deps.repo.replaceRule({
            companyId: String(ctx.runContext.companyId),
            userId: String(ctx.runContext.userId),
            ruleId: args.ruleId,
            connectionId: connection.connectionId,
            name: args.name,
            match: { ...parsed.match },
            action: { ...parsed.action },
            destination: { ...parsed.destination },
            // Omitted means removed, matching how `update` already treats the
            // rate limit and the match: this operation replaces the whole rule
            // rather than merging into it.
            judge: args.judge ? { ...args.judge } : null,
            dedupeKey: mailRuleDedupeKey(identity),
          });
          if (!updated.ok) throw updated.error;
          if (updated.value === 'not_found') {
            return err(new ToolError({
              toolId: 'mailAutomations',
              reason: 'bad_args',
              message:
                'Mail automation rule was not found for the selected account.',
            }));
          }
          if (updated.value === 'duplicate_archived') {
            return err(new ToolError({
              toolId: 'mailAutomations',
              reason: 'bad_args',
              message:
                'An archived rule on this mailbox already holds exactly that '
                + 'match and destination, and an archived rule keeps its place. '
                + 'Nothing was changed. Create the rule instead, which brings '
                + 'the archived one back, and archive this one if it is no '
                + 'longer wanted.',
            }));
          }
          if (updated.value === 'duplicate') {
            return err(new ToolError({
              toolId: 'mailAutomations',
              reason: 'bad_args',
              message:
                'That change would make this rule identical to another rule on '
                + 'the same mailbox, which would forward every matching message '
                + 'twice. Nothing was changed. List the rules to see the one it '
                + 'matches, and archive whichever of the two is not wanted.',
            }));
          }
          /*
           * The answer says whether the rule still has a question.
           *
           * `update` replaces the judge rather than merging it, so the commonest
           * way to destroy one is an edit about something else entirely —
           * "rename it", "change the address". The instructions warn about it,
           * and a warning read once at the top of a turn is weaker than the
           * answer to the call that did the damage. Now the result states which
           * of the two happened, so a model that dropped the question by
           * accident has something to notice.
           */
          return ok({
            success: true,
            operation: 'update',
            judge: args.judge ? { ...args.judge } : null,
            message: args.judge
              ? 'Mail automation update completed. This rule still asks its question '
                + 'before acting.'
              : 'Mail automation update completed. This rule has no AI question — if it '
                + 'had one before this edit, that question is now removed.',
          });
        }
        const created = await deps.repo.createRuleForMailbox({
          companyId: String(ctx.runContext.companyId),
          createdByUserId: String(ctx.runContext.userId),
          ...(ctx.runContext.departmentId
            ? { departmentId: String(ctx.runContext.departmentId) }
            : {}),
          connectionId: connection.connectionId,
          mailboxEmail: connection.mailboxEmail,
          name: args.name,
          match: { ...parsed.match },
          action: { ...parsed.action },
          destination: { ...parsed.destination },
          judge: args.judge ? { ...args.judge } : null,
          dedupeKey: mailRuleDedupeKey(identity),
        });
        if (!created.ok) throw created.error;
        const existing = created.value.existing;
        ctx.onProgress?.(existing
          ? 'Mail automation updated.'
          : 'Mail automation activated.');
        return ok({
          success: true,
          operation: 'create',
          rule: {
            ruleId: created.value.ruleId,
            name: args.name,
            status: 'active',
            mailboxEmail: connection.mailboxEmail,
            connectionId: connection.connectionId,
            match: { ...parsed.match },
            action: { ...parsed.action },
            destination: { ...parsed.destination },
            /*
             * Echoed for the same reason `list` echoes it, one call earlier.
             *
             * This object carries every other field of the rule and says
             * `valid: true`, so a model reading it has no reason to doubt it is
             * the whole rule. Leaving `judge` out meant an agent that created a
             * judge rule and then edited it in the same turn — "actually call it
             * X" — carried nothing forward and deleted the question it had just
             * been asked for. `null` rather than absent: "there is no question"
             * has to be distinguishable from "this answer did not mention one".
             */
            judge: args.judge ? { ...args.judge } : null,
            createdAt: new Date().toISOString(),
            valid: true,
          },
          existing,
          message: mailRuleCreatedMessage(parsed.destination, existing, args.judge),
        });
      } catch (cause) {
        return err(new ToolError({
          toolId: 'mailAutomations',
          reason: cause instanceof z.ZodError ? 'bad_args' : 'upstream_failure',
          cause,
          message: cause instanceof Error ? cause.message : String(cause),
        }));
      }
    },
  };
}

/**
 * The two boot-time conditions a mail rule depends on.
 *
 * `workersEnabled` mirrors `DIVO_AUTONOMOUS_WORKERS_ENABLED`, which is the
 * interlock that stops a cloned environment acting on the real mailboxes it
 * inherited. Nothing about a rule works while it is off, so the tool has to be
 * able to see it.
 */
export interface MailOpsRuntime {
  pubsubConfigured: boolean;
  workersEnabled: boolean;
}

const mailOpsReady = (runtime: MailOpsRuntime): boolean =>
  runtime.pubsubConfigured && runtime.workersEnabled;

function mailOpsConfigurationRequired(
  operation: Res['operation'],
  runtime: MailOpsRuntime,
): Res {
  return {
    success: false,
    operation,
    code: 'mail_ops_configuration_required',
    // Named separately because the fix is different. One is a Google setup
    // step; the other means this deployment does not run background work at
    // all, and no amount of Google configuration will change that.
    message: !runtime.pubsubConfigured
      ? 'Mail Ops real-time Gmail notifications are not configured. '
        + 'Ask the Divo operator to finish the Google Pub/Sub setup. '
        + 'Do not substitute Scheduler or a Gmail filter.'
      : 'This Divo environment does not run background automations, so a mail '
        + 'rule would never fire. Ask the Divo operator to enable autonomous '
        + 'workers. Do not substitute Scheduler or a Gmail filter.',
  };
}

function resolveDestination(
  input: z.infer<typeof destinationSchema>,
  ctx: ToolExecutionContext,
):
  | { type: 'email'; email: string }
  | { type: 'lark_chat'; chatId: string }
  | { type: 'lark_dm'; openId: string }
  | { type: 'none' } {
  if (input.type === 'email') return input;
  if (input.type === 'organize') return { type: 'none' };
  if (input.type === 'lark_chat') {
    return { type: 'lark_chat', chatId: input.chatId };
  }
  if (input.type === 'lark_dm') {
    // From the run, never from arguments. `userExternalId` is whoever made this
    // request, so the destination cannot be pointed at a colleague by a model
    // that misread a name.
    if (!ctx.runContext.userExternalId) {
      throw new Error(
        'lark_dm requires a request from someone with a linked Lark account.',
      );
    }
    return { type: 'lark_dm', openId: ctx.runContext.userExternalId };
  }
  if (ctx.runContext.channel !== 'lark' || !ctx.runContext.chatId) {
    throw new Error(
      'current_lark_chat requires a Lark request with a current conversation.',
    );
  }
  return { type: 'lark_chat', chatId: ctx.runContext.chatId };
}

/**
 * What the rule does, derived from where the member said the mail goes.
 *
 * The tool takes one `destination` and the stored rule carries an action and a
 * destination separately, because the runtime dispatches on the action. Keeping
 * the derivation here means a member never has to state both and never has to
 * get the pairing right — an impossible combination cannot be expressed.
 */
function resolveAction(
  input: z.infer<typeof destinationSchema>,
  rateLimitPerHour: number | undefined,
): MailRuleAction {
  if (input.type === 'organize') {
    return {
      type: 'organize',
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.archive !== undefined ? { archive: input.archive } : {}),
      ...(input.markRead !== undefined ? { markRead: input.markRead } : {}),
    };
  }
  return {
    type: input.type === 'email' ? 'forward' : 'deliver',
    ...(rateLimitPerHour !== undefined ? { rateLimitPerHour } : {}),
  };
}

function dryRunSummary(
  considered: number,
  matched: number,
  bodyUnavailable = 0,
): string {
  if (considered === 0) {
    return 'Divo has no recorded mail for this mailbox yet, so there was '
      + 'nothing to test the rule against. That is not evidence the rule is '
      + 'wrong — only that nothing has arrived since the mailbox was connected.';
  }
  // Said before the count, because it changes what the count means. A rule that
  // reads the body cannot be judged against mail whose body Divo no longer
  // keeps, and reporting "matched none" for those would answer a question
  // nobody can answer.
  const caveat = bodyUnavailable > 0
    ? ` ${bodyUnavailable} of them are older than 30 days, so Divo no longer `
      + 'keeps their text and could not check this rule against them either way.'
    : '';
  if (matched === 0) {
    return `This rule matched none of the last ${considered} messages Divo `
      + `recorded for the mailbox.${caveat}`;
  }
  return `This rule matched ${matched} of the last ${considered} messages Divo `
    + `recorded for the mailbox. Nothing was sent.${caveat}`;
}

function storedRuleValidity(input: {
  match: Record<string, unknown>;
  action: Record<string, unknown>;
  destination: Record<string, unknown>;
}): { valid: true } | { valid: false; invalidReason: string } {
  try {
    parseMailRule(input);
    return { valid: true };
  } catch (error) {
    const reason = error instanceof z.ZodError
      ? error.errors.map(issue => issue.message).join('; ')
      : error instanceof Error
        ? error.message
        : String(error);
    return {
      valid: false,
      invalidReason: `Update this rule before it can match new mail: ${reason}`.slice(
        0,
        500,
      ),
    };
  }
}
