import { channelIdentityRepository } from '../../channels/channel-identity.repository';
import { larkUserAuthLinkRepository } from '../../channels/lark/lark-user-auth-link.repository';

export type VercelLarkTaskAssignablePerson = {
  channelIdentityId: string;
  displayName?: string;
  email?: string;
  externalUserId: string;
  larkOpenId?: string;
  larkUserId?: string;
  aiRole?: string;
  isCurrentUser: boolean;
};

type ListAssignablePeopleInput = {
  companyId: string;
  appUserId?: string;
  requestLarkOpenId?: string;
};

type ResolveAssigneesInput = ListAssignablePeopleInput & {
  assigneeNames?: string[];
  assignToMe?: boolean;
};

export type ResolveAssigneesResult = {
  people: VercelLarkTaskAssignablePerson[];
  unresolved: string[];
  ambiguous: Array<{ query: string; matches: VercelLarkTaskAssignablePerson[] }>;
};

const ISO_WITH_TIMEZONE_PATTERN = /(z|[+-]\d{2}:\d{2})$/i;
const ISO_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[t\s](\d{2}):(\d{2})(?::(\d{2}))?$/i;

const normalize = (value?: string | null): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toSearchTokens = (person: VercelLarkTaskAssignablePerson): string[] =>
  [
    normalize(person.displayName),
    normalize(person.email),
    normalize(person.externalUserId),
    normalize(person.larkOpenId),
    normalize(person.larkUserId),
  ].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());

export const listLarkTaskAssignablePeople = async (
  input: ListAssignablePeopleInput,
): Promise<VercelLarkTaskAssignablePerson[]> => {
  if (!input.companyId.trim()) {
    return [];
  }

  const linkedUser = input.appUserId
    ? await larkUserAuthLinkRepository.findActiveByUser(input.appUserId, input.companyId)
    : null;
  const currentOpenId = normalize(input.requestLarkOpenId) ?? normalize(linkedUser?.larkOpenId);
  const rows = await channelIdentityRepository.listByCompany(input.companyId, 'lark');

  return rows
    .filter((row) => normalize(row.larkOpenId) || normalize(row.externalUserId))
    .map((row) => ({
      channelIdentityId: row.id,
      displayName: normalize(row.displayName),
      email: normalize(row.email),
      externalUserId: row.externalUserId,
      larkOpenId: normalize(row.larkOpenId) ?? row.externalUserId,
      larkUserId: normalize(row.larkUserId),
      aiRole: normalize(row.aiRole),
      isCurrentUser: Boolean(currentOpenId && (row.larkOpenId === currentOpenId || row.externalUserId === currentOpenId)),
    }))
    .sort((left, right) => {
      if (left.isCurrentUser !== right.isCurrentUser) {
        return left.isCurrentUser ? -1 : 1;
      }
      return (left.displayName ?? left.email ?? left.externalUserId)
        .localeCompare(right.displayName ?? right.email ?? right.externalUserId);
    });
};

const dedupePeople = (people: VercelLarkTaskAssignablePerson[]): VercelLarkTaskAssignablePerson[] => {
  const seen = new Set<string>();
  const result: VercelLarkTaskAssignablePerson[] = [];

  for (const person of people) {
    const key = person.larkOpenId ?? person.externalUserId;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(person);
  }

  return result;
};

const resolveSingleAssignee = (
  query: string,
  people: VercelLarkTaskAssignablePerson[],
): { match?: VercelLarkTaskAssignablePerson; ambiguous?: VercelLarkTaskAssignablePerson[] } => {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return {};
  }

  const exactMatches = people.filter((person) =>
    toSearchTokens(person).some((token) => token === normalizedQuery));
  if (exactMatches.length === 1) {
    return { match: exactMatches[0] };
  }
  if (exactMatches.length > 1) {
    return { ambiguous: exactMatches };
  }

  const partialMatches = people.filter((person) =>
    toSearchTokens(person).some((token) => token.includes(normalizedQuery)));
  if (partialMatches.length === 1) {
    return { match: partialMatches[0] };
  }
  if (partialMatches.length > 1) {
    return { ambiguous: partialMatches.slice(0, 5) };
  }

  return {};
};

export const resolveLarkTaskAssignees = async (
  input: ResolveAssigneesInput,
): Promise<ResolveAssigneesResult> => {
  const people = await listLarkTaskAssignablePeople(input);
  const resolved: VercelLarkTaskAssignablePerson[] = [];
  const unresolved: string[] = [];
  const ambiguous: Array<{ query: string; matches: VercelLarkTaskAssignablePerson[] }> = [];

  if (input.assignToMe) {
    const currentUser = people.find((person) => person.isCurrentUser);
    if (currentUser) {
      resolved.push(currentUser);
    } else {
      unresolved.push('me');
    }
  }

  for (const rawQuery of input.assigneeNames ?? []) {
    const query = rawQuery.trim();
    if (!query) {
      continue;
    }
    if (['me', 'myself', 'self'].includes(query.toLowerCase())) {
      const currentUser = people.find((person) => person.isCurrentUser);
      if (currentUser) {
        resolved.push(currentUser);
      } else {
        unresolved.push(query);
      }
      continue;
    }
    const result = resolveSingleAssignee(query, people);
    if (result.match) {
      resolved.push(result.match);
      continue;
    }
    if (result.ambiguous) {
      ambiguous.push({ query, matches: result.ambiguous });
      continue;
    }
    unresolved.push(query);
  }

  return {
    people: dedupePeople(resolved),
    unresolved,
    ambiguous,
  };
};

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
