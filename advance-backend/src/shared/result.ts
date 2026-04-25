export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const map = <T, U, E>(
  r: Result<T, E>,
  f: (t: T) => U,
): Result<U, E> => (r.ok ? ok(f(r.value)) : r);

export const mapErr = <T, E, F>(
  r: Result<T, E>,
  f: (e: E) => F,
): Result<T, F> => (r.ok ? r : err(f(r.error)));

export const andThen = <T, U, E>(
  r: Result<T, E>,
  f: (t: T) => Result<U, E>,
): Result<U, E> => (r.ok ? f(r.value) : r);

export const match = <T, E, R>(
  r: Result<T, E>,
  on: { ok: (t: T) => R; err: (e: E) => R },
): R => (r.ok ? on.ok(r.value) : on.err(r.error));

export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error(`unwrap called on Err: ${JSON.stringify(r.error)}`);
  return r.value;
};

export const unwrapErr = <T, E>(r: Result<T, E>): E => {
  if (r.ok) throw new Error(`unwrapErr called on Ok: ${JSON.stringify(r.value)}`);
  return r.error;
};

/** Wrap async infra calls that may throw into a Result. */
export const asyncTry = async <T>(
  fn: () => Promise<T>,
  onError: (e: unknown) => never extends T ? never : any,
): Promise<Result<T, ReturnType<typeof onError>>> => {
  try {
    return ok(await fn());
  } catch (e) {
    return err(onError(e));
  }
};
