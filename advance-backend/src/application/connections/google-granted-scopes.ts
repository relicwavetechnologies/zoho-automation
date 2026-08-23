import { googleScopeGroupsForToolIds } from '../google/google-scope-request';

/**
 * What Google actually handed back, named in the words the ask used.
 *
 * The distinction this exists to keep is between what was requested and what
 * was granted. A member can approve some of a consent screen and decline the
 * rest, so a run that assumes it received everything it asked for will confidently
 * do the wrong thing. Every reader of a finished authorization goes through
 * here, so that assumption has one place it could be made and it is not made.
 */
export function grantedGoogleScopeGroups(
  requestedToolIds: readonly string[],
  grantedScopes: readonly string[] | undefined,
): readonly string[] {
  /*
   * A connection with no scope list has granted nothing. It is not an error:
   * reading `.map` off an absent list throws a TypeError naming no cause, and
   * a caller that classifies failures by their words can only file that under
   * its catch-all, reporting a specific failure as a generic one.
   */
  const granted = new Set((grantedScopes ?? []).map(normalizeScope));
  return googleScopeGroupsForToolIds(requestedToolIds).map(group => {
    const actual = group
      .filter(scope => granted.has(normalizeScope(scope)))
      .map(scope => shortScopeName(scope));
    return actual.length > 0 ? actual.join(' or ') : 'none returned';
  });
}

/** The granted groups as the run should read them back. */
export function grantedScopeGroupLines(groups: readonly string[]): string {
  return groups.length > 0
    ? groups.map((group, index) => `- group ${index + 1}: ${group}`).join('\n')
    : '- no requested Google scope groups were returned';
}

function normalizeScope(scope: string): string {
  return scope.trim().toLowerCase().replace(/\/$/, '');
}

function shortScopeName(scope: string): string {
  const normalized = normalizeScope(scope);
  const marker = normalized.lastIndexOf('/');
  return marker >= 0 ? normalized.slice(marker + 1) : normalized;
}
