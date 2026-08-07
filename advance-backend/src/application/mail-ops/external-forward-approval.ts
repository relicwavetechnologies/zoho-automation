/**
 * Who has to say yes before a mailbox starts forwarding out of the company.
 *
 * The *judgment* — does this destination leave the organisation — has always
 * been a pure function next door in `external-destination.ts`. What lived only
 * inside `ApprovalGateService` was everything around it: finding the approver,
 * the self-bypass, and failing closed when there is nobody. That made the rule
 * reachable from the agent path and from nowhere else, so the identical rule
 * created in a browser asked no one.
 *
 * So this is the decision, on its own, with a port narrow enough for any caller
 * to hold. The gate keeps its behaviour by mapping the verdict; the web path
 * gets the same answer by calling the same function. Neither reimplements it,
 * which is the only arrangement where the two surfaces cannot drift apart —
 * and they did drift, which is why this exists.
 *
 * Deliberately every external rule, not merely the first to a given domain.
 * Creating a rule is a rare act, and "first time" is state that would have to
 * be right for this to be worth anything.
 */
import type { ResolvedManager } from '../approval/approval.types';

export type ExternalForwardVerdict =
  /** Not a forward, or not one that leaves the requester's own domain. */
  | { readonly kind: 'not_external' }
  /** The requester is the person who would have approved it. */
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'required';
      readonly approver: ResolvedManager;
      /** The address that made this external, for the card and the log. */
      readonly destination: string;
    }
  /** Nobody can answer. Fails closed — this is a refusal, not a warning. */
  | { readonly kind: 'misconfigured'; readonly message: string };

export interface ExternalForwardApprovalPort {
  resolveManager(
    departmentId: string,
    companyId: string,
    options: { excludeUserId?: string; allowCompanyAdminFallback?: boolean },
  ): Promise<ResolvedManager | null>;
  /** Test and single-tenant compositions turn the bypass off. */
  readonly disableManagerSelfBypass?: boolean | undefined;
  onSelfBypass?(input: { userId: string; destination: string }): void;
}

export interface ExternalForwardApprovalInput {
  /**
   * The external address, already extracted — or null when the request
   * establishes no external forward.
   *
   * Extraction differs by caller and must: the gate reads whatever the model
   * sent, before any schema has had a chance to reject it, while the web route
   * holds an already-validated destination. Both use the same predicate
   * (`mailRuleLeavesOrganisation`) to decide externality, so the two extractors
   * cannot disagree about what "outside the company" means.
   */
  readonly destination: string | null;
  readonly companyId: string;
  readonly requesterId: string;
  readonly departmentId: string | null;
}

export async function inspectExternalForward(
  input: ExternalForwardApprovalInput,
  port: ExternalForwardApprovalPort,
): Promise<ExternalForwardVerdict> {
  const { destination } = input;
  if (!destination) return { kind: 'not_external' };

  if (!input.departmentId) {
    /*
     * Fails closed, and says the true thing.
     *
     * This used to fall into the sentence below — "none could be found" — which
     * is a claim about the company when the fact is that Divo never looked. On
     * the web path it was reached every single time, because the department was
     * read from a field only Pi runtime tokens carry, and it sent somebody to
     * go and appoint a manager they already had.
     */
    return {
      kind: 'misconfigured',
      message:
        `Forwarding mail to ${destination} leaves your organisation, so it needs `
        + 'approval — but Divo could not work out which department you are in, so '
        + 'it does not know whose approval to ask for. Ask an administrator to '
        + 'put you in a department.',
    };
  }

  const approver = await port.resolveManager(input.departmentId, input.companyId, {
    excludeUserId: input.requesterId,
    allowCompanyAdminFallback: true,
  });

  if (!approver) {
    // Fails closed. The alternative is a silent standing forward to an address
    // nobody in the company chose.
    return {
      kind: 'misconfigured',
      message:
        `Forwarding mail to ${destination} leaves your organisation, so it `
        + 'needs a manager or company admin to approve it — and none with a '
        + 'connected Lark account could be found.',
    };
  }

  if (!port.disableManagerSelfBypass && input.requesterId === approver.userId) {
    port.onSelfBypass?.({ userId: input.requesterId, destination });
    return { kind: 'allowed' };
  }

  return { kind: 'required', approver, destination };
}
