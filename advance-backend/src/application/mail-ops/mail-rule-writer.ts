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
  mailDestinationKind,
  mailDestinationLeaves,
  mailRuleDedupeKey,
  type MailRuleAction,
  type MailRuleDestination,
  type MailRuleIdentity,
  type MailRuleJudge,
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
   * The requester's company role, which decides whether an external forward is
   * asked about at all — a company admin is exempt.
   *
   * Absent is read as an ordinary member, so a caller that omits it asks one
   * extra person rather than none.
   */
  readonly companyRole?: string;
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
  /**
   * The rule's optional AI step.
   *
   * Absent and `undefined` both mean "no step", and on an edit that means
   * *remove* the step rather than leave whatever was there — the repository
   * writes this field on every branch for exactly that reason. A caller that
   * wants to keep an existing question must resubmit it, which is the same
   * whole-rule contract the tool's `update` already has for match and
   * destination.
   *
   * Not part of `mailRuleDedupeKey`, and that is load-bearing rather than an
   * oversight. Two rules alike but for their question are one rule with two
   * opinions about the same mail; treating them as two would leave both active
   * and act on every matching message twice.
   */
  readonly judge?: MailRuleJudge;
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
  /**
   * Archived, which is a different answer from missing and has a different
   * remedy — the same distinction `replace` already draws. A member looking at
   * a rule under Archived and being told it is "not found in your account" is
   * being contradicted by the screen they are reading it on.
   */
  | { readonly status: 'archived' }
  /** Resuming into an environment where nothing would poll the mailbox. */
  | { readonly status: 'not_configured' }
  | { readonly status: 'unavailable'; readonly reason: string };

export type MailRuleWriteResult =
  | {
      readonly status: 'created';
      readonly ruleId: string;
      readonly mailboxEmail: string;
      /**
       * What was already there under this rule's identity, if anything.
       *
       * Creating is an upsert on a key derived from the rule's own content, so
       * asking for a rule that exists returns it and asking for one that was
       * archived brings it back. Both are right; neither was ever said. A
       * member who archived a rule in March and built the same one in August
       * was shown a new rule already carrying five months of deliveries.
       */
      readonly existing: 'active' | 'paused' | 'archived' | null;
    }
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
      /** Every external recipient, said the way a sentence says them. */
      readonly destination: string;
      /** The same addresses, unjoined, for the card and the replayed request. */
      readonly destinations: readonly string[];
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

/**
 * An edit's endings: every one `create` has, plus the three only an edit can
 * reach.
 *
 * `duplicate` and `duplicate_archived` are kept apart because their remedies
 * are opposites. A live collision means two rules would act on one message —
 * change the conditions. An archived collision means the rule the member wants
 * already exists somewhere they cannot see from here — restore it instead of
 * building a second.
 */
