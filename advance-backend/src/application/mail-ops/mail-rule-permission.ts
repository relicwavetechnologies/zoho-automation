/**
 * Who may do what to a mail rule — asked once, answered the same way everywhere.
 *
 * This used to live in two places that disagreed. The agent tool checked the
 * operation's own action group *and* `execute` for anything that makes a rule
 * live; the browser checked `execute` alone for create and update, and checked
 * nothing at all for pause, resume, and archive. So a member whose `update`
 * access had been revoked was refused by Divo in Lark and allowed by the same
 * feature in a browser — and could resume a paused rule that then went on
 * acting on their mail.
 *
 * Divo is supposed to answer to the same person the same way on every surface.
 * That is not something two copies of a rule can be trusted to do, so there is
 * one copy and both callers ask it.
 */
import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';

export type MailRuleOperation =
  | 'list'
  | 'test'
  | 'create'
  | 'update'
  | 'pause'
  | 'resume'
  | 'archive';

/**
 * The action group an operation belongs to.
 *
 * A dry run reads stored mail and stored rules and writes nothing, so it is
 * `read`. Gating it behind `update` would mean the member who most needs to
 * check a rule — one whose edit rights were just taken away — is the one who
 * cannot.
 */
export const mailRuleActionGroup = (
  operation: MailRuleOperation,
): ToolActionGroup => {
  switch (operation) {
    case 'list':
    case 'test': return 'read';
    case 'create': return 'create';
    case 'update':
    case 'pause':
    case 'resume': return 'update';
    case 'archive': return 'delete';
  }
};

/**
 * Operations that leave a rule able to act on mail by itself.
 *
 * These need background `execute` on top of the action group, because the
 * member is not asking to edit a record — they are asking Divo to go on doing
 * something without them. `pause` and `archive` are absent on purpose: taking a
 * rule *out* of service is never gated on the right to put one in.
 */
const NEEDS_EXECUTE: ReadonlySet<MailRuleOperation> = new Set([
  'create',
  'update',
  'resume',
]);

export type MailRulePermissionVerdict =
  | { readonly allowed: true }
  /** Which half of the check failed, so the refusal can say something useful. */
  | { readonly allowed: false; readonly missing: 'action' | 'execute' };

export function mailRulePermission(
  operation: MailRuleOperation,
  granted: ReadonlySet<string> | undefined,
): MailRulePermissionVerdict {
  /*
   * Stopping a rule must never be harder than deleting it.
   *
   * `pause` shares the `update` action group with editing, so a department that
   * revoked `update` to stop members rewriting rules would also have taken away
   * their ability to stop a live one. De-escalation is gated on the capability
   * being withdrawn.
   */
  const hasAction = operation === 'pause'
    ? (granted?.has('update') ?? false) || (granted?.has('delete') ?? false)
    : granted?.has(mailRuleActionGroup(operation)) ?? false;
  if (!hasAction) return { allowed: false, missing: 'action' };

  if (NEEDS_EXECUTE.has(operation) && !(granted?.has('execute') ?? false)) {
    return { allowed: false, missing: 'execute' };
  }
  return { allowed: true };
}

/**
 * What to tell somebody who was refused.
 *
 * Kept beside the decision rather than at each call site: a refusal that names
 * the wrong missing capability sends people asking an administrator for access
 * they already have.
 */
export const mailRuleRefusal = (
  operation: MailRuleOperation,
  missing: 'action' | 'execute',
): string => missing === 'execute'
  ? 'Activating a mail automation also requires background execute access. '
    + 'Ask an administrator for it and this rule can start running.'
  : operation === 'create'
    ? 'You do not have permission to create mail automations, so a rule made here '
      + 'would never act on anything. Ask an administrator for access to Mail automations.'
    : `You do not have permission to ${operation} mail automations. `
      + 'Ask an administrator for access to Mail automations.';
