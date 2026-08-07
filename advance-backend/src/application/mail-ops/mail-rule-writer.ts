/**
 * Creating a mail rule, as one sequence rather than two.
 *
 * Until now the only way to make a rule was the agent's tool, and the six
 * checks it runs before writing a row live inside that tool's executor. A web
 * route needed all six too — and a route that reimplemented them beside the
 * tool would be two paths that agree on the day they are written and not for
 * long after, with the newer one having no reviewer watching it.
 *
 * So the sequence moved here and both call it.
 *
 * WHAT IT DOES NOT DO: resolve permission. That is deliberate and it is not an
 * omission. `mailAutomations.execute` is re-checked by the worker on **every
 * single delivery** (`authorizeRule`), so a rule created by somebody who may
 * not run one simply never delivers — enforcement sits at the point of action,
 * which is the strongest place for it and the only place that keeps working
 * when access is removed after the rule already exists.
 *
 * The order of the checks is load-bearing. Readiness before connection,
 * because a mailbox is irrelevant if no worker will ever poll it. Connection
 * before approval, because the approval question is *about* a connection.
 * Approval before destination, because a refusal there ends the attempt and
 * there is no reason to have grounded a chat first.
 *
 * Two approvals sit here, and they are different questions. The connection's
 * own policy asks whether this account may run anything unattended, and it
 * refuses outright. The external-forward gate asks whether company mail may
 * leave the company at all, and it *defers* — a named person is asked, and the
 * same request is written once they agree.
 */
import type { MailOpsConnectionState } from '../tools/families/mail-automations.tool';
import { parseMailRule } from './mail-rule.matcher';
import {
  mailRuleDedupeKey,
  type MailRuleAction,
  type MailRuleDestination,
  type MailRuleIdentity,
  type MailRuleMatch,
} from './mail-ops.types';
import type { LarkChatDestinationVerdict } from './lark-chat-destination';
import { mailRuleLeavesOrganisation } from './external-destination';
import {
  inspectExternalForward,
  type ExternalForwardApprovalPort,
} from './external-forward-approval';

/** What the caller asks for, already validated against the shared schema. */
export interface MailRuleWriteRequest {
  readonly companyId: string;
  readonly userId: string;
  readonly departmentId?: string;
  /** Optional only when the member owns exactly one eligible Google account. */
  readonly connectionId?: string;
  readonly name: string;
  readonly match: MailRuleMatch;
  readonly destination: MailRuleDestination;
  /** Ignored for `organize`, which sends nothing and so floods nobody. */
  readonly rateLimitPerHour?: number;
  /**
   * The requester's own address, which is what "outside the company" is judged
   * against. Absent reads as external — the failure direction that asks a human
   * one extra question is the only acceptable one here.
   */
  readonly requesterEmail?: string;
  /**
   * Set by a caller that has already had the external forward approved.
   *
   * The agent path runs the approval gate in its executor, before the tool is
   * ever invoked, so by the time it reaches this writer the manager has already
   * said yes — asking again would block a rule that was approved. The web path
   * has no such upstream gate and sets nothing.
   *
   * Declared by the caller rather than inferred, because the two paths differ
   * in a way no amount of inspection here could tell apart. Forgetting it asks
   * twice; there is no value that skips the question.
   */
  readonly externalForwardApproved?: boolean;
}

/**
 * Every way this ends, named.
 *
 * A single boolean would collapse six different situations with six different
 * remedies into "it did not work" — and the remedy is the only part of a
 * refusal a member can act on.
 */
/**
 * Turning a rule off, back on, or away.
 *
 * `archived` rather than deleted, and that is the domain's choice rather than a
 * softer word for the same thing: an archived rule keeps its identity, so
 * re-creating the identical rule revives that row instead of making a second
 * one. A hard delete would break that and leave two rules forwarding every
 * matching message twice.
 */
export type MailRuleStatusChange = 'pause' | 'resume' | 'archive';

export type MailRuleStatusResult =
  | { readonly status: 'changed' }
  /** Not yours, or not real. The repository makes the two indistinguishable. */
  | { readonly status: 'not_found' }
  /** Resuming into an environment where nothing would poll the mailbox. */
  | { readonly status: 'not_configured' }
  | { readonly status: 'unavailable'; readonly reason: string };