export type MailRuleReplaceResult =
  | {
      readonly status: 'replaced';
      readonly ruleId: string;
      readonly mailboxEmail: string;
      /**
       * The edit took the rule off pause.
       *
       * Reported rather than assumed. Editing a paused rule starts it again —
       * deliberate, and stated in the tool's own instructions — but a member
       * who paused a rule because it misbehaved and then corrected it was never
       * told their mail had started moving.
       */
      readonly resumed: boolean;
    }
  /** Not yours, or not real. The repository makes the two indistinguishable. */
  | { readonly status: 'not_found' }
  /**
   * Real, yours, and archived. Kept apart from `not_found` because the remedies
   * differ: archiving is final, so the way forward is a new rule, not a retry.
   */
  | { readonly status: 'archived' }
  | { readonly status: 'duplicate' }
  | { readonly status: 'duplicate_archived' }
  | Exclude<MailRuleWriteResult, { status: 'created' }>;

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
   * A live check that Google still honours this grant.
   *
   * Everything else about a connection is read from the row Divo stored, and a
   * row says "connected" right up until something tries to use it. A grant
   * ends silently — a password change, a revoked app, long enough since a
   * sign-in — and the first thing to notice is a background watch failing. Last
   * time that took **eleven** failures before any screen said so, while the
   * member's rules quietly did nothing.
   *
   * So one real call, at the one moment it is cheap and decisive: before
   * writing a rule that would otherwise be born dead. The token is cached, so a
   * healthy connection usually answers without leaving the process, and a dead
   * one is marked reauthorization-required by the same call that discovers it.
   */
  probeConnection?(input: {
    companyId: string;
    userId: string;
    connectionId: string;
  }): Promise<
    | { kind: 'alive' }
    | { kind: 'revoked' }
    /** Google could not be reached. Not a refusal — nothing was learnt. */
    | { kind: 'unavailable'; reason: string }
  >;
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
      | { ok: true; value: boolean | 'archived' }
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
      judge: Record<string, unknown> | null;
      dedupeKey: string;
    }): Promise<
      | {
          ok: true;
          value: {
            ruleId: string;
            subscriptionId: string;
            existing?: 'active' | 'paused' | 'archived' | null;
          };
        }
      | { ok: false; error: { message: string } }
    >;
    /**
     * Optional so compositions that only create — the ones built before editing
     * existed — keep type-checking. `replace` answers `unavailable` rather than
     * throwing when it is absent, which is the honest reading: this deployment
     * cannot edit, and that is not the member's mistake.
     */
    replaceRule?(input: {
      companyId: string;
      userId: string;
      ruleId: string;
      connectionId: string;
      name: string;
      match: Record<string, unknown>;
      action: Record<string, unknown>;
      destination: Record<string, unknown>;
      judge: Record<string, unknown> | null;
      dedupeKey: string;
    }): Promise<
      | {
          ok: true;
          value:
            | 'replaced'
            | 'replaced_and_resumed'
            | 'not_found'
            | 'archived'
            | 'duplicate'
            | 'duplicate_archived';
        }
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
  /*
   * Through `mailDestinationKind`, not `type === 'email'`.
   *
   * A routing table's `type` is `routed` and its recipients are one level down,
   * so the straight comparison called every routed rule a Lark delivery — and
   * `parseMailRule` then refused it as "delivery rules require a Lark chat or
   * DM destination", which is a true sentence about a rule nobody wrote.
   */
  return {
    type: mailDestinationKind(destination) === 'email' ? 'forward' : 'deliver',
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
    if (changed.value === 'archived') return { status: 'archived' };
    return changed.value ? { status: 'changed' } : { status: 'not_found' };
  };

  /**
   * Everything that has to be true before a rule may be written, and the
   * canonical row it would be written as.
   *
   * Extracted so `create` and `replace` cannot drift. An edit is not a lesser
   * act than a create: it can move a destination outside the company, point at
   * a Lark room this company has never been in, or resume execution on a
   * connection whose policy has since tightened. A `replace` that skipped any of
   * these would be a way to reach, in two steps, a rule the first step refused —
   * so both callers meet the same sequence and only the final write differs.
   *
   * Returns the refusal itself when it refuses, so neither caller has to
   * re-describe an outcome it did not decide.
   */
  const prepare = async (
    request: MailRuleWriteRequest,
    action: MailRuleAction,
  ): Promise<
    /* `created` is excluded rather than merely never returned: this function
       decides whether a write may happen, not that one did, and typing it that
       way is what lets both callers hand the refusal straight back. */
    | { readonly ok: false; readonly refusal: Exclude<MailRuleWriteResult, { status: 'created' }> }
    | {
        readonly ok: true;
        readonly connectionId: string;
        readonly mailboxEmail: string;
        readonly parsed: {
          match: MailRuleMatch;
          action: MailRuleAction;
          destination: MailRuleDestination;
        };
        readonly dedupeKey: string;
      }
  > => {
    // Nothing polls a mailbox when the workers are off, so a rule written here
    // would sit looking healthy and never fire. This is the flag that took Mail
    // Ops down silently in production for weeks; refusing loudly is the point.
    if (!deps.runtime.pubsubConfigured || !deps.runtime.workersEnabled) {
      return { ok: false, refusal: { status: 'not_configured' } };
    }

    const connection = await deps.resolveConnection({
      companyId: request.companyId,
      userId: request.userId,
      ...(request.connectionId ? { connectionId: request.connectionId } : {}),
    });

    if (connection.status === 'choose_connection') {
      return {
        ok: false,
        refusal: { status: 'choose_connection', connections: connection.connections ?? [] },
      };
    }
    if (connection.status === 'unavailable' || !connection.connectionId || !connection.mailboxEmail) {
      return {
        ok: false,
        refusal: {
          status: 'connection_unavailable',
          reason: connection.reason ?? 'No usable Google account.',
          ...(connection.connectionState ? { connectionState: connection.connectionState } : {}),
        },
      };
    }

    /*
     * Asked before anything is written, and before anybody is asked to approve
     * anything. A rule on a dead grant can never fire, so every question after
     * this one would be about a rule that was never going to run — including,
     * worst of all, a manager being asked to approve an external forward that
     * could not have happened.
     */
    if (deps.probeConnection) {
      const probe = await deps.probeConnection({
        companyId: request.companyId,
        userId: request.userId,
        connectionId: connection.connectionId,
      });
      if (probe.kind === 'revoked') {
        return {
          ok: false,
          refusal: {
            status: 'connection_unavailable',
            reason:
              `Google has ended Divo's authorisation for ${connection.mailboxEmail} — a password `
              + 'change, a revoked app, or simply long enough since you last signed in. Sign in '
              + 'again and this rule can be created; your existing rules resume at the same moment.',
          },
        };
      }
      if (probe.kind === 'unavailable') {
        // Nothing was learnt about the grant, so this is a retry rather than a
        // refusal. Calling it revoked would send somebody reconnecting a
        // working account because Google was briefly unreachable.
        return { ok: false, refusal: { status: 'unavailable', reason: probe.reason } };
      }
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
      if (policy.kind === 'required') {
        return { ok: false, refusal: { status: 'approval_required' } };
      }
      if (policy.kind === 'unavailable') {
        return {
          ok: false,
          refusal: {
            status: 'unavailable',
            reason: policy.message ?? 'Divo could not read the connection policy.',
          },
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
      /*
       * Every place this rule could send mail, not merely its first.
       *
       * A routing table establishes several forwards at once, so reading one
       * address here would ask a manager about one branch and let the rest
       * through unmentioned. `mailDestinationLeaves` answers for both shapes,
       * including the `otherwise` branch — which is the one nobody thinks about
       * and exactly where an unnoticed address ends up.
       */
      const leaving = mailDestinationLeaves(request.destination)
        .flatMap(leaf => leaf.type === 'email' ? [leaf.email] : [])
        .filter(email => mailRuleLeavesOrganisation({
          destinationEmail: email,
          requesterEmail: request.requesterEmail,
        }));

      const verdict = await inspectExternalForward(
        {
          destinations: [...new Set(leaving)],
          companyId: request.companyId,
          requesterId: request.userId,
          departmentId: request.departmentId ?? null,
          requesterCompanyRole: request.companyRole,
        },
        deps.externalForward,
      );
      if (verdict.kind === 'misconfigured') {
        return {
          ok: false,
          refusal: { status: 'external_approval_unavailable', reason: verdict.message },
        };
      }
      if (verdict.kind === 'required') {
        return {
          ok: false,
          refusal: {
            status: 'external_approval_required',
            destination: verdict.destination,
            destinations: verdict.destinations,
            approver: {
              userId: verdict.approver.userId,
              displayName: verdict.approver.displayName,
            },
            connectionId: connection.connectionId,
            mailboxEmail: connection.mailboxEmail,
          },
        };
      }
    }

    // A named chat is grounded here, in code, once — not on every delivery, and
    // not by asking the model nicely in prompt text. A `lark_dm` destination
    // is not grounded because it carries no caller-supplied id to ground: the
    // open id comes from the signed-in session, so its single recipient is
    // already known to be the person who owns the mailbox.
    if (deps.authorizeLarkChat) {
      /*
       * Every chat this rule could reach, not only a top-level one.
       *
       * A routed rule's chats sit one level down, so a check written against
       * `destination.type === 'lark_chat'` skipped the whole table — the rule
       * was accepted with an ungrounded room in a branch, and the first message
       * that sorted into it was spent discovering that. The worker does
       * re-check and abandons rather than delivering, so nothing reached the
       * wrong company; what was lost was the refusal happening while somebody
       * was still looking at the form.
       */
      for (const leaf of mailDestinationLeaves(request.destination)) {
        if (leaf.type !== 'lark_chat') continue;
        const verdict = await deps.authorizeLarkChat({
          companyId: request.companyId,
          chatId: leaf.chatId,
        });
        if (verdict.status !== 'allowed') {
          return {
            ok: false,
            refusal: { status: 'destination_refused', reason: larkRefusal(verdict) },
          };
        }
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
        /*
         * The judge goes in too, and leaving it out was not a tidiness question.
         *
         * `parseMailRule` is where a routing table plus a separate question is
         * refused — two AI steps with no stated order between them. Validating
         * without it accepted that pair here and refused it later, when the
         * *worker* re-parsed the stored row: the member was told the rule was
         * active, and it then reported itself broken and matched nothing.
         * Validate what is about to be written, not a subset of it.
         */
        ...(request.judge ? { judge: request.judge } : {}),
      });
    } catch (cause) {
      return {
        ok: false,
        refusal: {
          status: 'unavailable',
          reason: cause instanceof Error ? cause.message : 'That rule could not be read.',
        },
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

    return {
      ok: true,
      connectionId: connection.connectionId,
      mailboxEmail: connection.mailboxEmail,
      parsed,
      dedupeKey: mailRuleDedupeKey(identity),
    };
  };

  const create = async function writeMailRule(
    request: MailRuleWriteRequest,
    action: MailRuleAction,
  ): Promise<MailRuleWriteResult> {
    const ready = await prepare(request, action);
    if (!ready.ok) return ready.refusal;

    const created = await deps.repo.createRuleForMailbox({
      companyId: request.companyId,
      createdByUserId: request.userId,
      ...(request.departmentId ? { departmentId: request.departmentId } : {}),
      connectionId: ready.connectionId,
      mailboxEmail: ready.mailboxEmail,
      name: request.name,
      match: { ...ready.parsed.match } as Record<string, unknown>,
      action: { ...ready.parsed.action } as Record<string, unknown>,
      destination: { ...ready.parsed.destination } as Record<string, unknown>,
      judge: request.judge ? { ...request.judge } : null,
      dedupeKey: ready.dedupeKey,
    });
    if (!created.ok) {
      return { status: 'unavailable', reason: created.error.message };
    }

    return {
      status: 'created',
      ruleId: created.value.ruleId,
      mailboxEmail: ready.mailboxEmail,
      existing: created.value.existing ?? null,
    };
  };

  /**
   * Edit a rule that already exists.
   *
   * Same preconditions as `create`, by construction — see `prepare`. What only
   * this path can reach is a collision: editing a rule *into* the conditions
   * another rule on the same mailbox already holds. `replaceRule` decides that,
   * and it distinguishes a live collision from an archived one, which matters
   * because an archived rule is not on any screen the member is looking at —
   * "that already exists" without the word archived reads as Divo being wrong.
   */
  const replace = async (
    request: MailRuleWriteRequest & { readonly ruleId: string },
    action: MailRuleAction,
  ): Promise<MailRuleReplaceResult> => {
    if (!deps.repo.replaceRule) {
      return { status: 'unavailable', reason: 'Editing is not available in this environment.' };
    }

    const ready = await prepare(request, action);
    if (!ready.ok) return ready.refusal;

    const replaced = await deps.repo.replaceRule({
      companyId: request.companyId,
      userId: request.userId,
      ruleId: request.ruleId,
      connectionId: ready.connectionId,
      name: request.name,
      match: { ...ready.parsed.match } as Record<string, unknown>,
      action: { ...ready.parsed.action } as Record<string, unknown>,
      destination: { ...ready.parsed.destination } as Record<string, unknown>,
      judge: request.judge ? { ...request.judge } : null,
      dedupeKey: ready.dedupeKey,
    });
    if (!replaced.ok) {
      return { status: 'unavailable', reason: replaced.error.message };
    }

    switch (replaced.value) {
      case 'replaced':
        return {
          status: 'replaced',
          ruleId: request.ruleId,
          mailboxEmail: ready.mailboxEmail,
          resumed: false,
        };
      case 'replaced_and_resumed':
        return {
          status: 'replaced',
          ruleId: request.ruleId,
          mailboxEmail: ready.mailboxEmail,
          resumed: true,
        };
      case 'duplicate':
        return { status: 'duplicate' };
      case 'duplicate_archived':
        return { status: 'duplicate_archived' };
      case 'archived':
        return { status: 'archived' };
      default:
        return { status: 'not_found' };
    }
  };

  return { create, replace, setStatus };
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
