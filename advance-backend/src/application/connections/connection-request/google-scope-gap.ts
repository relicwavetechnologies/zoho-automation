import { googleScopeGroupsForToolIds } from '../../google/google-scope-request';
import { hasGoogleScopeGroups } from '../../../domain/google/google-workspace-scope';
import type { ScopeGap, ScopeGapReason } from '../../../domain/connections/scope-gap';

/** The skill pointer that reaches the model with the failure it needs to act on. */
export const CONNECTIONS_SKILL_POINTER =
  'Read the connections skill, then call divo_connect_app with provider '
  + '"google_workspace" and the relevant toolIds. Do not provide scopes.';

const INSUFFICIENT_SCOPE_REASONS = new Set([
  'accesstokenscopeinsufficient',
  'insufficientpermissions',
  'insufficientscope',
]);

const NOT_CONNECTED_REASONS = new Set([
  'notconnected',
  'noconnection',
  'noneaccessible',
  'connectionunavailable',
  'authorizationrequired',
]);

/**
 * Classify only the Google failures for which asking for OAuth can help.
 *
 * Google has returned the prose "Request had insufficient authentication
 * scopes." in the real 403 payloads used by Divo. It also returns the stable
 * machine reasons handled below. A bare 403 is deliberately not enough,
 * because Google uses it for quotas and provider-owned configuration errors.
 */
export function classifyGoogleScopeGap(
  toolId: string,
  error: unknown,
  grantedScopes: readonly string[] = [],
): ScopeGap | undefined {
  const text = errorText(error);
  const reason = reasonFrom(error);
  const gapReason = isNotConnected(error, reason, text)
    ? 'not_connected'
    : isInsufficientScope(reason, text)
      ? 'insufficient_scope'
      : undefined;
  if (!gapReason) return undefined;

  return makeGoogleScopeGap(toolId, gapReason, grantedScopes);
}

/** Build the same named gap when the backend already knows no account is usable. */
export function googleConnectionScopeGap(
  toolId: string,
  reason: 'no_connection' | 'missing_scope',
  grantedScopes: readonly string[] = [],
): ScopeGap {
  return makeGoogleScopeGap(
    toolId,
    reason === 'no_connection' ? 'not_connected' : 'insufficient_scope',
    grantedScopes,
  );
}

export function googleScopeGapReasonText(reason: ScopeGapReason): string {
  return reason === 'not_connected'
    ? 'No Google Workspace account is connected for this request.'
    : 'The connected Google Workspace account is missing the scope needed for this request.';
}

function makeGoogleScopeGap(
  toolId: string,
  reason: ScopeGapReason,
  grantedScopes: readonly string[],
): ScopeGap {
  const requiredGroups = googleScopeGroupsForToolIds([toolId]);
  const missingScopeGroups = requiredGroups.filter(group =>
    !hasGoogleScopeGroups(grantedScopes, [group]),
  );
  return {
    provider: 'google_workspace',
    toolId,
    missingScopeGroups,
    reason,
  };
}

function isInsufficientScope(reason: string | undefined, text: string): boolean {
  if (reason && INSUFFICIENT_SCOPE_REASONS.has(normalize(reason))) return true;
  const normalizedText = normalize(text);
  if ([...INSUFFICIENT_SCOPE_REASONS].some(value => normalizedText.includes(value))) return true;
  return /request had insufficient authentication scopes?\.?/i.test(text)
    || /insufficient authentication scopes?/i.test(text);
}

function isNotConnected(error: unknown, reason: string | undefined, text: string): boolean {
  if (reason && NOT_CONNECTED_REASONS.has(normalize(reason))) return true;
  if (typeof error === 'string') {
    return /no (?:google workspace )?(?:account|connection) is connected/i.test(error)
      || /no google (?:workspace )?(?:account|connection)/i.test(error);
  }
  return /no (?:writable personal )?google (?:workspace )?(?:account|connection)[^.!?]*connected/i.test(text)
    || /google (?:workspace )?(?:account|connection) is not connected/i.test(text);
}

function reasonFrom(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ['reason', 'code', 'status']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` ${error.cause.message}` : '';
    return `${error.name} ${error.message}${cause}`;
  }
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    try { return JSON.stringify(error); } catch { return String(error); }
  }
  return String(error);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
