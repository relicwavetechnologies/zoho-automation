import type { ScheduledWorkflowScheduleConfig } from '../../company/scheduled-workflows/contracts';

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

const readPart = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number =>
  Number(parts.find((part) => part.type === type)?.value ?? '0');

const getZonedParts = (date: Date, timeZone: string): ZonedDateParts => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);

  return {
    year: readPart(parts, 'year'),
    month: readPart(parts, 'month'),
    day: readPart(parts, 'day'),
    hour: readPart(parts, 'hour'),
    minute: readPart(parts, 'minute'),
    second: readPart(parts, 'second'),
  };
};

const getTimeZoneOffsetMs = (date: Date, timeZone: string): number => {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
};

export const zonedDateTimeToUtc = (input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
  timeZone: string;
}): Date => {
  const second = input.second ?? 0;
  const utcGuess = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, second);
  const firstOffset = getTimeZoneOffsetMs(new Date(utcGuess), input.timeZone);
  let resolved = utcGuess - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(new Date(resolved), input.timeZone);
  if (secondOffset !== firstOffset) {
    resolved = utcGuess - secondOffset;
  }
  return new Date(resolved);
};

const addDays = (input: { year: number; month: number; day: number }, days: number) => {
  const value = new Date(Date.UTC(input.year, input.month - 1, input.day + days));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
};

const addMonths = (input: { year: number; month: number }, months: number) => {
  const value = new Date(Date.UTC(input.year, input.month - 1 + months, 1));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
  };
};

const getWeekdayCode = (input: { year: number; month: number; day: number }) =>
  WEEKDAY_CODES[new Date(Date.UTC(input.year, input.month - 1, input.day)).getUTCDay()];

const getLastDayOfMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

export const getNextScheduledRunAt = (
  schedule: ScheduledWorkflowScheduleConfig,
  after: Date = new Date(),
): Date | null => {
  if (schedule.type === 'one_time') {
    const runAt = new Date(schedule.runAt);
    return runAt.getTime() > after.getTime() ? runAt : null;
  }

  if (schedule.type === 'hourly') {
    const base = new Date(after.getTime());
    base.setUTCSeconds(0, 0);
    for (let step = 0; step < 24 * 31; step += 1) {
      const candidate = new Date(base.getTime() + step * 60 * 60 * 1000);
      const zoned = getZonedParts(candidate, schedule.timezone);
      if (zoned.minute !== schedule.minute) {
        candidate.setUTCMinutes(candidate.getUTCMinutes() + (schedule.minute - zoned.minute));
      }
      if (candidate.getTime() <= after.getTime()) {
        continue;
      }
      const hoursFromBase = Math.abs(step);
      if (hoursFromBase % schedule.intervalHours === 0) {
        return candidate;
      }
    }
    return null;
  }

  const base = getZonedParts(after, schedule.timezone);

  if (schedule.type === 'daily') {
    for (let offset = 0; offset < 370; offset += 1) {
      const day = addDays(base, offset);
      const candidate = zonedDateTimeToUtc({
        ...day,
        hour: schedule.time.hour,
        minute: schedule.time.minute,
        timeZone: schedule.timezone,
      });
      if (candidate.getTime() > after.getTime()) {
        return candidate;
      }
    }
    return null;
  }

  if (schedule.type === 'weekly') {
    const allowedDays = new Set(schedule.daysOfWeek);
    for (let offset = 0; offset < 370; offset += 1) {
      const day = addDays(base, offset);
      if (!allowedDays.has(getWeekdayCode(day))) continue;
      const candidate = zonedDateTimeToUtc({
        ...day,
        hour: schedule.time.hour,
        minute: schedule.time.minute,
        timeZone: schedule.timezone,
      });
      if (candidate.getTime() > after.getTime()) {
        return candidate;
      }
    }
    return null;
  }

  for (let offset = 0; offset < 36; offset += 1) {
    const month = addMonths(base, offset);
    const day = Math.min(schedule.dayOfMonth, getLastDayOfMonth(month.year, month.month));
    const candidate = zonedDateTimeToUtc({
      year: month.year,
      month: month.month,
      day,
      hour: schedule.time.hour,
      minute: schedule.time.minute,
      timeZone: schedule.timezone,
    });
    if (candidate.getTime() > after.getTime()) {
      return candidate;
    }
  }

  return null;
};

export const formatScheduledSlot = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
