/**
 * The agent's routing boundary for governed connected work.
 *
 * The backend still enforces permissions, approvals, rate limits, and
 * credentials. These constants only tell the agent which execution shape
 * preserves a coherent run, and keep published skills from drifting apart.
 */
export const GOVERNED_DIRECT_ACTION_CRITERION =
  'one straightforward, independently meaningful connected-service action';

export const GOVERNED_LOCAL_WORKFLOW_CRITERION =
  'pagination, a record set plus parsing/transformation/grouping/deduplication/joining, related writes, or more than one connected product';

export const GOVERNED_LOCAL_WORKFLOW_ROUTE =
  `Use credential-free \`divo-local\` from one persistent Python file only when the work has ${GOVERNED_LOCAL_WORKFLOW_CRITERION}.`;

/**
 * Every mention of `divo-local` in a published skill must keep availability
 * explicit because not every runtime bundles the broker launcher.
 */
export const GOVERNED_LOCAL_AVAILABLE_RUNTIME = 'When `divo-local` is available in the current runtime';
