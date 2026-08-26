import {
  meetsConfidenceFloor,
  type AnalyzedFollowUp,
  type FollowUpAnalysis,
  type FollowUpUrgency,
} from '../../domain/follow-ups/follow-up';

/**
 * Turn one analysis into the writes it implies.
 *
 * Pure, and deliberately separate from both the model call and the database.
 * The real risk in this feature is not "does the model answer" — it is whether
 * a second pass over the same chat *updates* the item it already found or
 * duplicates it, and whether an item nobody mentioned again quietly disappears.
 * Both are decided here, and both are testable with a literal.
 */

export interface FollowUpCreate {
  readonly item: AnalyzedFollowUp;
  readonly remindAt: Date;
}

export interface FollowUpUpdate {
  readonly id: string;
  readonly item: AnalyzedFollowUp;
  /**
   * Only ever earlier than the armed reminder, never later.
   *
   * A refreshed item that restates the same commitment must not push an
   * already-armed nudge further out — otherwise a chat that stays busy keeps
   * postponing its own reminder and the item is never surfaced at all.
   */
  readonly pullRemindAtEarlierTo: Date;
}

export interface FollowUpResolve {
  readonly id: string;
  readonly reason: string;
}

export interface ReconcilePlan {
  readonly create: readonly FollowUpCreate[];
  readonly update: readonly FollowUpUpdate[];
  readonly resolve: readonly FollowUpResolve[];
  /** Items rejected by the confidence floor. Counted so the floor can be tuned. */
  readonly droppedForConfidence: number;
  /** Ids the model invented — not currently tracked in this chat. */
  readonly unknownIds: readonly string[];
}

export interface ReconcileOptions {
  readonly confidenceFloor: number;
  /** Hours before the first nudge, when no date was stated. */
  readonly firstNudgeHours?: Readonly<Record<FollowUpUrgency, number>>;
  readonly now?: Date;
}

const DEFAULT_FIRST_NUDGE_HOURS: Readonly<Record<FollowUpUrgency, number>> = {
  high: 4,
  medium: 24,
  low: 72,
};

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * When to nudge for the first time.
 *
 * A stated deadline wins: nudge the morning before it. Otherwise urgency picks
 * the delay. The floor of fifteen minutes exists because a deadline already in
 * the past would otherwise arm a reminder in the past, which fires instantly and
 * turns a discovered obligation into a notification the moment it is found.
 */
export function initialRemindAt(
  item: AnalyzedFollowUp,
  createdAt: Date,
  hoursByUrgency: Readonly<Record<FollowUpUrgency, number>> = DEFAULT_FIRST_NUDGE_HOURS,
): Date {
  const due = parseDueDate(item.dueDate);
  if (due) {
    const dayBefore = due.getTime() - DAY_MS;
    const target = dayBefore > createdAt.getTime()
      ? dayBefore
      : createdAt.getTime() + HOUR_MS;
    return new Date(Math.max(target, createdAt.getTime() + 15 * 60_000));
  }
  const hours = hoursByUrgency[item.urgency] ?? 24;
  return new Date(createdAt.getTime() + hours * HOUR_MS);
}

function parseDueDate(value: string | null): Date | null {
  if (!value) return null;
  // Nine in the morning, not midnight: "due Friday" means during Friday, and a
  // midnight deadline arms the day-before nudge a full day early.
  const parsed = new Date(`${value}T09:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function reconcileAnalysis(
  analysis: FollowUpAnalysis,
  trackedIds: ReadonlySet<string>,
  options: ReconcileOptions,
): ReconcilePlan {
  const now = options.now ?? new Date();
  const hours = options.firstNudgeHours ?? DEFAULT_FIRST_NUDGE_HOURS;

  const create: FollowUpCreate[] = [];
  const update: FollowUpUpdate[] = [];
  const unknownIds: string[] = [];
  let droppedForConfidence = 0;

  for (const item of analysis.openItems) {
    if (!meetsConfidenceFloor(item, options.confidenceFloor)) {
      droppedForConfidence += 1;
      continue;
    }

    if (item.id === null) {
      create.push({ item, remindAt: initialRemindAt(item, now, hours) });
      continue;
    }

    if (trackedIds.has(item.id)) {
      update.push({
        id: item.id,
        item,
        pullRemindAtEarlierTo: initialRemindAt(item, now, hours),
      });
      continue;
    }

    // An id we are not tracking in this chat. Treated as new rather than
    // written to that id: the alternative is letting a hallucinated — or
    // cross-chat — identifier overwrite somebody else's row.
    unknownIds.push(item.id);
    create.push({ item, remindAt: initialRemindAt(item, now, hours) });
  }

  // Resolutions for ids we never handed over are dropped for the same reason.
  const resolve = analysis.resolved.filter(entry => trackedIds.has(entry.id));
  for (const entry of analysis.resolved) {
    if (!trackedIds.has(entry.id)) unknownIds.push(entry.id);
  }

  return { create, update, resolve, droppedForConfidence, unknownIds };
}
