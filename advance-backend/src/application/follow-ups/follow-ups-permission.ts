import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';

/**
 * Who may do what on the Follow-ups tab — asked once, answered the same way
 * everywhere.
 *
 * Written as a shared module on the first day it has one caller, because Mail
 * Ops shows what the second one costs. There the agent tool and the browser
 * each grew their own copy of the rule, they disagreed, and a member whose
 * `update` access had been revoked was refused by Divo in Lark and allowed by
 * the same feature in a browser. Follow-ups will get an agent tool — reading
 * what a number is owed is exactly the sort of thing somebody will ask Divo in
 * chat — and when it does, it asks this.
 *
 * The capability is `whatsappFollowUps`, split by action group:
 *
 *   read    the tab, the follow-ups, the numbers, the conversations
 *   update  marking an item handled, muting a chat, linking a handset
 *   send    the broadcast tab, in full
 *
 * `send` is separate because it is the only thing here that leaves the
 * building. Everything else edits Divo's own record of a conversation; a
 * broadcast messages a company's customers from a real handset and cannot be
 * taken back by clicking again.
 */

export type FollowUpsOperation =
  /* Reading. */
  | 'list'
  | 'listNumbers'
  | 'listChats'
  | 'pairingStatus'
  /* Writing to Divo's own record. */
  | 'resolve'
  | 'muteChat'
  | 'linkNumber'
  | 'pairingCode'
  | 'reread'
  /* Sending. */
  | 'listBroadcasts'
  | 'readBroadcast'
  | 'pickRecipients'
  | 'previewBroadcast'
  | 'sendBroadcast'
  | 'cancelBroadcast'
  /* Scheduling what Divo posts to the team's room. */
  | 'readDigest'
  | 'setDigest';

/**
 * The action group an operation belongs to.
 *
 * Linking a handset sits under `update` rather than behind its own gate. It is
 * the most consequential thing here that is not a send — Divo begins reading
 * every conversation on that phone — but it also cannot be done from a desk:
 * somebody has to hold the handset and scan a rotating QR code. That physical
 * step is the real gate, and adding a second capability for it would make the
 * access screen harder to read without making the phone harder to link.
 *
 * The whole broadcast surface is `send`, including its reads. The recipient
 * picker and the history are not general-purpose views that happen to live
 * there — they are the tab, and showing them to somebody who cannot send is a
 * dead end with a disabled button at the end of it.
 *
 * The digest is `send` for the same reason and one more. Reading it is reading
 * a schedule and the record of what already went out, which is the same dead
 * end; and setting it decides what the whole team is told and when, which is
 * the authority a broadcast needs rather than the one editing your own list
 * needs. It is not a second capability: somebody who may send on behalf of this
 * department may also schedule what gets sent.
 */
export const followUpsActionGroup = (
  operation: FollowUpsOperation,
): ToolActionGroup => {
  switch (operation) {
    case 'list':
    case 'listNumbers':
    case 'listChats':
    case 'pairingStatus':
      return 'read';
    case 'resolve':
    case 'muteChat':
    case 'linkNumber':
    case 'pairingCode':
    case 'reread':
      return 'update';
    case 'listBroadcasts':
    case 'readBroadcast':
    case 'pickRecipients':
    case 'previewBroadcast':
    case 'sendBroadcast':
    case 'cancelBroadcast':
    case 'readDigest':
    case 'setDigest':
      return 'send';
  }
};

export type FollowUpsPermissionVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly missing: ToolActionGroup };