export type MailRuleWriteResult =
  | { readonly status: 'created'; readonly ruleId: string; readonly mailboxEmail: string }
  /** Mail Ops is not configured, or its workers are switched off. */
  | { readonly status: 'not_configured' }
  | { readonly status: 'choose_connection'; readonly connections: readonly unknown[] }
  | {
      readonly status: 'connection_unavailable';
      readonly reason: string;
      readonly connectionState?: MailOpsConnectionState;
    }
  /** The connection's owner gates background execution. Refused, not deferred. */
  | { readonly status: 'approval_required' }
  /**
   * The rule would forward company mail outside the company, and a named person
   * has to say yes first. Deferred rather than refused: the caller creates the
   * approval and the same request is written once it is granted.
   */
  | {
      readonly status: 'external_approval_required';
      readonly destination: string;
      readonly approver: { readonly userId: string; readonly displayName: string };
      /**
       * The mailbox this would have watched, carried so the approved request
       * binds to the very account the member was looking at. Re-resolving it
       * when the approval comes back could pick a different one of their Google
       * accounts, and nothing on the card would have said which.
       */
      readonly connectionId: string;
      readonly mailboxEmail: string;
    }
  /** External forward, and nobody in the company can approve it. Fails closed. */
  | { readonly status: 'external_approval_unavailable'; readonly reason: string }
  | { readonly status: 'destination_refused'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string };

/*
 * No duplicate outcome, and that is a property of create rather than an
 * omission: `createRuleForMailbox` is an upsert on the canonical dedupe key, so
 * re-creating a rule that already exists returns the same rule and re-creating
 * an archived one revives it. `duplicate` and `duplicate_archived` belong to
 * `replaceRule`, where editing a rule *into* another one is a real collision.
 */

export interface MailRuleConnectionResolution {
  status: 'resolved' | 'choose_connection' | 'unavailable';
  connectionId?: string;
  mailboxEmail?: string;
  connections?: readonly unknown[];
  reason?: string;
  connectionState?: MailOpsConnectionState;
}

export interface MailRuleWriterDeps {
  readonly runtime: { readonly pubsubConfigured: boolean; readonly workersEnabled: boolean };
  resolveConnection(input: {
    companyId: string;
    userId: string;
    connectionId?: string;
  }): Promise<MailRuleConnectionResolution>;
  /** Absent in compositions with no rate-limit service; the check is skipped. */
  connectionApproval?(input: {
    companyId: string;
    connectionId: string;
    action: 'execute';
    // `not_governed` is a real answer — the connection has no policy at all —
    // and only `required` and `unavailable` change what happens, so the rest
    // pass through rather than being enumerated here.
  }): Promise<{ kind: string; message?: string }>;
  authorizeLarkChat?(input: {
    companyId: string;
    chatId: string;
  }): Promise<LarkChatDestinationVerdict>;
  /**
   * Who must approve a forward that leaves the company.
   *
   * Absent in compositions with no approval resolver, and the question is then
   * skipped — the same shape `connectionApproval` uses. The decision itself is
   * `inspectExternalForward`, shared with the approval gate so the agent path
   * and the web path cannot answer this differently.
   */
  externalForward?: ExternalForwardApprovalPort;
  repo: {
    setRuleStatus(input: {
      companyId: string;
      userId: string;
      ruleId: string;
      status: 'active' | 'paused' | 'archived';
    }): Promise<
      | { ok: true; value: boolean }
      | { ok: false; error: { message: string } }
    >;
    createRuleForMailbox(input: {
      companyId: string;
      createdByUserId: string;
      departmentId?: string;
      connectionId: string;
      mailboxEmail: string;
      name: string;
      match: Record<string, unknown>;
      action: Record<string, unknown>;
      destination: Record<string, unknown>;
      dedupeKey: string;
    }): Promise<
      | { ok: true; value: { ruleId: string; subscriptionId: string } }
      | { ok: false; error: { message: string } }
    >;
  };
}

