import { channelIdentityRepository } from '../../channels/channel-identity.repository';
import { larkUserAuthLinkRepository } from '../../channels/lark/lark-user-auth-link.repository';

export type VercelLarkPerson = {
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
  people: VercelLarkPerson[];
  unresolved: string[];
  ambiguous: Array<{ query: string; matches: VercelLarkPerson[] }>;
};

export type CanonicalizeLarkIdsResult = {
  people: VercelLarkPerson[];
  resolvedIds: string[];
  unresolvedIds: string[];
  ambiguousIds: Array<{ query: string; matches: VercelLarkPerson[] }>;
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

const normalizeDirectoryToken = (value?: string | null): string | undefined => {
  const normalized = normalize(value)
    ?.toLowerCase()
    .replace(/\b(mr|mrs|ms|sir|maam|madam)\b/g, ' ')
    .replace(/[^a-z0-9@._+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized ? normalized : undefined;
};

const toSearchTokens = (person: VercelLarkPerson): string[] =>
  [
    normalizeDirectoryToken(person.displayName),
    normalizeDirectoryToken(person.email),
    normalizeDirectoryToken(person.externalUserId),
    normalizeDirectoryToken(person.larkOpenId),
    normalizeDirectoryToken(person.larkUserId),
  ].filter((value): value is string => Boolean(value));

export const listLarkPeople = async (
  input: ListAssignablePeopleInput,
): Promise<VercelLarkPerson[]> => {
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

const dedupePeople = (people: VercelLarkPerson[]): VercelLarkPerson[] => {
  const seen = new Set<string>();
  const result: VercelLarkPerson[] = [];

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

const uniqueStrings = (values: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalize(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

export const getCanonicalLarkOpenId = (person: VercelLarkPerson): string | undefined =>
  normalize(person.larkOpenId) ?? normalize(person.externalUserId);

const tokenOverlapScore = (left: string, right: string): number => {
  const leftTokens = new Set(left.split(' ').filter(Boolean));
  const rightTokens = right.split(' ').filter(Boolean);
  if (leftTokens.size === 0 || rightTokens.length === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of rightTokens) {
    if (leftTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(leftTokens.size, rightTokens.length);
};

export const resolveLarkPersonFromDirectory = (
  query: string,
  people: VercelLarkPerson[],
): { match?: VercelLarkPerson; ambiguous?: VercelLarkPerson[] } => {
  const normalizedQuery = normalizeDirectoryToken(query);
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

  const fuzzyMatches = people
    .map((person) => ({
      person,
      score: Math.max(...toSearchTokens(person).map((token) => tokenOverlapScore(token, normalizedQuery)), 0),
    }))
    .filter((entry) => entry.score >= 0.5)
    .sort((left, right) => right.score - left.score);
  if (fuzzyMatches.length === 1) {
    return { match: fuzzyMatches[0]!.person };
  }
  if (fuzzyMatches.length > 1) {
    const bestScore = fuzzyMatches[0]!.score;
    const closeMatches = fuzzyMatches
      .filter((entry) => entry.score >= bestScore - 0.1)
      .map((entry) => entry.person)
      .slice(0, 5);
    if (closeMatches.length === 1) {
      return { match: closeMatches[0] };
    }
    return { ambiguous: closeMatches };
  }

  return {};
};

export const resolveLarkPeopleFromDirectory = (input: {
  people: VercelLarkPerson[];
  assigneeNames?: string[];
  assignToMe?: boolean;
}): ResolveAssigneesResult => {
  const resolved: VercelLarkPerson[] = [];
  const unresolved: string[] = [];
  const ambiguous: Array<{ query: string; matches: VercelLarkPerson[] }> = [];

  if (input.assignToMe) {
    const currentUser = input.people.find((person) => person.isCurrentUser);
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
      const currentUser = input.people.find((person) => person.isCurrentUser);
      if (currentUser) {
        resolved.push(currentUser);
      } else {
        unresolved.push(query);
      }
      continue;
    }
    const result = resolveLarkPersonFromDirectory(query, input.people);
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

export const resolveLarkPeople = async (
  input: ResolveAssigneesInput,
): Promise<ResolveAssigneesResult> => {
  const people = await listLarkPeople(input);
  return resolveLarkPeopleFromDirectory({
    people,
    assigneeNames: input.assigneeNames,
    assignToMe: input.assignToMe,
  });
};

export const canonicalizeLarkPersonIds = async (
  input: ListAssignablePeopleInput & { assigneeIds?: string[] },
): Promise<CanonicalizeLarkIdsResult> => {
  const people = await listLarkPeople(input);
  const resolvedIds: string[] = [];
  const unresolvedIds: string[] = [];
  const ambiguousIds: Array<{ query: string; matches: VercelLarkPerson[] }> = [];

  for (const rawValue of input.assigneeIds ?? []) {
    const query = normalize(rawValue);
    if (!query) {
      continue;
    }

    const result = resolveLarkPersonFromDirectory(query, people);
    if (result.match) {
      const canonicalId = getCanonicalLarkOpenId(result.match);
      if (canonicalId) {
        resolvedIds.push(canonicalId);
      } else {
        unresolvedIds.push(query);
      }
      continue;
    }

    if (result.ambiguous?.length) {
      ambiguousIds.push({ query, matches: result.ambiguous });
      continue;
    }

    if (query.startsWith('ou_')) {
      resolvedIds.push(query);
      continue;
    }

    unresolvedIds.push(query);
  }

  return {
    people,
    resolvedIds: uniqueStrings(resolvedIds),
    unresolvedIds: uniqueStrings(unresolvedIds),
    ambiguousIds,
  };
};

export type VercelLarkTaskAssignablePerson = VercelLarkPerson;

export const listLarkTaskAssignablePeople = listLarkPeople;

export const resolveLarkTaskAssignees = resolveLarkPeople;

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
