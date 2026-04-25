/**
 * LarkPeopleResolver — resolves human-readable names to Lark open_ids.
 *
 * Queries channelIdentity (already synced from Lark) for all users in a
 * company, then matches each query name through three stages:
 *   1. Exact token match  (highest confidence)
 *   2. Substring match
 *   3. Fuzzy token-overlap score ≥ 0.5
 *
 * "me" / "myself" / "i" → requester's open_id (no DB round-trip).
 * Titles (mr, mrs, sir, dr, etc.) are stripped before matching.
 */

import type { PrismaClient } from '../../../generated/prisma';

export interface ResolvedPerson {
  openId:      string;
  displayName: string;
  email?:      string;
}

export type ResolveResult =
  | { kind: 'resolved';   person: ResolvedPerson }
  | { kind: 'ambiguous';  matches: ResolvedPerson[] }
  | { kind: 'not_found' };

export interface ResolveAssigneesResult {
  resolved:   ResolvedPerson[];
  ambiguous:  Array<{ query: string; matches: ResolvedPerson[] }>;
  notFound:   string[];
}

// ── Normalisation ─────────────────────────────────────────────────────────────

const STRIP_TITLES = /\b(mr|mrs|ms|miss|dr|prof|sir|ma'am|shri|smt)\b\.?/gi;

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(STRIP_TITLES, '')
    .replace(/[^a-z0-9\s@._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const t of a) if (b.has(t)) hits++;
  return hits / Math.max(a.size, b.size);
}

// ── Directory record ──────────────────────────────────────────────────────────

interface DirEntry {
  openId:      string;
  displayName: string;
  email?:      string;
  normName:    string;
  tokens:      Set<string>;
}

function matchEntry(query: string, dir: DirEntry[]): ResolveResult {
  const q       = normalize(query);
  const qTokens = tokenize(q);

  // Stage 1 — exact
  const exact = dir.filter(e => e.normName === q || e.email === q.toLowerCase());
  if (exact.length === 1) return { kind: 'resolved', person: toPerson(exact[0]!) };
  if (exact.length > 1)  return { kind: 'ambiguous', matches: exact.map(toPerson) };

  // Stage 2 — substring
  const sub = dir.filter(e => e.normName.includes(q) || q.includes(e.normName));
  if (sub.length === 1) return { kind: 'resolved', person: toPerson(sub[0]!) };
  if (sub.length > 1)  return { kind: 'ambiguous', matches: sub.map(toPerson) };

  // Stage 3 — fuzzy token overlap
  const scored = dir
    .map(e => ({ e, score: overlapScore(qTokens, e.tokens) }))
    .filter(x => x.score >= 0.5)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: 'not_found' };
  const top = scored[0]!.score;
  const best = scored.filter(x => x.score === top).map(x => x.e);
  if (best.length === 1) return { kind: 'resolved', person: toPerson(best[0]!) };
  return { kind: 'ambiguous', matches: best.map(toPerson) };
}

function toPerson(e: DirEntry): ResolvedPerson {
  return { openId: e.openId, displayName: e.displayName, ...(e.email ? { email: e.email } : {}) };
}

// ── Resolver class ────────────────────────────────────────────────────────────

export class LarkPeopleResolver {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Resolve an array of name queries to Lark open_ids for a given company.
   *
   * @param companyId       Internal company UUID
   * @param queries         Human-readable names ("Anish", "Shivam sir", "me")
   * @param requesterOpenId The message sender's Lark open_id (for "me"/"myself")
   */
  async resolve(
    companyId:       string,
    queries:         string[],
    requesterOpenId: string,
  ): Promise<ResolveAssigneesResult> {
    if (queries.length === 0) {
      return { resolved: [], ambiguous: [], notFound: [] };
    }

    // Fetch all Lark channel identities for this company
    const rows = await this.prisma.channelIdentity.findMany({
      where:  { companyId, channel: 'lark' },
      select: { larkOpenId: true, externalUserId: true, displayName: true, email: true },
    });

    const dir: DirEntry[] = [];
    for (const r of rows) {
      const openId = r.larkOpenId ?? r.externalUserId;
      if (!openId) continue;
      const displayName = r.displayName ?? openId;
      const normName    = normalize(displayName);
      const entry: DirEntry = { openId, displayName, normName, tokens: tokenize(normName) };
      if (r.email) entry.email = r.email;
      dir.push(entry);
    }

    const selfAliases = new Set(['me', 'myself', 'i', 'self']);

    const resolved:  ResolvedPerson[]                              = [];
    const ambiguous: Array<{ query: string; matches: ResolvedPerson[] }> = [];
    const notFound:  string[]                                      = [];
    const seen      = new Set<string>();                           // dedup by openId

    for (const raw of queries) {
      const q = raw.trim();

      // Self-reference
      if (selfAliases.has(q.toLowerCase())) {
        if (!seen.has(requesterOpenId)) {
          seen.add(requesterOpenId);
          const self = dir.find(e => e.openId === requesterOpenId);
          resolved.push({ openId: requesterOpenId, displayName: self?.displayName ?? 'You', ...(self?.email ? { email: self.email } : {}) });
        }
        continue;
      }

      const result = matchEntry(q, dir);
      if (result.kind === 'resolved') {
        if (!seen.has(result.person.openId)) {
          seen.add(result.person.openId);
          resolved.push(result.person);
        }
      } else if (result.kind === 'ambiguous') {
        ambiguous.push({ query: q, matches: result.matches });
      } else {
        notFound.push(q);
      }
    }

    return { resolved, ambiguous, notFound };
  }
}