/**
 * The action a destination implies, plus its ceiling.
 *
 * `organize` never carries one: labelling and archiving act on the member's own
 * mailbox, where a burst is the correct response to a burst.
 */
export function actionForDestination(
  destination: MailRuleDestination,
  rateLimitPerHour: number | undefined,
): MailRuleAction {
  if (destination.type === 'none') {
    // An organize action's detail rides on the request, not the destination —
    // callers build it directly. Reaching here means a `none` destination with
    // no organize action, which parseMailRule refuses.
    return { type: 'organize' };
  }
  return {
    type: destination.type === 'email' ? 'forward' : 'deliver',
    ...(rateLimitPerHour !== undefined ? { rateLimitPerHour } : {}),
  };
}

export function createMailRuleWriter(deps: MailRuleWriterDeps) {
  /**
   * Pause, resume, archive.
   *
   * Only resume asks whether Mail Ops is running, and only resume needs to: it
   * is the one that claims a rule will start firing again, and saying that into
   * an environment with no worker is the silent failure this subsystem exists
   * to have stopped. Pausing and archiving are true whatever the workers are
   * doing — they make a rule do less.
   */
  const setStatus = async (
    input: { companyId: string; userId: string; ruleId: string },
    change: MailRuleStatusChange,
  ): Promise<MailRuleStatusResult> => {
    if (change === 'resume' && !(deps.runtime.pubsubConfigured && deps.runtime.workersEnabled)) {
      return { status: 'not_configured' };
    }
    const status = change === 'resume'
      ? 'active' as const
      : change === 'pause' ? 'paused' as const : 'archived' as const;

    const changed = await deps.repo.setRuleStatus({ ...input, status });
    if (!changed.ok) return { status: 'unavailable', reason: changed.error.message };
    return changed.value ? { status: 'changed' } : { status: 'not_found' };
  };

  const create = async function writeMailRule(
    request: MailRuleWriteRequest,
    action: MailRuleAction,
  ): Promise<MailRuleWriteResult> {
    // Nothing polls a mailbox when the workers are off, so a rule created here
    // would sit looking healthy and never fire. This is the flag that took Mail
    // Ops down silently in production for weeks; refusing loudly is the point.
    if (!deps.runtime.pubsubConfigured || !deps.runtime.workersEnabled) {
      return { status: 'not_configured' };
    }

    const connection = await deps.resolveConnection({
      companyId: request.companyId,
      userId: request.userId,
      ...(request.connectionId ? { connectionId: request.connectionId } : {}),
    });

    if (connection.status === 'choose_connection') {
      return { status: 'choose_connection', connections: connection.connections ?? [] };
    }
    if (connection.status === 'unavailable' || !connection.connectionId || !connection.mailboxEmail) {
      return {
        status: 'connection_unavailable',
        reason: connection.reason ?? 'No usable Google account.',
        ...(connection.connectionState ? { connectionState: connection.connectionState } : {}),
      };
    }

    // Creating a rule is not one action — it authorises unbounded future
    // background execution on this connection. A policy that gates `execute`
    // has to gate the act of granting it, or the gate means nothing: approval
    // is asked per interactive call, and a rule makes calls nobody is present
    // for. So this refuses rather than queueing an approval that would have
    // nobody to answer it.
    if (deps.connectionApproval) {
      const policy = await deps.connectionApproval({
        companyId: request.companyId,
        connectionId: connection.connectionId,
        action: 'execute',
      });
      if (policy.kind === 'required') return { status: 'approval_required' };
      if (policy.kind === 'unavailable') {
        return {
          status: 'unavailable',
          reason: policy.message ?? 'Divo could not read the connection policy.',
        };
      }
    }

    /*
     * A forward out of the company is approved by a person, on every surface.
     *
     * This used to be reachable only through the approval gate, which only the
     * agent's tool executor calls — so the identical rule created in a browser
     * established a standing export of company mail with nobody else seeing the
     * address. Same decision, same module, asked here so both callers meet it.
     *
     * Before the destination is grounded and after the connection is resolved:
     * the answer is about mail leaving the company, and there is no reason to
     * have grounded a Lark chat for a rule a manager may refuse.
     */
    if (deps.externalForward && !request.externalForwardApproved) {
      const leaving = request.destination.type === 'email'
        && mailRuleLeavesOrganisation({
          destinationEmail: request.destination.email,
          requesterEmail: request.requesterEmail,
        })
        ? request.destination.email
        : null;

      const verdict = await inspectExternalForward(
        {
          destination: leaving,
          companyId: request.companyId,
          requesterId: request.userId,
          departmentId: request.departmentId ?? null,
        },
        deps.externalForward,
      );
      if (verdict.kind === 'misconfigured') {
        return { status: 'external_approval_unavailable', reason: verdict.message };
      }
      if (verdict.kind === 'required') {
        return {
          status: 'external_approval_required',
          destination: verdict.destination,
          approver: {
            userId: verdict.approver.userId,
            displayName: verdict.approver.displayName,
          },
          connectionId: connection.connectionId,
          mailboxEmail: connection.mailboxEmail,
        };
      }
    }

    // A named chat is grounded here, in code, once — not on every delivery, and
    // not by asking the model nicely in prompt text. A `lark_dm` destination
    // is not grounded because it carries no caller-supplied id to ground: the
    // open id comes from the signed-in session, so its single recipient is
    // already known to be the person who owns the mailbox.
    if (request.destination.type === 'lark_chat' && deps.authorizeLarkChat) {
      const verdict = await deps.authorizeLarkChat({
        companyId: request.companyId,
        chatId: request.destination.chatId,
      });
      if (verdict.status !== 'allowed') {
        return { status: 'destination_refused', reason: larkRefusal(verdict) };
      }
    }

    let parsed: { match: MailRuleMatch; action: MailRuleAction; destination: MailRuleDestination };
    try {
      // Cast at the boundary: `parseMailRule` takes the stored, opaque shape
      // because it is what re-reads rows written by older builds. The request
      // is already the typed one, so this narrows nothing and loses nothing.
      parsed = parseMailRule({
        match: request.match as Record<string, unknown>,
        action: action as Record<string, unknown>,
        destination: request.destination as Record<string, unknown>,
      });
    } catch (cause) {
      return {
        status: 'unavailable',
        reason: cause instanceof Error ? cause.message : 'That rule could not be read.',
      };
    }

    // Built once, so the canonical key and the key this rule would have carried
    // before canonicalisation describe the very same request.
    const identity: MailRuleIdentity = {
      companyId: request.companyId,
      userId: request.userId,
      connectionId: connection.connectionId,
      ...parsed,
    };

    const created = await deps.repo.createRuleForMailbox({
      companyId: request.companyId,
      createdByUserId: request.userId,
      ...(request.departmentId ? { departmentId: request.departmentId } : {}),
      connectionId: connection.connectionId,
      mailboxEmail: connection.mailboxEmail,
      name: request.name,
      match: { ...parsed.match } as Record<string, unknown>,
      action: { ...parsed.action } as Record<string, unknown>,
      destination: { ...parsed.destination } as Record<string, unknown>,
      dedupeKey: mailRuleDedupeKey(identity),
    });
    if (!created.ok) {
      return { status: 'unavailable', reason: created.error.message };
    }

    return {
      status: 'created',
      ruleId: created.value.ruleId,
      mailboxEmail: connection.mailboxEmail,
    };
  };

  return { create, setStatus };
}

/**
 * Two refusals, kept apart.
 *
 * `unknown_chat` is ordinary — Divo has simply never been in that room, and the
 * member can fix it. `other_company` means one Lark installation serves more
 * than one Divo company and the named room belongs to a different one; that is
 * never the member's mistake and never theirs to fix.
 */
function larkRefusal(verdict: LarkChatDestinationVerdict): string {
  if (verdict.status === 'other_company') {
    return 'That Lark chat belongs to a different company, so Divo will not send your mail there.';
  }
  if (verdict.status === 'unavailable') {
    return verdict.reason;
  }
  return 'Divo has never been in that Lark chat, so it cannot send mail there. Add Divo to it first.';
}
