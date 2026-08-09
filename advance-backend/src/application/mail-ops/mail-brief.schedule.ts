/**
 * When the next brief goes out.
 *
 * `getNextScheduledRunAt` in the scheduler handles one time a day. A brief is
 * twice a day — that is the whole shape of the feature — so this walks the
 * member's list of times instead. It does not reimplement the hard part:
 * `zonedDateTimeToUtc` is imported, because getting a local wall-clock time into
 * a UTC instant across a DST boundary is where this kind of code goes wrong, and
 * there is already one careful implementation of it in this codebase.
 *
 * Two rows per member was the alternative to a list, and it would have shown
 * somebody two things to manage where they asked for one.
 */
import { z } from 'zod';
import { zonedDateTimeToUtc } from '../scheduling/schedule-calculator';

export const MAIL_BRIEF_WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type MailBriefWeekday = (typeof MAIL_BRIEF_WEEKDAYS)[number];

/** Sunday-first, matching `Date.getDay()`. */
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

/** `HH:MM`, 24-hour. Rejected rather than coerced — 9am and 9pm are not close. */
const timeOfDaySchema = z.string().regex(
  /^([01]\d|2[0-3]):([0-5]\d)$/,
  'Times must be written as HH:MM on a 24-hour clock.',
);

export const mailBriefScheduleSchema = z.object({
  /**
   * At least one, at most four.
   *
   * Four is a support rota checking every six hours. Past that a brief stops
   * being a summary and becomes a notification, which is the thing it exists to
   * replace.
   */
  times: z.array(timeOfDaySchema).min(1).max(4),
  days: z.array(z.enum(MAIL_BRIEF_WEEKDAYS)).min(1),
  timeZone: z.string().trim().min(1).max(100),
}).strict();

export type MailBriefSchedule = z.infer<typeof mailBriefScheduleSchema>;

/** Twice on workdays. What almost everybody wants, and nobody has to choose it. */
export const DEFAULT_MAIL_BRIEF_SCHEDULE: MailBriefSchedule = {
  times: ['09:00', '16:00'],
  days: ['MO', 'TU', 'WE', 'TH', 'FR'],
  timeZone: 'Asia/Kolkata',
};

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
 * The next moment at or after `after` that this schedule fires.
 *
 * Strictly after, never equal: called right after a run completes, an
 * inclusive comparison would return the slot that just fired and the brief
 * would send in a loop.
 *
 * Searches fourteen days rather than seven. A schedule can name a single day,
 * and a DST shift can move a slot across a local midnight, so seven days is
 * exactly the horizon where a legitimate schedule starts returning `null`.
 */
export function nextMailBriefRunAt(
  schedule: MailBriefSchedule,
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
 * How far back the next brief reaches.
 *
 * From where the last one stopped, so a run missed to an outage widens the
 * following brief rather than silently dropping the mail in the gap — which is
 * exactly the window somebody most needs to be told about.
 *
 * Bounded at three days regardless. A mailbox that has not been briefed since
 * last month should get today's mail and a fresh start, not four hundred
 * messages summarised into a Lark card nobody will read.
 */
const MAX_BRIEF_WINDOW_MS = 3 * 24 * 60 * 60_000;

export function mailBriefWindowStart(
  coveredThrough: Date | null,
  now: Date,
): Date {
  const floor = new Date(now.getTime() - MAX_BRIEF_WINDOW_MS);
  if (!coveredThrough) return new Date(now.getTime() - 12 * 60 * 60_000);
  return coveredThrough < floor ? floor : coveredThrough;
}
