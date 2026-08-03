/**
 * The desktop agent's only routing boundary for governed connected work.
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
 * Every mention of `divo-local` in a published skill must carry this qualifier.
 *
 * The CLI is a desktop execution shape. Server channels run in the cloud Pi
 * container, whose `/tmp` is mounted `noexec` and whose governed work already
 * goes through the runtime's own tool surface. A skill line that names
 * `divo-local` without this qualifier sends a Lark run hunting for a binary it
 * cannot execute — observed as seven wasted turns on a run that had already
 * read its data successfully through the governed tool.
 */
export const GOVERNED_LOCAL_DESKTOP_ONLY = 'In Divo Desktop only';
