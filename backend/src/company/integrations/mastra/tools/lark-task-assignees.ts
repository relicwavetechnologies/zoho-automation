import { channelIdentityRepository } from '../../../channels/channel-identity.repository';
import { larkUserAuthLinkRepository } from '../../../channels/lark/lark-user-auth-link.repository';

export type LarkTaskAssignablePerson = {
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

type ResolveAssigneesResult = {
  people: LarkTaskAssignablePerson[];
  unresolved: string[];
  ambiguous: Array<{ query: string; matches: LarkTaskAssignablePerson[] }>;
};

const normalize = (value?: string | null): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const toSearchTokens = (person: LarkTaskAssignablePerson): string[] =>
  [
    normalize(person.displayName),
    normalize(person.email),
    normalize(person.externalUserId),
    normalize(person.larkOpenId),
    normalize(person.larkUserId),
  ].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());

export const listLarkTaskAssignablePeople = async (
  input: ListAssignablePeopleInput,
): Promise<LarkTaskAssignablePerson[]> => {
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

const dedupePeople = (people: LarkTaskAssignablePerson[]): LarkTaskAssignablePerson[] => {
  const seen = new Set<string>();
  const result: LarkTaskAssignablePerson[] = [];

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
  people: LarkTaskAssignablePerson[],
): { match?: LarkTaskAssignablePerson; ambiguous?: LarkTaskAssignablePerson[] } => {
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
  const resolved: LarkTaskAssignablePerson[] = [];
  const unresolved: string[] = [];
  const ambiguous: Array<{ query: string; matches: LarkTaskAssignablePerson[] }> = [];

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
