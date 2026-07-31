/**
 * Errors a user is allowed to read.
 *
 * Most failures must not be shown: they carry stack traces, provider payloads,
 * and internal identifiers, and "something went wrong" is the honest summary.
 * But a *policy* refusal is different — "this model is not enabled for your
 * account" is the entire answer, and hiding it behind a generic apology sends
 * the user to retry something that will never work and an engineer to read logs
 * for something that is not a bug.
 *
 * So the rule is opt-in: an error says explicitly that its message is safe to
 * show, and everything else stays generic by default.
 */

const USER_FACING = Symbol.for('divo.userFacingMessage');

export interface UserFacingError extends Error {
  readonly [USER_FACING]: string;
}

/** Mark an error's message as safe to show to the person who caused it. */
export const asUserFacing = <E extends Error>(error: E, message: string): E => {
  Object.defineProperty(error, USER_FACING, {
    value: message,
    enumerable: false,
    configurable: true,
  });
  return error;
};

/**
 * The user-safe message from an error or anything it wraps, if there is one.
 *
 * Walks `cause` because the error that reaches the surface is rarely the one
 * that knew why: a policy refusal deep in the model layer arrives wrapped in
 * an orchestration error, and only the innermost one can say what to tell the
 * user. Depth-bounded so a self-referencing cause cannot spin.
 */
export const userFacingMessageOf = (error: unknown, maxDepth = 8): string | null => {
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object') {
      const message = (current as Record<symbol, unknown>)[USER_FACING];
      if (typeof message === 'string' && message.trim()) return message;
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    return null;
  }
  return null;
};
