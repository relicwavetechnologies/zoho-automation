/**
 * Which Google scopes one request actually needs.
 *
 * Divo used to ask every member for all forty Workspace scopes at once, on the
 * first connect, whatever they had asked for. Somebody who wanted a rule that
 * forwards one sender's mail had to hand over Drive, Calendar, Contacts and
 * Apps Script to get it — and the consent screen said so, in a list nobody
 * reads and everybody is right to distrust.
 *
 * The scope groups per product already existed in the MCP manifest and nothing
 * consulted them when building an authorization. This module is that missing
 * step: given the tools a blocked run wanted, it returns the smallest set of
 * scopes that unblocks it. Narrow requests are sent without Google's
 * incremental scope merge, so an account that previously granted Drive does
 * not see Drive again while connecting Mailer.
 */
import { GOOGLE_SCOPE } from '../../domain/google/google-workspace-scope';
import { GOOGLE_WORKSPACE_PRODUCTS } from './google-workspace-mcp-manifest';

/**
 * Identity, carried by every authorization.
 *
 * The callback reads the account's address to key the connection, so a grant
 * without these is not a connection Divo can file — it is an anonymous token.
 */
export const GOOGLE_BASE_OAUTH_SCOPES: readonly string[] = Object.freeze([
  GOOGLE_SCOPE.openid,
  GOOGLE_SCOPE.userInfoEmail,
  GOOGLE_SCOPE.userInfoProfile,
]);

/**
 * Tools that need Google access without being Workspace product tools.
 *
 * `mailAutomations` names `gmailSend` explicitly rather than leaning on
 * `gmailModify`. Divo's implication table says modify covers send; Google's
 * does not, and while all forty scopes were always requested that difference
 * could never show. Asking for the mail group alone is exactly the case that
 * exposes it, and the symptom would be a rule that matches, reserves a
 * delivery, and then fails at the send with a permission error the member
 * cannot act on.
 */
const EXTRA_TOOL_SCOPE_GROUPS: Readonly<Record<string, readonly (readonly string[])[]>> =
  Object.freeze({
    mailAutomations: [
      [GOOGLE_SCOPE.gmailModify],
      [GOOGLE_SCOPE.gmailSend],
      [GOOGLE_SCOPE.gmailLabels],
    ],
  });

/**
 * The groups a set of tools requires, read/write together.
 *
 * Read and write are not split at this layer on purpose. A member connecting
 * for Gmail is not helped by consenting to read now and to write forty seconds
 * later when the same rule needs to forward — that is two scary screens where
 * one was honest. The split stays available in the manifest for permission
 * checks, which is where it earns its keep.
 */
export function googleScopeGroupsForToolIds(
  toolIds: readonly string[],
): readonly (readonly string[])[] {
  const groups: (readonly string[])[] = [];
  const seen = new Set<string>();

  const add = (group: readonly string[]) => {
    const key = group.join('|');
    if (seen.has(key)) return;
    seen.add(key);
    groups.push(group);
  };

  for (const toolId of toolIds) {
    const product = GOOGLE_WORKSPACE_PRODUCTS.find(item => item.toolId === toolId);
    if (product) {
      for (const group of product.readScopeGroups) add(group);
      for (const group of product.writeScopeGroups) add(group);
    }
    for (const group of EXTRA_TOOL_SCOPE_GROUPS[toolId] ?? []) add(group);
  }

  return groups;
}

/**
 * The scopes to put in front of the member, narrowest first.
 *
 * A group is a list of alternatives ordered from least to most access, and the
 * first entry is by construction the one that satisfies the requirement with
 * the least reach. Asking for the broadest would satisfy the same check while
 * quietly taking more than the request needed, which is the habit this whole
 * change exists to break.
 *
 * Returns nothing when no group maps, which the caller reads as "ask for the
 * full set" — the behaviour every request had before this module existed.
 * Identity scopes alone would be worse than the problem being fixed: the
 * connection would save, be picked as the member's Google account, and then
 * fail every tool with a permission error nobody can act on. A tool this does
 * not know about is a gap in this table, and the member should not pay for it.
 */
export function googleScopesToRequestForToolIds(
  toolIds: readonly string[],
): readonly string[] {
  const groups = googleScopeGroupsForToolIds(toolIds);
  if (groups.length === 0) return [];

  const scopes = new Set<string>(GOOGLE_BASE_OAUTH_SCOPES);
  for (const group of groups) {
    const narrowest = group[0];
    if (narrowest) scopes.add(narrowest);
  }
  return [...scopes];
}
