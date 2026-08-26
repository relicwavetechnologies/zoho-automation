/**
 * A recurring local-time schedule: some times of day, on some weekdays, in one
 * timezone.
 *
 * `getNextScheduledRunAt` in the calculator beside this handles one time a day.
 * This handles several, which is the shape both watched sources want — a mail
 * brief at 09:00 and 16:00, a follow-up digest at 09:00 and 18:00.
 *
 * It lives here rather than in either feature because the concept belongs to
 * scheduling, and because there was one implementation before there were two
 * callers. The hard part is not reimplemented: `zonedDateTimeToUtc` turns a
 * local wall-clock time into a UTC instant across a DST boundary, which is where
 * this kind of code goes wrong, and there is already one careful version of it.
 */
import { z } from 'zod';
import { zonedDateTimeToUtc } from './schedule-calculator';

export const SCHEDULE_WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type ScheduleWeekday = (typeof SCHEDULE_WEEKDAYS)[number];

/** Sunday-first, matching `Date.getDay()`. */
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

/** `HH:MM`, 24-hour. Rejected rather than coerced — 9am and 9pm are not close. */
export const timeOfDaySchema = z.string().regex(
  /^([01]\d|2[0-3]):([0-5]\d)$/,
  'Times must be written as HH:MM on a 24-hour clock.',
);

export const recurringScheduleSchema = z.object({
  /**
   * At least one, at most four.
   *
   * Four is a rota checking every six hours. Past that a digest stops being a
   * summary and becomes a notification, which is the thing it exists to replace.
   */
  times: z.array(timeOfDaySchema).min(1).max(4),
  days: z.array(z.enum(SCHEDULE_WEEKDAYS)).min(1),
  timeZone: z.string().trim().min(1).max(100),
}).strict();

export type RecurringSchedule = z.infer<typeof recurringScheduleSchema>;

const partsIn = (at: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour12: false,
  }).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(p => p.type === type)?.value ?? '';
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
  };
};

/**
 * The next moment strictly after `after` that this schedule fires.
 *
 * Strictly after, never equal: called right after a run completes, an inclusive
 * comparison would return the slot that just fired and the run would loop.
 *
 * Searches fourteen days rather than seven. A schedule can name a single day,
 * and a DST shift can move a slot across a local midnight, so seven days is
 * exactly the horizon where a legitimate schedule starts returning `null`.
 */
export function nextRecurringRunAt(
  schedule: RecurringSchedule,
  after: Date,
): Date | null {
  const times = [...schedule.times].sort();
  const days = new Set<string>(schedule.days);

  for (let offset = 0; offset < 14; offset++) {
    const probe = new Date(after.getTime() + offset * 86_400_000);
    const { year, month, day } = partsIn(probe, schedule.timeZone);

    for (const time of times) {
      const [hour, minute] = time.split(':').map(Number);
      const at = zonedDateTimeToUtc({
        year, month, day,
        hour: hour ?? 0,
        minute: minute ?? 0,
        timeZone: schedule.timeZone,
      });
      if (at.getTime() <= after.getTime()) continue;
      // Read off the resolved instant, not the probe. A late-evening slot in a
      // zone behind UTC can land on the following local day, and a rule that
      // says "weekdays" must not fire on the Saturday that produces.
      const localDay = new Intl.DateTimeFormat('en-US', {
        timeZone: schedule.timeZone, weekday: 'short',
      }).format(at);
      const code = WEEKDAY_CODES[
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(localDay)
      ];
      if (code && days.has(code)) return at;
    }
  }

  return null;
}

/**
 * How far back the next run reaches.
 *
 * From where the last one stopped, so a run missed to an outage widens the
 * following one rather than silently dropping what happened in the gap — which
 * is exactly the window somebody most needs to be told about.
 *
 * Bounded regardless: a destination that has not been sent to since last month
 * should get today and a fresh start, not four hundred items summarised into a
 * card nobody will read.
 */
export function windowStartFrom(
  coveredThrough: Date | null,
  now: Date,
  options: { maxWindowMs: number; coldStartLookbackMs: number },
): Date {
  const floor = new Date(now.getTime() - options.maxWindowMs);
  if (!coveredThrough) return new Date(now.getTime() - options.coldStartLookbackMs);
  return coveredThrough < floor ? floor : coveredThrough;
}
