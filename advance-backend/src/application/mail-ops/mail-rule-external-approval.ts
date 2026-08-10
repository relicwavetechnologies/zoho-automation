/**
 * Carrying a browser's external-forward request to the person who must agree.
 *
 * The writer already refuses one and names the approver. What was missing was
 * the ask: the card, the record, and the rule being written when the answer
 * comes back. All three exist — on the agent path — and none of them is
 * rebuilt here.
 *
 * `ApprovalGateService.check` writes the record, chooses the delivery channel
 * (Lark card, or the approval inbox when Divo cannot card them) and holds the
 * idempotency that stops one member producing five cards from five clicks.
 * `ApprovalResumerService` replays the stored tool call when the manager
 * agrees. Neither knows a browser exists, and neither needs to: what they read
 * is a `RunContext`, so this builds an honest one and hands the same request
 * over.
 *
 * Three fields in that context carry the weight, and each is chosen rather than
 * copied from the agent path:
 *
 *   channel 'lark'   — where the *approver* is reached. It is not a claim about
 *                      where the member is sitting; the gate reads it to decide
 *                      whether a Lark identity may be recorded at all, and
 *                      without it the resumer cannot verify the requester later.
 *   chatId gateway:… — a browser has no conversation. The prefix is what marks
 *                      this as a gateway-origin approval, which is also what
 *                      puts it in the desktop approval inbox rather than
 *                      pretending a chat is waiting on it.
 *   deliveryMode     — 'scheduled_runtime_delivery' means *there is no chat to
 *                      answer into; tell the person who asked*. That is exactly
 *                      true here, and it is why the outcome reaches the member
 *                      as a DM instead of failing against a synthetic chat id.
 *
 * The chat id is stable per member rather than per rule, deliberately. Two
 * different rules already differ by their args hash, so they get their own
 * approvals; the same rule asked for twice reuses the one card, which is the
 * behaviour anybody clicking a button twice should get.
 */
import type { ApprovalGateService } from '../approval/approval-gate.service';
import type { ApprovalDelivery } from '../approval/approval.types';
import type { PermissionService } from '../permissions/permission.service';
import type { Logger } from '../../shared/logger';
import {
  mailDestinationLeaves,
  type MailRuleDestination,
  type MailRuleJudge,
  type MailRuleMatch,
} from './mail-ops.types';
import {
  mailRuleLeavesOrganisation,
  namedAddresses,
} from './external-destination';
import {
  asCompanyId,
  asDepartmentId,
  asUserId,
} from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import { GATEWAY_APPROVAL_CHAT_PREFIX } from '../approval/approval-origin';

export interface MailRuleExternalApprovalDeps {
  approvalGate: Pick<ApprovalGateService, 'check'>;
  permissions: Pick<PermissionService, 'resolve'>;
  logger: Logger;
}

export interface MailRuleExternalApprovalInput {
  readonly companyId: string;
  readonly userId: string;
  readonly companyRole: string;
  readonly departmentId?: string | undefined;
  readonly requesterEmail?: string | undefined;
  /** Null for a member who signed in with a password and linked no Lark account. */
  readonly larkOpenId?: string | null;
  readonly larkTenantKey?: string | null;
  /** Exactly the rule the member filled in, in the agent tool's own arguments. */
  readonly rule: {
    readonly connectionId: string;
    readonly name: string;
    readonly match: MailRuleMatch;
    /**
     * Exactly the destination the member built, whether that is one address or
     * a routing table.
     *
     * It used to be a single `email`, and the replayed request was rebuilt from
     * it as `{type:'email'}`. On a routed rule that would have replaced the
     * whole table with whichever branch happened to be picked out — so the
     * manager would have approved one thing and the member been given another,
     * on the one operation where the two differing matters most.
     */
    readonly destination: MailRuleDestination;
    readonly rateLimitPerHour?: number | undefined;
    /**
     * Present when an existing rule is being edited into this shape.
     *
     * Without it an approved edit would replay as a `create`, which upserts on
     * the dedupe key — so the member would end up with the new rule *and* the
     * old one still forwarding, which is the double-delivery the whole dedupe
     * key exists to prevent. With it, the replay is the same `update` the
     * member asked for.
     */
    readonly ruleId?: string | undefined;
    /**
     * The rule's AI step, carried into the replay.
     *
     * Without it an approved external forward would be written with no step at
     * all — and the member would have been shown the approval for the careful
     * version of their rule and given the indiscriminate one. On a rule whose
     * mail leaves the company that is the worst place for the two to differ,
     * which is why it rides in the args rather than being re-derived later.
     */
    readonly judge?: MailRuleJudge | undefined;
  };
  readonly mailboxEmail: string;
}

export type MailRuleExternalApprovalOutcome =
  | {
      readonly kind: 'requested';
      readonly approvalId: string;
      readonly approverName: string;
      /** Already reused an open request for the identical rule. */
      readonly reused: boolean;
      /**
       * Where it is waiting for them. The member is told this, because "asked
       * your manager" without a place to look is what makes a working approval
       * read as a broken one.
       */
      readonly deliveredVia: ApprovalDelivery;
    }
  /** Already answered yes, and the rule was written by the replay. */
  | { readonly kind: 'already_granted'; readonly message: string }
  | { readonly kind: 'declined'; readonly approverName: string; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string };

/**
 * Which of this rule's recipients are outside the company.
 *
 * Recomputed here rather than threaded in, so the sentence on the card is
 * derived from the very destination being approved. A summary built from a list
 * assembled somewhere else can fall out of step with the rule it describes, and
 * this is the one sentence where that would matter.
 */
