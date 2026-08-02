/**
 * The rules a connection carries, and how they are edited.
 *
 * Kept apart from `use-connections` because none of it needs React or a token:
 * it is the shape the backend stores, plus the three transforms the drawer
 * applies to it. That makes it testable directly, which matters more here than
 * usual — a policy sent in the wrong shape is refused by the backend with a
 * 400, and a policy sent in a *valid* wrong shape silently changes what Divo
 * is allowed to do without asking.
 */

/**
 * The six action groups a connection policy can speak about. Same list the
 * backend enforces on, in the same order, so a policy written here reads the
 * same way in the runtime that applies it.
 */
export const CONNECTION_ACTIONS = ['read', 'create', 'update', 'delete', 'send', 'execute'] as const
export type ConnectionAction = typeof CONNECTION_ACTIONS[number]

/** Who has to say yes. `connection_owner` is whoever connected the account. */
export type ConnectionApprovalMode = 'none' | 'connection_owner' | 'company_admin'

export type ConnectionActionPolicy = {
  mode: 'inherit' | 'enforced'
  /**
   * Rate caps are stored and enforced but not edited here — see the note on
   * `setActionPolicy`. They are carried through untouched.
   */
  requestsPerMinute?: number | null
  requestsPerDay?: number | null
  approval?: ConnectionApprovalMode
}

export type ConnectionGovernancePolicy = {
  version: 1
  actions: Partial<Record<ConnectionAction, ConnectionActionPolicy>>
}

export type ConnectionGovernance = {
  /** What the connection's owner or admin set. Editable from the You scope. */
  managerPolicy: ConnectionGovernancePolicy
  managerConfiguredAt: string | null
  /** A company admin's higher-precedence policy. Read-only here. */
  adminOverride: ConnectionGovernancePolicy | null
  adminOverriddenAt: string | null
  source: 'platform_default' | 'manager_policy' | 'company_admin_override'
  version: number
}

export const defaultGovernancePolicy = (): ConnectionGovernancePolicy => ({
  version: 1,
  actions: Object.fromEntries(
    CONNECTION_ACTIONS.map((action) => [action, { mode: 'inherit' as const }]),
  ) as ConnectionGovernancePolicy['actions'],
})

/**
 * Sets one action's rule, leaving everything else in the policy alone.
 *
 * Three things it is careful about. The backend refuses an enforced action
 * with no approval mode, so switching to `enforced` seeds one rather than
 * sending a policy that 400s. Going back to the platform default clears the
 * action outright — keeping a stale approver on an inherited action would mean
 * the next person to enforce it silently inherits a decision nobody made. And
 * the stored rate caps survive an enforced-to-enforced edit: they are not
 * editable on this screen — six numbers per action buried the one control
 * anybody reaches for — but dropping them here would delete limits set
 * elsewhere without saying so.
 */
export function setActionPolicy(
  policy: ConnectionGovernancePolicy,
  action: ConnectionAction,
  update: Partial<ConnectionActionPolicy>,
): ConnectionGovernancePolicy {
  const current = policy.actions[action] ?? { mode: 'inherit' as const }
  const next = { ...current, ...update }
  return {
    ...policy,
    actions: {
      ...policy.actions,
      [action]: next.mode === 'enforced'
        ? { ...next, approval: next.approval ?? 'connection_owner' }
        : { mode: 'inherit' as const },
    },
  }
}

/**
 * Whether two policies would produce the same rules.
 *
 * Not a deep equality: an inherited action's leftover fields do not change what
 * Divo does, and comparing them would light up the unsaved-changes bar for an
 * edit that has no effect.
 */
export const samePolicy = (a: ConnectionGovernancePolicy, b: ConnectionGovernancePolicy): boolean =>
  CONNECTION_ACTIONS.every((action) => {
    const left = a.actions[action] ?? { mode: 'inherit' }
    const right = b.actions[action] ?? { mode: 'inherit' }
    if (left.mode !== right.mode) return false
    if (left.mode === 'inherit') return true
    return (left.approval ?? 'connection_owner') === (right.approval ?? 'connection_owner')
  })

/**
 * The grants worth showing somebody, which is not all of them.
 *
 * Connecting an account writes a `user` grant to whoever connected it, on top
 * of their being the owner. It is bookkeeping: access resolution already gives
 * the owner `admin` from ownership alone — `bestAccess([...directOwnerAccess,
 * ...grantAccess])` — so the row grants nothing that ownership has not already
 * given.
 *
 * Rendering it put the owner on screen twice, once as "You · Owner" and once as
 * themselves "shared by you", with a Revoke button next to the second. That
 * button is the real problem: it offers to take away access that would survive
 * it, so pressing it looks like it did something and did nothing.
 *
 * Only the owner's own grant is dropped. A company-owned connection writes the
 * same initial grant to whoever created it, and that person is *not* the owner
 * — their access really does come from the grant, and revoking it really does
 * remove it.
 */
export function sharedGrants<T extends { granteeType: string; granteeId: string }>(
  grants: T[],
  ownerId: string | null | undefined,
): T[] {
  if (!ownerId) return grants
  return grants.filter((grant) => !(grant.granteeType === 'user' && grant.granteeId === ownerId))
}

/**
 * A granted scope, as something a person can read.
 *
 * Deliberately generic rather than a per-provider lookup table: Google hands
 * back URLs, Lark colon-delimited paths and Zoho dotted names, and a table
 * would silently fall back to the raw string for every provider nobody had got
 * round to. Stripping the URL and splitting the separators reads acceptably for
 * all three and never hides a scope it does not recognise.
 */
export function scopeLabel(scope: string): string {
  const tail = scope.replace(/^https?:\/\/[^/]+\/auth\//, '').replace(/^userinfo\./, '')
  if (tail === 'openid' || tail === '') return 'Sign-in'
  const words = tail.split(/[.:/_]+/).filter(Boolean)
  if (words.length === 0) return scope
  return words.map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(' ')
}