export function followUpsPermission(
  operation: FollowUpsOperation,
  granted: ReadonlySet<string> | undefined,
): FollowUpsPermissionVerdict {
  /*
   * Stopping a send must never be harder than starting one.
   *
   * A broadcast to a hundred people paced three seconds apart runs for five
   * minutes, and the person who started it is not always the person watching it
   * go wrong. Anyone who may edit this department's follow-ups may pull the
   * cord, whether or not they could have sent it — the same reason Mail Ops
   * refuses to gate `pause` on the right to create.
   */
  if (operation === 'cancelBroadcast') {
    return (granted?.has('send') ?? false) || (granted?.has('update') ?? false)
      ? { allowed: true }
      : { allowed: false, missing: 'send' };
  }

  const required = followUpsActionGroup(operation);
  return granted?.has(required)
    ? { allowed: true }
    : { allowed: false, missing: required };
}

/**
 * Where the granted actions come from.
 *
 * Not from `TOOL_CAPABILITY_DEFINITIONS`. That registry is Divo's *agent*
 * capability taxonomy, and three parity tests enforce what it means: every
 * canonical tool id has a typed Pi tool behind it, in the Cloud Pi allowlist
 * and the native catalogue. Registering follow-ups there to borrow the
 * department permission matrix would have put `divo_whatsapp_follow_ups` in
 * front of Divo as something it could be asked to run — including sending a
 * broadcast, which this feature deliberately refuses to let Divo compose.
 *
 * So the grant is the two things that are already true about this feature and
 * already audited: which department a handset is linked to, and who leads that
 * department.
 *
 *   you lead the department            read, update and send, from day one
 *   you are a member of it, and it has
 *     a linked handset                  read, and update what it found
 *   anyone else                         nothing
 *
 * The manager's row does not wait for a handset, and that is the whole reason
 * it is separate. Linking the first number *is* an `update`, so gating the
 * manager on a number already existing left them unable to set up their own
 * department: the grant could only be produced by the act it was gating. A
 * company admin could break the circle from outside, which is a workaround, not
 * a design — the person who leads a team is the person who should be able to
 * start it.
 *
 * Members are still gated on a handset existing, for a different reason: not
 * authority but honesty. A tab in a department nobody has linked a number to
 * has nothing to show, and an empty list reads as a broken feature rather than
 * as a department that has not been set up yet.
 */
export interface FollowUpsStanding {
  /** Company admins hold every capability, here as everywhere else. */
  readonly isCompanyAdmin: boolean;
  /** An active membership in the department this request resolved to. */
  readonly isDepartmentMember: boolean;
  /** That membership's role is the department's manager role. */
  readonly isDepartmentManager: boolean;
  /**
   * The department has at least one linked WhatsApp number.
   *
   * Read only for ordinary members. A department nobody has linked a handset to
   * has no conversations to show them, and an empty tab there reads as broken
   * rather than as not-yet-set-up. Whoever leads the department is exempt: they
   * are the one who links it.
   */
  readonly departmentHasNumber: boolean;
}

const FULL = ['read', 'update', 'send'] as const;

export function followUpsGrants(standing: FollowUpsStanding): ReadonlySet<string> {
  // Both of these come before the handset test, because both are people who
  // are expected to create the first one.
  if (standing.isCompanyAdmin) return new Set(FULL);
  if (standing.isDepartmentMember && standing.isDepartmentManager) return new Set(FULL);

  if (!standing.isDepartmentMember || !standing.departmentHasNumber) return new Set();
  return new Set(['read', 'update']);
}

/**
 * What to tell somebody who was refused.
 *
 * Kept beside the decision rather than at each call site: a refusal naming the
 * wrong capability sends people asking an administrator for access they already
 * hold, and the administrator then cannot find the switch they were asked for.
 */
export const followUpsRefusal = (missing: ToolActionGroup): string => {
  switch (missing) {
    case 'send':
      return 'You do not have permission to send WhatsApp broadcasts. '
        + 'Ask an administrator for Send access to WhatsApp Follow-ups.';
    case 'update':
      return 'You can read follow-ups but not change them. '
        + 'Ask an administrator for Edit access to WhatsApp Follow-ups.';
    default:
      return 'You do not have access to WhatsApp Follow-ups. '
        + 'Ask an administrator to grant it to your department.';
  }
};
