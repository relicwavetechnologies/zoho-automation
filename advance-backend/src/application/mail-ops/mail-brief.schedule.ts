/**
 * When the next brief goes out.
 *
 * The mechanism moved to `application/scheduling/recurring-schedule.ts` when the
 * follow-up digest became its second caller: "several times a day, on these
 * weekdays, in this timezone" is a scheduling concept, not a mail one, and one
 * careful DST implementation is worth more than two.
 *
 * The names here are kept because five call sites already use them and renaming
 * would be churn. Everything below is mail's *policy* — its defaults, its window
 * bounds — over the shared mechanism.
 */
import {
  SCHEDULE_WEEKDAYS,
  nextRecurringRunAt,
  recurringScheduleSchema,
  windowStartFrom,
  type RecurringSchedule,
  type ScheduleWeekday,
} from '../scheduling/recurring-schedule';

export const MAIL_BRIEF_WEEKDAYS = SCHEDULE_WEEKDAYS;
export type MailBriefWeekday = ScheduleWeekday;

export const mailBriefScheduleSchema = recurringScheduleSchema;
export type MailBriefSchedule = RecurringSchedule;

/** Twice on workdays. What almost everybody wants, and nobody has to choose it. */
export const DEFAULT_MAIL_BRIEF_SCHEDULE: MailBriefSchedule = {
  times: ['09:00', '16:00'],
  days: ['MO', 'TU', 'WE', 'TH', 'FR'],
  timeZone: 'Asia/Kolkata',
};

export function nextMailBriefRunAt(
  schedule: MailBriefSchedule,
  after: Date,
): Date | null {
  return nextRecurringRunAt(schedule, after);
}

/**
 * How far back the next brief reaches.
 *
 * Three days at most, and twelve hours on a cold start. Both are mail's
 * judgement rather than the scheduler's: a brief is a summary of a working day,
 * and a mailbox unbriefed since last month should get today and a fresh start.
 */
const MAX_BRIEF_WINDOW_MS = 3 * 24 * 60 * 60_000;
const COLD_START_LOOKBACK_MS = 12 * 60 * 60_000;

export function mailBriefWindowStart(
  coveredThrough: Date | null,
  now: Date,
): Date {
  return windowStartFrom(coveredThrough, now, {
    maxWindowMs: MAX_BRIEF_WINDOW_MS,
    coldStartLookbackMs: COLD_START_LOOKBACK_MS,
  });
}