function externalRecipients(input: MailRuleExternalApprovalInput): string[] {
  return [...new Set(
    mailDestinationLeaves(input.rule.destination)
      .flatMap(leaf => leaf.type === 'email' ? [leaf.email] : [])
      .filter(email => mailRuleLeavesOrganisation({
        destinationEmail: email,
        requesterEmail: input.requesterEmail,
      })),
  )];
}

export function createMailRuleExternalApproval(deps: MailRuleExternalApprovalDeps) {
  const log = deps.logger.child({ service: 'mail-rule-external-approval' });

  return async function requestExternalForwardApproval(
    input: MailRuleExternalApprovalInput,
  ): Promise<MailRuleExternalApprovalOutcome> {
    const permission = await deps.permissions.resolve({
      companyId: asCompanyId(input.companyId),
      userId: asUserId(input.userId),
      companyRole: asCompanyRoleSlug(input.companyRole),
      channel: 'lark',
      ...(input.departmentId ? { departmentId: asDepartmentId(input.departmentId) } : {}),
    });
    if (!permission.ok) {
      log.warn('mail_rule_approval.permission_unresolved', {
        userId: input.userId,
        reason: permission.error.message,
      });
      return {
        kind: 'unavailable',
        message: 'Divo could not work out who approves this for you. Ask an administrator.',
      };
    }

    const chatId =
      `${GATEWAY_APPROVAL_CHAT_PREFIX}company:${input.companyId}:requester:${input.userId}:mail-rule`;

    const editing = typeof input.rule.ruleId === 'string' && input.rule.ruleId.length > 0;

    const args = {
      ...(editing
        ? { operation: 'update' as const, ruleId: input.rule.ruleId! }
        : { operation: 'create' as const }),
      connectionId: input.rule.connectionId,
      name: input.rule.name,
      match: input.rule.match,
      destination: input.rule.destination,
      ...(input.rule.rateLimitPerHour !== undefined
        ? { rateLimitPerHour: input.rule.rateLimitPerHour }
        : {}),
      ...(input.rule.judge ? { judge: input.rule.judge } : {}),
    };

    const decision = await deps.approvalGate.check({
      toolId: 'mailAutomations',
      /*
       * The action group the *tool* derives from these arguments, not the one
       * a connection policy speaks in.
       *
       * The resumer replays with `expectedAction: approval.actionGroup` and the
       * executor recomputes it from the args; a mismatch is refused as "the
       * action changed after approval", which is the right guard and does not
       * care that the mismatch was ours. `mailAutomations` maps `create` to
       * `create` and `update` to `update` — say the same thing here or the
       * approval can never be spent.
       */
      action: editing ? 'update' : 'create',
      args,
      perm: permission.value,
      chatId,
      /*
       * A yes here finishes the rule; it does not unblock a retry.
       *
       * Gateway-origin requests default to the opposite, because a desktop
       * action has somebody sitting in front of it who re-issues it. This one
       * was made from a form that is closed by the time the manager looks, so
       * without this their approval would land and nothing would happen.
       */
      resumeOnApproval: true,
      // What the approver reads. Says what will leave and from where, because
      // "approve a mail rule" is not a question anybody can answer.
      /*
       * What the approver reads. Says what will leave and to whom — every
       * recipient, because a routing table can establish several external
       * forwards at once and a card naming one of them is a card that asks
       * about less than it grants.
       */
      argsSummary: (() => {
        const leaving = namedAddresses(externalRecipients(input));
        const where = leaving || 'an address outside the company';
        return editing
          ? `Change the rule “${input.rule.name}” so mail from ${input.mailboxEmail} is forwarded `
            + `to ${where}, which is outside the company.`
          : `Forward mail from ${input.mailboxEmail} to ${where}, `
            + `which is outside the company (rule: ${input.rule.name}).`;
      })(),
      runContext: {
        companyId: asCompanyId(input.companyId),
        userId: asUserId(input.userId),
        companyRole: asCompanyRoleSlug(input.companyRole),
        channel: 'lark',
        chatId,
        traceId: `mail-rule-approval-${input.userId}`,
        requestId: `mail-rule-approval-${input.userId}`,
        requesterAiRole: input.companyRole,
        deliveryMode: 'scheduled_runtime_delivery',
        ...(input.departmentId ? { departmentId: asDepartmentId(input.departmentId) } : {}),
        ...(input.requesterEmail ? { requesterEmail: input.requesterEmail } : {}),
        ...(input.larkOpenId ? { userExternalId: input.larkOpenId } : {}),
        ...(input.larkTenantKey ? { tenantId: input.larkTenantKey } : {}),
      } as Parameters<ApprovalGateService['check']>[0]['runContext'],
    });

    switch (decision.kind) {
      case 'pending':
        return {
          kind: 'requested',
          approvalId: decision.approvalId,
          approverName: decision.approverName,
          reused: decision.requestState === 'reused',
          deliveredVia: decision.deliveredVia,
        };
      case 'rejected':
        return {
          kind: 'declined',
          approverName: decision.approverName,
          message: decision.message,
        };
      /*
       * `allowed` should be unreachable: the writer only reaches here having
       * been told approval is required, by the same module the gate consults.
       * It is handled rather than asserted because the two calls are separated
       * by a round trip, and a department manager appointed in between is a
       * legitimate way to arrive here.
       */
      case 'allowed':
      case 'completed':
        return {
          kind: 'already_granted',
          message: 'That forward is already approved. Turn the rule on again.',
        };
      case 'execution_failed':
        return { kind: 'unavailable', message: decision.message };
      case 'misconfigured':
        return { kind: 'unavailable', message: decision.message };
    }
  };
}
