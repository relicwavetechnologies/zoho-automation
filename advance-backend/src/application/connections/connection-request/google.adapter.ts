import type { ConnectionRequestAdapter } from './connection-request.service';
import {
  classifyGoogleScopeGap,
  googleScopeGapReasonText,
} from './google-scope-gap';
import {
  createBeginGoogleAuthorization,
  type BeginGoogleAuthorizationDeps,
} from '../begin-google-authorization';
import type { ScopeGap } from '../../../domain/connections/scope-gap';

/** Adapt the existing Google continuation flow to the provider-neutral asker. */
export function createGoogleConnectionRequestAdapter(
  deps: BeginGoogleAuthorizationDeps,
): ConnectionRequestAdapter {
  const beginGoogleAuthorization = createBeginGoogleAuthorization(deps);

  return {
    classify: input => classifyGoogleScopeGap(input.toolId, input.error),
    request: async input => {
      const authorization = await beginGoogleAuthorization({
        gap: input.gap,
        toolIds: input.gap.toolIds ?? [input.gap.toolId],
        reason: reasonFor(input.gap),
        runContext: input.runContext,
      });
      return authorization.status === 'unavailable'
        ? { status: 'unreachable' }
        : authorization;
    },
  };
}

function reasonFor(gap: ScopeGap): string {
  return googleScopeGapReasonText(gap.reason);
}
