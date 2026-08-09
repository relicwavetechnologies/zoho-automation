/**
 * Which product a session is handed.
 *
 * Divo has two audiences in one build, and until now both saw the same app. A
 * company admin needs the workspace — scopes, AI Ops, an audit log, a settings
 * takeover with four groups in it. A member who was given Divo so that their
 * invoices stop being forwarded by hand needs Mail, and every additional row in
 * front of them is a thing to be wrong about.
 *
 * The distinction is not a new flag. `scopesFor` already answers it: everyone
 * gets `you`, a department manager also gets `team`, a company admin also gets
 * `company`. So *only* holding `you` is precisely "this person administers
 * nothing", and that is the whole test. Deriving it rather than storing it
 * means there is no second opinion to drift — the moment somebody is made a
 * manager, their next session carries a second scope and the workspace appears,
 * with nothing to migrate and no cache to bust.
 *
 * Deliberately not a preference. A member cannot switch this on to go looking
 * around, and an admin cannot switch it off to "see what members see" — the
 * second is a real need and it wants an impersonation feature with an audit
 * trail behind it, not a toggle that quietly changes what the nav claims.
 */
import type { Scope } from './types'

export type Surface = 'mail' | 'workspace'

export const surfaceFor = (scopes: Scope[]): Surface =>
  scopes.length === 1 && scopes[0]?.kind === 'you' ? 'mail' : 'workspace'

export const isMailSurface = (scopes: Scope[]): boolean => surfaceFor(scopes) === 'mail'
