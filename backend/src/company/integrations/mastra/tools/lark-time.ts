const ISO_WITH_TIMEZONE_PATTERN = /(z|[+-]\d{2}:\d{2})$/i;
const ISO_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[t\s](\d{2}):(\d{2})(?::(\d{2}))?$/i;

const getTimeZoneOffsetMs = (timeZone: string, date: Date): number => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );

  return asUtc - date.getTime();
};

const convertLocalDateTimeToEpochSeconds = (
  input: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  },
  timeZone: string,
): string => {
  const utcGuess = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    input.second,
  );

  let offset = getTimeZoneOffsetMs(timeZone, new Date(utcGuess));
  let resolvedUtc = utcGuess - offset;
  const adjustedOffset = getTimeZoneOffsetMs(timeZone, new Date(resolvedUtc));
  if (adjustedOffset !== offset) {
    offset = adjustedOffset;
    resolvedUtc = utcGuess - offset;
  }

  return String(Math.floor(resolvedUtc / 1000));
};

export const normalizeLarkTimestamp = (value?: string, timeZone = 'UTC'): string | undefined => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  const localMatch = trimmed.match(ISO_LOCAL_PATTERN);
  if (localMatch && !ISO_WITH_TIMEZONE_PATTERN.test(trimmed)) {
    const [, year, month, day, hour, minute, second] = localMatch;
    return convertLocalDateTimeToEpochSeconds({
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second ?? '0'),
    }, timeZone);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return String(Math.floor(parsed / 1000));
  }
  return trimmed;
};
