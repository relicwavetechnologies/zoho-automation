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
import { mailRuleDedupeKey } from '../../mail-ops/mail-ops.types';

const destinationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('email'), email: z.string().email() }).strict(),
  z.object({ type: z.literal('current_lark_chat') }).strict(),
  z.object({
    type: z.literal('lark_chat'),
    chatId: z.string().trim().min(1),
  }).strict(),
]);

export const mailAutomationsArgsSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('create'),
    connectionId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    match: mailRuleMatchSchema,
    destination: destinationSchema,
  }).strict(),
  z.object({
    operation: z.literal('list'),
    includeInactive: z.boolean().optional(),
  }).strict(),
  z.object({
    operation: z.literal('update'),
    ruleId: z.string().uuid(),
    connectionId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    match: mailRuleMatchSchema,
    destination: destinationSchema,
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
  createdAt: z.string(),
  valid: z.boolean(),
  invalidReason: z.string().optional(),
});

const resultSchema = z.object({
  success: z.boolean(),
  operation: z.enum([
    'create',
    'list',
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
       * Which of the three unavailable states this is. Carried separately from
       * the sentence so a caller can behave differently without matching on
       * prose — an account that exists but lacks a scope is not the same
       * problem as no account at all.
       */
      connectionState?: 'none_accessible' | 'insufficient_access' | 'requested_not_accessible';
    };

/**
 * Three different problems with three different remedies.
 *
 * They used to share one sentence — "Connect or reconnect Google to continue" —
 * which sent a member with a scope-limited account off to connect an account
 * they already had, and a member with no account off to grant scopes on one
 * that did not exist.
 */
export function mailOpsConnectionUnavailableMessage(
  state: 'none_accessible' | 'insufficient_access' | 'requested_not_accessible',
): string {
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

type MailRepo = Pick<
  MailOpsRepository,
  | 'createRuleForMailbox'
  | 'listRulesForUser'
  | 'replaceRule'
  | 'setRuleStatus'
>;

const actionFor = (operation: Args['operation']): ToolActionGroup => {
  switch (operation) {
    case 'list': return 'read';
    case 'create': return 'create';
    case 'update':
    case 'pause':
    case 'resume': return 'update';
    case 'archive': return 'delete';
  }
};

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
      'A rule delivers the entire message. It cannot extract a code, link, or any part of the mail, so tell the user the whole email will be sent when they ask for "just the OTP" or similar.',
      'Only mail arriving in the INBOX triggers a rule. Mail that a Gmail filter archives, or that lands in Spam, is never seen.',
      'create requires name, a deterministic match, and one destination. Match supports from, to, subjectContains, bodyContains, and hasAttachment; at least one is required. from must be one exact mailbox address or an exact @domain, never a brand or display-name substring.',
      'Match fields are combined with AND. There is no OR and no negation.',
      'subjectContains and bodyContains are literal case-insensitive substring tests: regex, wildcards, and | alternation never match.',
      '@domain does not match subdomains, so @example.com misses alerts@mail.example.com. Verify the real sending address before relying on it.',
      'to matches the To header only, not Cc, Bcc, or Delivered-To.',
      'hasAttachment is true for inline signature images, so it is not a reliable real-attachment test.',
      'Unlisted match keys are ignored rather than rejected. Never invent a field such as cc or labelIs; the rule would be created without it and match far more mail than intended.',
      'destination=email forwards matching mail to that exact grounded address.',
      'Email forwarding preserves the original Gmail MIME content, including HTML, inline images, and attachments, inside a new message sent by the connected mailbox.',
      'destination=current_lark_chat delivers to the current Lark conversation; it is invalid outside Lark and is rejected on desktop and web.',
      'destination=lark_chat requires an exact chatId returned by governed Lark chat discovery. Never invent it. Lark delivery posts up to 20,000 characters of plain text with no HTML and no attachments.',
      'connectionId is optional only when exactly one eligible user-owned Google account exists. If several exist the tool returns google_workspace_connection_selection_required with a connections list; that is a normal step, not a failure. Retry with one exact returned connectionId.',
      'No LLM runs for matching or delivery. Do not request per-message approval after the user creates the rule.',
      'list returns valid for every rule, plus invalidReason when valid is false, meaning that rule matches no mail and needs repair. Report those instead of presenting them as working.',
      'list hides paused and archived rules unless includeInactive is true.',
      'list, pause, resume, and archive operate only on rules owned by the authenticated user. Never invent ruleId.',
      'update replaces the complete deterministic match and destination for one rule; include the ruleId, connectionId, and name returned by list. update also resumes a paused rule.',
      'archive is final: an archived rule cannot be resumed.',
    ].join('\n'),

    permissionCheck(
      args: Args,
      permission: PermissionResult,
    ): Result<ToolActionGroup, PermissionError> {
      const action = actionFor(args.operation);
      const allowed = permission.allowedActionsByTool
        .get(asToolId('mailAutomations'))
        ?.has(action) ?? false;
      const needsExecute = args.operation === 'create'
        || args.operation === 'update'
        || args.operation === 'resume';
      const canExecute = !needsExecute
        || (
          permission.allowedActionsByTool
            .get(asToolId('mailAutomations'))
            ?.has('execute') ?? false
        );
      return allowed && canExecute
        ? ok(action)
        : err(new PermissionError({
            toolId: 'mailAutomations',
            action: allowed ? 'execute' : action,
            reason: 'not_allowed',
            ...(allowed && !canExecute
              ? {
                  message:
                    'Activating a mail automation also requires background execute access.',
                }
              : {}),
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

        const destination = resolveDestination(args.destination, ctx);
        const action = destination.type === 'email'
          ? { type: 'forward' as const }
          : { type: 'deliver' as const };
        const parsed = parseMailRule({
          match: args.match,
          action,
          destination,
        });
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
            dedupeKey: mailRuleDedupeKey({
              companyId: String(ctx.runContext.companyId),
              userId: String(ctx.runContext.userId),
              connectionId: connection.connectionId,
              ...parsed,
            }),
          });
          if (!updated.ok) throw updated.error;
          if (!updated.value) {
            return err(new ToolError({
              toolId: 'mailAutomations',
              reason: 'bad_args',
              message:
                'Mail automation rule was not found for the selected account.',
            }));
          }
          return ok({
            success: true,
            operation: 'update',
            message: 'Mail automation update completed.',
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
          dedupeKey: mailRuleDedupeKey({
            companyId: String(ctx.runContext.companyId),
            userId: String(ctx.runContext.userId),
            connectionId: connection.connectionId,
            ...parsed,
          }),
        });
        if (!created.ok) throw created.error;
        ctx.onProgress?.('Mail automation activated.');
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
            createdAt: new Date().toISOString(),
            valid: true,
          },
          message: 'Mail automation is active.',
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
): { type: 'email'; email: string } | { type: 'lark_chat'; chatId: string } {
  if (input.type === 'email') return input;
  if (input.type === 'lark_chat') {
    return { type: 'lark_chat', chatId: input.chatId };
  }
  if (ctx.runContext.channel !== 'lark' || !ctx.runContext.chatId) {
    throw new Error(
      'current_lark_chat requires a Lark request with a current conversation.',
    );
  }
  return { type: 'lark_chat', chatId: ctx.runContext.chatId };
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
