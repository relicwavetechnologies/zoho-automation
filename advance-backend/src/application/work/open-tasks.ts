/**
 * What this person still has to do, as far as Divo can see.
 *
 * One call answers it. Everything that makes the question hard — which stored
 * connection carries their Lark identity, that reading their tasks needs a user
 * token rather than the app's, that Lark returns tasks in no useful order and
 * dates in a shape nobody wants to sort on — stays in here, because every one of
 * those is a fact a caller would otherwise have to learn and get right.
 *
 * **The identity is deliberately not taken from the run context.** A Lark run
 * carries the member's `open_id` in `userExternalId`, and a web run carries
 * their Divo user id in the same field — `web-chat.routes.ts` says so in a
 * comment. Anything that reads that field and hands it to Lark as an assignee
 * gets zero rows on the web and reports it as an empty task list, which is a
 * confident wrong answer rather than a failure. So identity is resolved here,
 * from the connection that actually holds an `open_id`.
 *
 * The reading is a union rather than a bare array for the same reason: "you have
 * no tasks" and "Divo cannot see your tasks" look identical as `[]`, and only
 * one of them is worth telling somebody about.
 */

/** One thing waiting on this person. */
export interface OpenTask {
  readonly taskId: string;
  readonly title: string;
  /** ISO date, when Lark has one. Plenty of real tasks do not. */
  readonly dueDate?: string;
  readonly overdue: boolean;
}

export type OpenTasksReading =
  | { readonly status: 'ok'; readonly tasks: readonly OpenTask[] }
  /** No Lark account is linked, so there is nothing to read — not zero tasks. */
  | { readonly status: 'no_lark_identity' }
  /** Linked, but the stored authorization will not currently grant a token. */
  | { readonly status: 'not_connected' };

/** The narrowest view of a Lark task client this needs. */
export interface OpenTaskSource {
  listTasks(params: {
    limit?: number;
    assigneeOpenId?: string;
    completed?: boolean;
  }): Promise<Array<{ taskId: string; title: string; completed: boolean; dueDate?: string }>>;
}

/** Which Lark account, if any, belongs to this member. */
export interface LarkAccountReader {
  openIdFor(input: { userId: string }): Promise<string | null>;
}

/** A short-lived user token, resolved by the backend and never handed outward. */
export interface OpenTasksTokenResolver {
  resolve(input: {
    userId: string;
    companyId: string;
    minimumAccess: 'read_only' | 'read_write';
  }): Promise<string | null | { status: string; accessToken?: string }>;
}

export interface OpenTasksDeps {
  readonly accounts: LarkAccountReader;
  readonly tokens: OpenTasksTokenResolver;
  readonly createClient: (userToken: string) => OpenTaskSource;
}

/** Past this, a "what's waiting on me" panel has stopped being a list. */
const MAX_TASKS = 25;

/**
 * Overdue first, then soonest, then everything undated.
 *
 * Lark returns tasks in creation order, which puts a thing due tomorrow below
 * one with no date at all. Undated tasks sort last rather than first because an
 * absent deadline is the weakest claim on somebody's attention, not the
 * strongest.
 */
function byUrgency(a: OpenTask, b: OpenTask): number {
  if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
  if (a.dueDate) return -1;
  if (b.dueDate) return 1;
  return a.title.localeCompare(b.title);
}

export async function readOpenTasks(
  deps: OpenTasksDeps,
  input: {
    readonly userId: string;
    readonly companyId: string;
    readonly limit?: number;
    /** Injected so "overdue" is testable without waiting for tomorrow. */
    readonly now?: Date;
  },
): Promise<OpenTasksReading> {
  const openId = await deps.accounts.openIdFor({ userId: input.userId });
  if (!openId) return { status: 'no_lark_identity' };

  const resolved = await deps.tokens.resolve({
    userId: input.userId,
    companyId: input.companyId,
    // Reading somebody's tasks must never be able to change them, whatever the
    // stored authorization would otherwise allow.
    minimumAccess: 'read_only',
  });

  const token = typeof resolved === 'string'
    ? resolved
    : resolved && typeof resolved === 'object' && resolved.status === 'resolved'
      ? resolved.accessToken
      : undefined;
  if (!token) return { status: 'not_connected' };

  const limit = Math.min(Math.max(1, input.limit ?? MAX_TASKS), MAX_TASKS);
  const raw = await deps.createClient(token).listTasks({
    assigneeOpenId: openId,
    completed: false,
    limit,
  });

  // Compared as calendar dates, not instants. A task due today is not overdue
  // at nine in the morning, and comparing an ISO date against a timestamp makes
  // it so for all but the first moment of the day.
  const today = (input.now ?? new Date()).toISOString().slice(0, 10);

  const tasks = raw
    .filter((task) => !task.completed)
    .map((task): OpenTask => ({
      taskId: task.taskId,
      title: task.title,
      ...(task.dueDate ? { dueDate: task.dueDate.slice(0, 10) } : {}),
      overdue: task.dueDate ? task.dueDate.slice(0, 10) < today : false,
    }))
    .sort(byUrgency)
    .slice(0, limit);

  return { status: 'ok', tasks };
}
