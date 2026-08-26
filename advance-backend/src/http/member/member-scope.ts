import type { Response } from 'express';

/**
 * Who is asking, which department's rows they may see, and whether they may do
 * this at all.
 *
 * Extracted the moment a second router needed it. Both the follow-ups tab and
 * the broadcast tab answer for the same person in the same department, and two
 * copies of "resolve the caller's scope, or answer for them" is the duplicate
 * authority rule 5 forbids — the copy that drifts would be the one deciding
 * whose customer conversations a request may reach.
 *
 * The department is resolved server-side and there is deliberately no parameter
 * for it. Urban Aura shares a company with other departments, and a request that
 * could name its own scope would be one query string away from reading them.
 *
 * Scope and permission are answered together, in that order, because they are
 * not independent: the department overlay is what decides the permission, so
 * there is no useful answer to "may they" before "which department". Returning
 * them as one value also means a route cannot resolve a caller and then forget
 * to check them — the two arrive together or the request has already been
 * answered.
 */

export interface MemberScope {
  readonly companyId: string;
  readonly departmentId: string;
  readonly userId: string;
}

/**
 * Three states, not two.
 *
 * `unavailable` exists because a permission store that could not be read is not
 * a refusal. Answering "denied" when the truth is "we could not check" sends
 * somebody asking an administrator for access they already hold, and the
 * administrator then cannot find anything wrong.
 */
export type MemberAuthorization =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'denied'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string };

export interface MemberScopeDeps<TOperation> {
  /**
   * The member's active department. Shared with mail automations rather than
   * re-derived, for the same reason this helper exists at all.
   */
  readonly resolveDepartmentId: (input: {
    companyId: string;
    userId: string;
  }) => Promise<string | null>;
  /** What the 409 calls this surface, e.g. "Follow-ups" or "Broadcasts". */
  readonly featureName: string;
  /** Optional so tests can build a scope without one. */
  readonly logger?: { error: (message: string, fields: Record<string, unknown>) => void };
  /**
   * Whether this member may perform this operation.
   *
   * Required, not optional. An optional gate is one a router can be mounted
   * without, and a router silently serving another department's conversations
   * because somebody forgot an argument is precisely the failure this exists to
   * prevent. There is one composition and it always has permissions; making the
   * type say so means the mistake cannot compile.
   */
  readonly authorize: (input: {
    readonly companyId: string;
    readonly userId: string;
    readonly departmentId: string;
    readonly companyRole: string;
    readonly operation: TOperation;
  }) => Promise<MemberAuthorization>;
}

/**
 * Build the resolver.
 *
 * Answers on the response and returns `null` when the request may not proceed,
 * so a route reads `const scope = await scoped(res, 'list'); if (!scope) return;`
 * and cannot accidentally continue with a half-resolved or unauthorised caller.
 */
export function createMemberScope<TOperation>(deps: MemberScopeDeps<TOperation>) {
  return async (
    res: Response,
    operation: TOperation,
  ): Promise<MemberScope | null> => {
    const companyId = res.locals['companyId'] as string | undefined;
    const userId = res.locals['userId'] as string | undefined;
    if (!companyId || !userId) {
      res.status(401).json({ ok: false, error: 'unauthenticated' });
      return null;
    }
    /*
     * A database that did not answer is not a member without a department.
     *
     * This await used to be bare, and it is the first thing every route in both
     * routers does. When the tunnel to the development database dropped, the
     * Prisma pool timed out, the rejection escaped an `async` Express handler —
     * which Express 4 does not catch — and the whole backend exited. Eight
     * hours of a stack that looked asleep and was actually dead.
     *
     * Answered as `unavailable`, the same three-state answer the authorizer
     * gives, because that is what it is: try again shortly, not "you are in no
     * department".
     */
    let departmentId: string | null;
    try {
      departmentId = await deps.resolveDepartmentId({ companyId, userId });
    } catch (error) {
      deps.logger?.error('member_scope.department_lookup_failed', {
        feature: deps.featureName,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({
        ok: false,
        code: 'scope_unavailable',
        message: 'Divo could not work out which team you are in just now. Try again shortly.',
      });
      return null;
    }
    if (!departmentId) {
      // Stated rather than treated as an empty list. A member with no department
      // would otherwise see a working, permanently empty tab and conclude the
      // feature is broken.
      res.status(409).json({
        ok: false,
        // `code`, which is the field the browser's own error reader looks in.
        // These used to be sent as `error`, which that reader treats as a
        // fallback *message* — so a refusal arrived with no code at all and the
        // web shell could not tell it apart from a read that failed. Mail Ops
        // has always used `code`; this now matches.
        code: 'no_active_department',
        message: `${deps.featureName} belong to a department. Ask an admin to add you to one.`,
      });
      return null;
    }

    const verdict = await deps.authorize({
      companyId,
      userId,
      departmentId,
      companyRole: String(res.locals['aiRole'] ?? 'MEMBER'),
      operation,
    });
    if (verdict.kind === 'denied') {
      res.status(403).json({ ok: false, code: 'not_permitted', message: verdict.message });
      return null;
    }
    if (verdict.kind === 'unavailable') {
      // 503, not 403. The difference is the whole reason this state exists:
      // one says "you may not", the other says "ask again in a moment".
      res.status(503).json({
        ok: false,
        code: 'permission_unavailable',
        message: verdict.message,
      });
      return null;
    }

    return { companyId, departmentId, userId };
  };
}
