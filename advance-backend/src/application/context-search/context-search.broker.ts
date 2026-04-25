/**
 * ContextSearchBroker — parallel multi-source context retrieval.
 *
 * Architecture:
 *   • 8 source runners (personalHistory, files, larkContacts, zohoCrmContext,
 *     zohoBooksLive, workspace, web, skills) execute concurrently via
 *     Promise.allSettled, each wrapped in a per-source timeout (default 8 s).
 *   • Source selection: caller may pass an explicit ContextSourceFilter; when
 *     absent, non-web internal sources all run.
 *   • Ranking: weighted score boost per source; authority-level boost.
 *   • Dedup: (scope, sourceId, chunkIndex) triple.
 *   • No search-intent classifier — planner decides intent; broker is pure retrieval.
 *
 * Dependencies (all injected via constructor, none imported as singletons):
 *   vectorStore, embedding, webSearch, larkContacts, zohoBooks, skills, logger.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../shared/logger';
import type {
  ContextSearchInput,
  ContextSearchOutput,
  ContextSearchResult,
  ContextSourceKey,
  SourceCoverage,
  SourceCoverageEntry,
  ContextCitation,
  ContextFetchInput,
  ContextFetchOutput,
  AuthorityLevel,
} from './context-search.types';
import type {
  LarkContactPort,
  ZohoBooksPort,
  SkillPort,
  EmbeddingPort,
} from './context-search.ports';
import type { VectorStoreAdapter } from '../../infrastructure/ai/vector/types';
import type { WebSearchService } from '../../infrastructure/ai/search/web-search.service';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT         = 5;
const MAX_LIMIT             = 10;
const DEFAULT_TIMEOUT_MS    = 8_000;
const EXCERPT_MAX_CHARS     = 800;

// Filesystem search
const WORKSPACE_FILE_LIMIT  = 150;
const WORKSPACE_MAX_BYTES   = 100_000;
const TEXT_FILE_EXTS        = new Set([
  '.md', '.txt', '.json', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.yml', '.yaml', '.toml', '.env', '.csv', '.sql', '.html', '.css',
  '.scss', '.xml',
]);
const WORKSPACE_IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo',
]);

// Source weights — equal footing; caller narrows via sources filter
const DEFAULT_WEIGHTS: Record<ContextSourceKey, number> = {
  zohoBooksLive:   1.6,
  zohoCrmContext:  1.5,
  files:           1.15,
  workspace:       1.05,
  personalHistory: 0.15,
  larkContacts:    0.75,
  web:             0.75,
  skills:          0.5,
};

const AUTHORITATIVE_SCOPES = new Set(['zoho_books', 'zoho_crm', 'files', 'workspace']);

// ─── Utility helpers ──────────────────────────────────────────────────────────

const readString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;

const normalizeText = (s: string): string => s.trim().replace(/\s+/g, ' ');
const normalizeLower = (s: string): string => normalizeText(s).toLowerCase();
const collapseToken  = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

const encodeRef = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const decodeRef = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');

const buildChunkRef = (scope: string, sourceType: string, sourceId: string, chunkIndex: number): string =>
  `${scope}:${sourceType}:${sourceId}:${chunkIndex}`;

const parseChunkRef = (
  ref: string,
): { scope: string; sourceType: string; sourceId: string; chunkIndex: number } | null => {
  const parts = ref.split(':');
  if (parts.length !== 4) return null;
  const [scope, sourceType, sourceId, rawIdx] = parts;
  const chunkIndex = Number.parseInt(rawIdx ?? '', 10);
  if (!scope || !sourceType || !sourceId || Number.isNaN(chunkIndex)) return null;
  return { scope, sourceType, sourceId, chunkIndex };
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Detect whether the query is asking about visual content — images, diagrams,
 * screenshots, photos, charts. When true, we additionally query the multimodal
 * vector branch (gemini-embedding-2-preview's image embeddings) so that
 * visually-rich files surface even when their OCR text is sparse.
 */
const VISUAL_QUERY_RE = /\b(image|images|img|photo|photos|picture|pictures|screenshot|screenshots|diagram|diagrams|chart|charts|graph|graphs|figure|figures|drawing|drawings|sketch|sketches|logo|icon|thumbnail|infographic|visual|visuals|jpg|jpeg|png|gif|webp|svg|heic)\b/i;
function isVisualQuery(query: string): boolean {
  return VISUAL_QUERY_RE.test(query);
}

function excerptFrom(text: string): string {
  const s = normalizeText(text);
  return s.length > EXCERPT_MAX_CHARS ? `${s.slice(0, EXCERPT_MAX_CHARS - 3)}...` : s;
}

function getAuthorityLevel(scope: string): AuthorityLevel {
  if (scope === 'zoho_books' || scope === 'zoho_crm') return 'authoritative';
  if (scope === 'files' || scope === 'workspace') return 'documentary';
  if (scope === 'personal_history' || scope === 'lark_contacts') return 'contextual';
  if (scope === 'web') return 'public';
  return 'contextual';
}

// Use conditional spread to satisfy exactOptionalPropertyTypes
function opt<T>(key: string, v: T | undefined): Record<string, T> {
  return v !== undefined ? { [key]: v } : {};
}

function buildSourceLabel(input: {
  scope: string; title?: string; fileName?: string;
  displayName?: string; sourceType: string; asOf?: string; domain?: string;
}): string {
  const s = input.asOf ? ` · ${input.asOf}` : '';
  if (input.scope === 'lark_contacts')   return `Lark contact · ${input.displayName ?? input.title ?? input.sourceType}${s}`;
  if (input.scope === 'files')           return `Company file · ${input.fileName ?? input.title ?? input.sourceType}${s}`;
  if (input.scope === 'personal_history') return `Personal history · ${input.title ?? input.sourceType}${s}`;
  if (input.scope === 'zoho_crm')        return `Zoho CRM · ${input.title ?? input.sourceType}${s}`;
  if (input.scope === 'zoho_books')      return `Zoho Books · ${input.title ?? input.sourceType}${s}`;
  if (input.scope === 'web')             return `Web · ${input.domain ?? input.title ?? input.sourceType}${s}`;
  if (input.scope === 'skills')          return `Skill · ${input.title ?? input.sourceType}${s}`;
  if (input.scope === 'workspace')       return `Workspace · ${input.fileName ?? input.title ?? input.sourceType}${s}`;
  return `${input.scope} · ${input.title ?? input.sourceType}${s}`;
}

const parseDate = (value: string | undefined, edge: 'start' | 'end'): Date | null => {
  if (!value?.trim()) return null;
  const d = new Date(value.trim());
  if (Number.isNaN(d.getTime())) return new Date(Number.NaN);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    if (edge === 'start') d.setUTCHours(0, 0, 0, 0);
    else                  d.setUTCHours(23, 59, 59, 999);
  }
  return d;
};

const dateMatches = (iso: string | undefined, from: Date | null, to: Date | null): boolean => {
  if (!from && !to) return true;
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  if (from && d < from) return false;
  if (to   && d > to)   return false;
  return true;
};

// ─── Entity text-match scoring ────────────────────────────────────────────────

const extractTokens = (s: string): string[] =>
  Array.from(new Set(
    normalizeLower(s).split(/[^a-z0-9]+/g).map(t => t.trim()).filter(t => t.length >= 2),
  ));

function computeEntityScore(query: string, values: Array<string | undefined>): number {
  const cq = collapseToken(normalizeLower(query));
  const haystacks = values
    .map(v => v?.trim())
    .filter((v): v is string => Boolean(v))
    .map(v => normalizeLower(v));
  if (!cq || haystacks.length === 0) return 0;
  const queryTokens = extractTokens(query);
  let best = 0;
  for (const haystack of haystacks) {
    const ch = collapseToken(haystack);
    if (!ch) continue;
    if (ch === cq) { best = Math.max(best, 1); continue; }
    if (ch.includes(cq) || cq.includes(ch)) { best = Math.max(best, 0.92); }
    const hTokens = new Set(
      haystack.split(/[^a-z0-9]+/g).map(t => t.trim()).filter(t => t.length >= 2),
    );
    if (queryTokens.length > 0 && hTokens.size > 0) {
      let overlap = 0;
      for (const t of queryTokens) if (hTokens.has(t)) overlap++;
      best = Math.max(best, overlap / queryTokens.length);
    }
  }
  return best;
}

// ─── Dedup + ranking ──────────────────────────────────────────────────────────

function dedup(results: ContextSearchResult[]): ContextSearchResult[] {
  const seen = new Set<string>();
  return results.filter(r => {
    const k = `${r.scope}:${r.sourceId}:${r.chunkIndex}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const SCOPE_TO_SOURCE_KEY: Record<string, ContextSourceKey> = {
  personal_history: 'personalHistory',
  files:            'files',
  lark_contacts:    'larkContacts',
  zoho_crm:         'zohoCrmContext',
  zoho_books:       'zohoBooksLive',
  workspace:        'workspace',
  web:              'web',
  skills:           'skills',
};

function rankResults(results: ContextSearchResult[], limit: number): ContextSearchResult[] {
  return dedup(results)
    .map((r, i) => {
      const key       = SCOPE_TO_SOURCE_KEY[r.scope];
      const priority  = key ? (DEFAULT_WEIGHTS[key] ?? 1) : 1;
      const authBoost = AUTHORITATIVE_SCOPES.has(r.scope) ? 0.1 : 0;
      const effective = (r.score * priority) + authBoost - (i * 0.0001);
      return { r, effective };
    })
    .sort((a, b) => b.effective - a.effective)
    .slice(0, limit)
    .map(({ r }) => r);
}

// ─── Resolved entities ────────────────────────────────────────────────────────

function buildResolvedEntities(results: ContextSearchResult[]): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (k: string, v: string | undefined) => {
    if (v?.trim() && !out[k]) out[k] = v.trim();
  };
  for (const r of results) {
    if (r.scope === 'lark_contacts') {
      set('recipientEmail', r.email);
      set('recipientName',  r.displayName);
      set('recipientOpenId', r.sourceId);
    }
    if (r.scope === 'web') {
      set('webUrl',   r.url);
      set('webTitle', r.title);
    }
    if (r.scope === 'files') {
      set('fileAssetId', r.sourceId);
      set('fileName',    r.fileName);
    }
    if (r.scope === 'workspace') {
      set('workspacePath', r.fileName);
    }
    if (r.scope === 'skills') {
      set('skillId',   r.skillId ?? r.sourceId);
      set('skillSlug', r.skillSlug ?? r.sourceId);
    }
    if (r.scope === 'zoho_books') {
      set('organizationId', r.organizationId);
      set('customerName',   r.displayName ?? r.title);
      set('customerEmail',  r.email);
      if (r.sourceType === 'books_contact') {
        set('contactId',  r.sourceId);
        set('customerId', r.customerId ?? r.sourceId);
      }
      if (r.sourceType === 'books_invoice') {
        set('invoiceId',     r.invoiceId ?? r.sourceId);
        set('invoiceNumber', r.invoiceNumber);
        set('customerId',    r.customerId);
      }
    }
  }
  return out;
}

// ─── Workspace filesystem search ──────────────────────────────────────────────

async function listWorkspaceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0 && out.length < WORKSPACE_FILE_LIMIT) {
    const cur = queue.shift()!;
    let rawEntries: unknown[];
    try { rawEntries = await fsp.readdir(cur, { withFileTypes: true }) as unknown[]; } catch { continue; }
    for (const entry of rawEntries as Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>) {
      if (out.length >= WORKSPACE_FILE_LIMIT) break;
      const name = String(entry.name);
      if (entry.isDirectory()) {
        if (!WORKSPACE_IGNORED_DIRS.has(name)) queue.push(path.join(cur, name));
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      if (TEXT_FILE_EXTS.has(ext) || name.toLowerCase().includes('.env')) {
        out.push(path.join(cur, name));
      }
    }
  }
  return out;
}

async function searchWorkspace(
  root: string, query: string, limit: number,
): Promise<ContextSearchResult[]> {
  if (!root) return [];
  const tokens = Array.from(new Set(
    query.toLowerCase().split(/[^a-z0-9@._/-]+/i).map(t => t.trim()).filter(Boolean),
  ));
  if (tokens.length === 0) return [];

  const files = await listWorkspaceFiles(root);
  const matches: ContextSearchResult[] = [];

  for (const fp of files) {
    let statSize: number;
    let mtime: Date;
    let text: string;
    try {
      const s = await fsp.stat(fp);
      statSize = s.size;
      mtime = s.mtime;
    } catch { continue; }
    if (statSize > WORKSPACE_MAX_BYTES) continue;
    try { text = await fsp.readFile(fp, 'utf8'); } catch { continue; }

    const rel   = path.relative(root, fp) || path.basename(fp);
    const lRel  = rel.toLowerCase();
    const lText = text.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (lRel === t) score += 8;
      else if (lRel.includes(t)) score += 5;
      if (lText.includes(t)) score += 2;
    }
    if (score <= 0) continue;

    const firstIdx = tokens
      .map(t => lText.indexOf(t))
      .filter(i => i >= 0)
      .sort((a, b) => a - b)[0] ?? 0;

    const excerpt  = excerptFrom(text.slice(Math.max(0, firstIdx - 160), firstIdx + 400));
    const sourceId = encodeRef(rel);
    const asOf     = mtime.toISOString();
    matches.push({
      scope: 'workspace', sourceType: 'workspace_file', sourceId,
      chunkIndex: 0, score,
      excerpt,
      chunkRef: buildChunkRef('workspace', 'workspace_file', sourceId, 0),
      sourceLabel: buildSourceLabel({ scope: 'workspace', fileName: rel, sourceType: 'workspace_file', asOf }),
      ...opt('asOf', asOf),
      fileName: rel, title: rel,
      authorityLevel: 'documentary',
    });
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── Zoho Books search ────────────────────────────────────────────────────────

const BOOKS_NOISE = /\b(can you|please|share|fetch|get|retrieve|show|reply in thread|in thread|from zoho books|zoho books|customer statement|statement|customer|only)\b/gi;

function buildBooksQueries(query: string): string[] {
  const candidates = new Set<string>();
  const trimmed = query.trim();
  if (trimmed) candidates.add(trimmed);
  const forMatch = trimmed.match(/\bfor\s+(.+?)(?:\b(?:from|reply|please|in thread|only)\b|$)/i);
  const forVariant = forMatch?.[1]?.replace(BOOKS_NOISE, ' ').replace(/\s+/g, ' ').trim();
  if (forVariant && forVariant.length > 1) candidates.add(forVariant);
  const sanitized = trimmed.replace(BOOKS_NOISE, ' ').replace(/\s+/g, ' ').trim();
  if (sanitized && sanitized.length > 1) candidates.add(sanitized);
  return Array.from(candidates).slice(0, 3);
}

async function searchZohoBooksLive(input: {
  runtime: ContextSearchInput;
  query: string;
  limit: number;
  zohoBooks: ZohoBooksPort;
}): Promise<ContextSearchResult[]> {
  const { runtime, query, limit, zohoBooks } = input;
  const queries = buildBooksQueries(query);
  if (queries.length === 0) return [];

  let orgs: Array<{ organizationId: string; name?: string }>;
  try { orgs = await zohoBooks.listOrganizations(runtime.companyId); } catch { orgs = []; }
  const orgIds = Array.from(new Set([...orgs.map(o => o.organizationId), '']));

  const matches: ContextSearchResult[] = [];
  const seen = new Set<string>();

  const booksBase = {
    companyId:               runtime.companyId,
    userId:                  runtime.userId,
    ...(runtime.requesterEmail          ? { requesterEmail: runtime.requesterEmail }                   : {}),
    ...(runtime.requesterAiRole         ? { requesterAiRole: runtime.requesterAiRole }                 : {}),
    ...(runtime.departmentId            ? { departmentId: runtime.departmentId }                       : {}),
    ...(runtime.departmentZohoReadScope ? { departmentZohoReadScope: runtime.departmentZohoReadScope } : {}),
  };

  const pushContact = (record: Record<string, unknown>, orgId: string, idx: number) => {
    const contactId = readString(record.contact_id) ?? readString(record.id);
    if (!contactId) return;
    const key = `${orgId}:${contactId}`;
    if (seen.has(key)) return;
    const displayName =
      readString(record.contact_name) ?? readString(record.customer_name) ??
      readString(record.company_name) ?? contactId;
    const email =
      readString(record.email) ?? readString(record.billing_address_email) ??
      readString(record.primary_contact_email);
    const rawScore = computeEntityScore(query, [displayName, email, readString(record.company_name), JSON.stringify(record)]);
    const score = Math.max(rawScore - Math.min(idx * 0.01, 0.18), rawScore > 0 ? 0.3 : 0);
    seen.add(key);
    const asOf = readString(record.last_modified_time) ?? readString(record.created_time);
    matches.push({
      scope: 'zoho_books', sourceType: 'books_contact', sourceId: contactId, chunkIndex: 0, score,
      excerpt: excerptFrom([displayName, email, readString(record.company_name)].filter(Boolean).join('\n')),
      chunkRef: buildChunkRef('zoho_books', 'books_contact', encodeRef(`${orgId}:${contactId}`), 0),
      sourceLabel: buildSourceLabel({ scope: 'zoho_books', title: displayName, sourceType: 'books_contact', ...opt('asOf', asOf) }),
      ...opt('asOf', asOf),
      displayName, ...opt('email', email),
      organizationId: orgId,
      customerId: readString(record.customer_id) ?? contactId, title: displayName,
      authorityLevel: 'authoritative',
    });
  };

  const pushInvoice = (record: Record<string, unknown>, orgId: string, idx: number) => {
    const invoiceId = readString(record.invoice_id) ?? readString(record.id);
    if (!invoiceId) return;
    const key = `${orgId}:inv:${invoiceId}`;
    if (seen.has(key)) return;
    const customerName =
      readString(record.customer_name) ?? readString(record.contact_name) ?? readString(record.company_name);
    const invoiceNumber = readString(record.invoice_number) ?? invoiceId;
    const customerId = readString(record.customer_id) ?? readString(record.contact_id);
    const rawScore = computeEntityScore(query, [customerName, invoiceNumber, readString(record.reference_number), JSON.stringify(record)]);
    const score = Math.max(rawScore - Math.min(idx * 0.01, 0.18), rawScore > 0 ? 0.3 : 0);
    seen.add(key);
    const asOf =
      readString(record.last_modified_time) ?? readString(record.updated_time) ??
      readString(record.created_time) ?? readString(record.date);
    matches.push({
      scope: 'zoho_books', sourceType: 'books_invoice', sourceId: invoiceId, chunkIndex: 0, score,
      excerpt: excerptFrom([customerName, invoiceNumber, readString(record.status), readString(record.amount_due), readString(record.due_date)].filter(Boolean).join('\n')),
      chunkRef: buildChunkRef('zoho_books', 'books_invoice', encodeRef(`${orgId}:${invoiceId}`), 0),
      sourceLabel: buildSourceLabel({ scope: 'zoho_books', title: customerName ?? invoiceNumber, sourceType: 'books_invoice', ...opt('asOf', asOf) }),
      ...opt('asOf', asOf),
      ...opt('displayName', customerName),
      organizationId: orgId,
      ...opt('customerId', customerId), invoiceId, invoiceNumber,
      title: customerName ? `${customerName} (${invoiceNumber})` : invoiceNumber,
      authorityLevel: 'authoritative',
    });
  };

  for (const orgId of orgIds) {
    for (const q of queries) {
      for (let page = 1; page <= 20; page++) {
        const res = await zohoBooks.listContacts({ ...booksBase, ...opt('organizationId', orgId || undefined), query: q, page, perPage: 200 });
        if (!res.allowed) break;
        res.records.forEach((r, i) => pushContact(r, res.organizationId ?? orgId, ((page - 1) * 200) + i));
        if (matches.length >= limit * 3 || res.records.length < 200) break;
      }
      if (matches.length >= limit * 3) break;
    }
    if (matches.length >= limit * 3) break;
  }

  if (matches.length < limit * 2) {
    for (const orgId of orgIds) {
      for (const q of queries) {
        for (let page = 1; page <= 3; page++) {
          const res = await zohoBooks.listInvoices({ ...booksBase, ...opt('organizationId', orgId || undefined), query: q, page, perPage: 200 });
          if (!res.allowed) break;
          res.records.forEach((r, i) => pushInvoice(r, res.organizationId ?? orgId, ((page - 1) * 200) + i));
          if (matches.length >= limit * 3 || res.records.length < 200) break;
        }
        if (matches.length >= limit * 3) break;
      }
      if (matches.length >= limit * 3) break;
    }
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── Per-source timeout wrapper ───────────────────────────────────────────────

async function withSourceTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<{ result: T; timedOut: boolean }> {
  return Promise.race([
    fn().then(result => ({ result, timedOut: false as const })),
    new Promise<{ result: T; timedOut: true }>(resolve =>
      setTimeout(() => resolve({ result: fallback, timedOut: true }), timeoutMs),
    ),
  ]);
}

// ─── Citations helper ─────────────────────────────────────────────────────────

function toCitations(results: ContextSearchResult[]): ContextCitation[] {
  return results.map((r, i) => ({
    index:       i + 1,
    chunkRef:    r.chunkRef,
    scope:       r.scope,
    sourceType:  r.sourceType,
    sourceId:    r.sourceId,
    sourceLabel: r.sourceLabel,
    excerpt:     r.excerpt,
    score:       r.score,
    ...opt('asOf',     r.asOf),
    ...opt('url',      r.url),
    ...opt('fileName', r.fileName),
    ...opt('title',    r.title),
  }));
}

// ─── Broker ───────────────────────────────────────────────────────────────────

export interface ContextSearchBrokerDeps {
  vectorStore:  VectorStoreAdapter;
  embedding:    EmbeddingPort;
  webSearch:    WebSearchService;
  larkContacts: LarkContactPort;
  zohoBooks:    ZohoBooksPort;
  skills:       SkillPort;
  logger:       Logger;
}

export class ContextSearchBroker {
  private readonly log: Logger;

  constructor(private readonly deps: ContextSearchBrokerDeps) {
    this.log = deps.logger.child({ service: 'context-search-broker' });
  }

  // ─── Source runners ──────────────────────────────────────────────────────

  private async runPersonalHistory(input: ContextSearchInput, limit: number): Promise<ContextSearchResult[]> {
    const qv = await this.deps.embedding.embedQuery(input.query);
    const groups = await this.deps.vectorStore.search({
      companyId:         input.companyId,
      requesterUserId:   input.userId,
      denseVector:       qv,
      limit,
      retrievalProfile:  'chat',
      sourceTypes:       ['chat_turn'],
      includePersonal:   true,
      includeShared:     false,
      includePublic:     false,
      enforceEmailMatch: false,
    });
    const results: ContextSearchResult[] = [];
    for (const group of groups) {
      for (const hit of group.hits) {
        const chunkText = readString(hit.payload._chunk) ?? readString(hit.payload.text);
        if (!chunkText) continue;
        const asOf = readString(hit.payload.sourceUpdatedAt) ?? readString(hit.payload.updatedAt) ?? readString(hit.payload.createdAt);
        results.push({
          scope: 'personal_history', sourceType: 'chat_turn',
          sourceId: hit.sourceId, chunkIndex: hit.chunkIndex,
          score: hit.score,
          excerpt: excerptFrom(chunkText),
          chunkRef: buildChunkRef('personal_history', 'chat_turn', hit.sourceId, hit.chunkIndex),
          sourceLabel: buildSourceLabel({ scope: 'personal_history', title: 'conversation turn', sourceType: 'chat_turn', ...opt('asOf', asOf) }),
          ...opt('asOf', asOf),
          title: 'conversation turn',
          authorityLevel: 'contextual',
        });
      }
    }
    return results.slice(0, limit);
  }

  private async runFiles(input: ContextSearchInput, limit: number): Promise<ContextSearchResult[]> {
    const qv = await this.deps.embedding.embedQuery(input.query);

    // Smart multimodal: when the query mentions images/diagrams/screenshots,
    // also query the multimodal vector branch so image-dense files surface.
    const wantsVisual = isVisualQuery(input.query);

    const groups = await this.deps.vectorStore.search({
      companyId:         input.companyId,
      requesterUserId:   input.userId,
      ...(input.requesterAiRole ? { requesterAiRole: input.requesterAiRole } : {}),
      denseVector:       qv,
      limit,
      retrievalProfile:  'file',
      sourceTypes:       ['file_document'],
      includePersonal:   false,
      includeShared:     true,
      includePublic:     true,
      enforceEmailMatch: false,
      groupByField:      'documentKey',
      groupSize:         3,
      ...(wantsVisual ? { useMultimodal: true, queryMode: 'multimodal' as const } : {}),
    });
    const results: ContextSearchResult[] = [];
    for (const group of groups) {
      for (const hit of group.hits) {
        const chunkText = readString(hit.payload._chunk) ?? readString(hit.payload.text);
        if (!chunkText) continue;
        const fileName     = readString(hit.payload.fileName) ?? readString(hit.payload.title);
        const cloudUrl     = readString(hit.payload.cloudinaryUrl) ?? readString(hit.payload.sourceUrl);
        const mimeType     = readString(hit.payload.mimeType) ?? '';
        const isImage      = mimeType.startsWith('image/');
        results.push({
          scope: 'files', sourceType: 'file_document',
          sourceId: hit.sourceId, chunkIndex: hit.chunkIndex,
          score: hit.score,
          excerpt: excerptFrom(chunkText),
          chunkRef: buildChunkRef('files', 'file_document', hit.sourceId, hit.chunkIndex),
          sourceLabel: buildSourceLabel({
            scope: 'files',
            ...opt('fileName', fileName ? `${isImage ? '🖼️ ' : '📄 '}${fileName}` : undefined),
            sourceType: 'file_document',
          }),
          ...opt('fileName', fileName),
          ...opt('title', fileName),
          ...opt('url', cloudUrl),
          authorityLevel: 'documentary',
        });
      }
    }
    return results.slice(0, limit);
  }

  private async runLarkContacts(input: ContextSearchInput, limit: number): Promise<ContextSearchResult[]> {
    const people = await this.deps.larkContacts.searchContacts({
      companyId: input.companyId,
      query:     input.query,
      limit,
    });
    const results: ContextSearchResult[] = [];
    for (let i = 0; i < people.length; i++) {
      const p = people[i]!;
      const sourceId =
        readString(p.larkOpenId) ?? readString(p.externalUserId) ?? readString(p.larkUserId) ?? '';
      if (!sourceId) continue;
      const excerpt = excerptFrom([p.displayName, p.email, sourceId].filter(Boolean).join('\n'));
      const asOf = p.updatedAt?.toISOString() ?? p.createdAt?.toISOString();
      results.push({
        scope: 'lark_contacts', sourceType: 'lark_contact',
        sourceId, chunkIndex: 0,
        score: Math.max(0.95 - i * 0.05, 0.55),
        excerpt,
        chunkRef: buildChunkRef('lark_contacts', 'lark_contact', sourceId, 0),
        sourceLabel: buildSourceLabel({ scope: 'lark_contacts', ...opt('displayName', p.displayName), sourceType: 'lark_contact', ...opt('asOf', asOf) }),
        ...opt('asOf', asOf),
        ...opt('displayName', p.displayName),
        ...opt('email', p.email),
        ...opt('title', p.displayName ?? p.email),
        authorityLevel: 'contextual',
      });
    }
    return results;
  }

  private async runZohoCrmContext(input: ContextSearchInput, limit: number): Promise<ContextSearchResult[]> {
    const qv = await this.deps.embedding.embedQuery(input.query);
    const groups = await this.deps.vectorStore.search({
      companyId:         input.companyId,
      requesterUserId:   input.userId,
      ...(input.requesterEmail ? { requesterEmail: input.requesterEmail } : {}),
      denseVector:       qv,
      limit,
      retrievalProfile:  'zoho',
      sourceTypes:       ['zoho_lead', 'zoho_contact', 'zoho_account', 'zoho_deal', 'zoho_ticket'],
      includePersonal:   false,
      includeShared:     true,
      includePublic:     false,
      enforceEmailMatch: false,
    });
    const results: ContextSearchResult[] = [];
    for (const group of groups) {
      for (const hit of group.hits) {
        const chunkText = readString(hit.payload._chunk) ?? readString(hit.payload.text);
        if (!chunkText) continue;
        const asOf  = readString(hit.payload.sourceUpdatedAt) ?? readString(hit.payload.updatedAt) ?? readString(hit.payload.createdAt);
        const title = readString(hit.payload.citationTitle) ?? readString(hit.payload.title);
        results.push({
          scope: 'zoho_crm', sourceType: hit.sourceType,
          sourceId: hit.sourceId, chunkIndex: hit.chunkIndex,
          score: hit.score,
          excerpt: excerptFrom(chunkText),
          chunkRef: buildChunkRef('zoho_crm', hit.sourceType, hit.sourceId, hit.chunkIndex),
          sourceLabel: buildSourceLabel({ scope: 'zoho_crm', ...opt('title', title), sourceType: hit.sourceType, ...opt('asOf', asOf) }),
          ...opt('asOf', asOf),
          ...opt('title', title),
          authorityLevel: 'authoritative',
        });
      }
    }
    return results.slice(0, limit);
  }

  private async runZohoBooksLive(input: ContextSearchInput, limit: number): Promise<ContextSearchResult[]> {
    return searchZohoBooksLive({ runtime: input, query: input.query, limit, zohoBooks: this.deps.zohoBooks });
  }

  private async runWorkspace(input: ContextSearchInput, limit: number): Promise<ContextSearchResult[]> {
    if (!input.workspacePath) return [];
    return searchWorkspace(input.workspacePath, input.query, limit);
  }

  private async runWeb(input: ContextSearchInput, limit: number): Promise<ContextSearchResult[]> {
    const result = await this.deps.webSearch.search({
      query:             input.query,
      ...(input.site ? { exactDomain: input.site.trim() } : {}),
      searchResultsLimit: limit,
      pageContextLimit:   Math.min(2, limit),
    });
    return result.items.map((item, i): ContextSearchResult => {
      const encodedUrl = encodeRef(item.link);
      const excerpt    = excerptFrom(item.pageContext?.excerpt ?? item.snippet ?? '');
      return {
        scope: 'web', sourceType: 'web_result',
        sourceId: encodedUrl, chunkIndex: 0,
        score: Math.max(1 - i * 0.05, 0.5),
        excerpt,
        chunkRef: buildChunkRef('web', 'web_result', encodedUrl, 0),
        sourceLabel: buildSourceLabel({ scope: 'web', ...opt('title', item.title), sourceType: 'web_result', ...opt('asOf', item.date), domain: item.domain }),
        ...opt('asOf', item.date),
        ...opt('title', item.title),
        url: item.link,
        authorityLevel: 'public',
      };
    });
  }

  private async runSkills(input: ContextSearchInput, limit: number): Promise<ContextSearchResult[]> {
    const skillList = await this.deps.skills.search({
      companyId:    input.companyId,
      ...opt('departmentId', input.departmentId),
      query:        input.query,
      limit,
    });
    return skillList.map((skill, i): ContextSearchResult => ({
      scope: 'skills', sourceType: 'skill',
      sourceId: skill.id || skill.slug, chunkIndex: 0,
      score: Math.max(1 - i * 0.05, 0.5),
      excerpt: excerptFrom(skill.summary || skill.name || skill.slug || skill.id),
      chunkRef: buildChunkRef('skills', 'skill', skill.id || skill.slug, 0),
      sourceLabel: buildSourceLabel({ scope: 'skills', ...opt('title', skill.name), sourceType: 'skill' }),
      ...opt('title', skill.name),
      skillId: skill.id, skillSlug: skill.slug,
      authorityLevel: 'contextual',
    }));
  }

  // ─── Search ──────────────────────────────────────────────────────────────

  async search(input: ContextSearchInput): Promise<ContextSearchOutput> {
    const query  = input.query.trim();
    const limit  = clamp(input.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const toutMs = input.sourceTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    const req = input.sources ?? {};
    const enabled: Record<ContextSourceKey, boolean> = {
      personalHistory: req.personalHistory ?? true,
      files:           req.files           ?? true,
      larkContacts:    req.larkContacts    ?? true,
      zohoCrmContext:  req.zohoCrmContext   ?? true,
      zohoBooksLive:   req.zohoBooksLive   ?? false,
      workspace:       req.workspace       ?? (input.workspacePath ? true : false),
      web:             req.web             ?? false,
      skills:          req.skills          ?? false,
    };

    const dateFrom = parseDate(input.dateFrom, 'start');
    const dateTo   = parseDate(input.dateTo,   'end');

    const mkCov = (enabled: boolean): SourceCoverageEntry => ({
      enabled,
      status: enabled ? 'queried' : 'disabled',
      resultCount: 0,
    });

    const coverage: Record<ContextSourceKey, SourceCoverageEntry> = {
      personalHistory: mkCov(enabled.personalHistory),
      files:           mkCov(enabled.files),
      larkContacts:    mkCov(enabled.larkContacts),
      zohoCrmContext:  mkCov(enabled.zohoCrmContext),
      zohoBooksLive:   mkCov(enabled.zohoBooksLive),
      workspace:       mkCov(enabled.workspace),
      web:             mkCov(enabled.web),
      skills:          mkCov(enabled.skills),
    };

    type RunnerFn = (i: ContextSearchInput, l: number) => Promise<ContextSearchResult[]>;
    const runners: Record<ContextSourceKey, RunnerFn> = {
      personalHistory: (i, l) => this.runPersonalHistory(i, l),
      files:           (i, l) => this.runFiles(i, l),
      larkContacts:    (i, l) => this.runLarkContacts(i, l),
      zohoCrmContext:  (i, l) => this.runZohoCrmContext(i, l),
      zohoBooksLive:   (i, l) => this.runZohoBooksLive(i, l),
      workspace:       (i, l) => this.runWorkspace(i, l),
      web:             (i, l) => this.runWeb(i, l),
      skills:          (i, l) => this.runSkills(i, l),
    };

    const activeKeys = (Object.keys(enabled) as ContextSourceKey[]).filter(k => enabled[k]);

    const settled = await Promise.allSettled(
      activeKeys.map(async key => {
        const { result, timedOut } = await withSourceTimeout(
          () => runners[key](input, limit * 3),
          toutMs,
          [] as ContextSearchResult[],
        );
        return { key, result, timedOut };
      }),
    );

    const allResults: ContextSearchResult[] = [];
    for (const outcome of settled) {
      if (outcome.status === 'rejected') continue; // withSourceTimeout never rejects itself
      const { key, result, timedOut } = outcome.value;
      if (timedOut) {
        coverage[key] = { enabled: true, status: 'timeout', resultCount: 0 };
        this.log.warn('context_search.source.timeout', { source: key, companyId: input.companyId });
        continue;
      }
      const filtered = (dateFrom || dateTo)
        ? result.filter(r => dateMatches(r.asOf, dateFrom, dateTo))
        : result;
      coverage[key] = { ...coverage[key], resultCount: filtered.length };
      allResults.push(...filtered);
    }

    const ranked = rankResults(allResults, limit).map(r => ({
      ...r,
      authorityLevel: r.authorityLevel ?? getAuthorityLevel(r.scope),
    }));

    this.log.debug('context_search.completed', {
      companyId: input.companyId, query,
      totalRaw: allResults.length, finalCount: ranked.length,
      sourcesEnabled: activeKeys,
    });

    const resolvedEntities = buildResolvedEntities(ranked);
    const citations        = toCitations(ranked);
    const sourcesChecked   = activeKeys.join(', ');
    const searchSummary    = ranked.length > 0
      ? `Found ${ranked.length} result(s) matching "${query}" across ${sourcesChecked}.`
      : `No matching records found for "${query}". Checked: ${sourcesChecked}.`;

    return {
      results:          ranked,
      matches:          ranked,
      resolvedEntities,
      sourceCoverage:   coverage as SourceCoverage,
      citations,
      nextFetchRefs:    ranked.map(r => r.chunkRef),
      searchSummary,
    };
  }

  // ─── Fetch ───────────────────────────────────────────────────────────────

  async fetch(input: ContextFetchInput): Promise<ContextFetchOutput | null> {
    const parsed = parseChunkRef(input.chunkRef);
    if (!parsed) return null;
    const { scope, sourceType, sourceId, chunkIndex } = parsed;

    if (scope === 'workspace') {
      if (!input.workspacePath) return null;
      const rel  = decodeRef(sourceId);
      const full = path.join(input.workspacePath, rel);
      let text: string;
      try { text = await fsp.readFile(full, 'utf8'); } catch { return null; }
      return { chunkRef: input.chunkRef, scope, sourceType, sourceId, chunkIndex, text, resolvedEntities: { workspacePath: rel } };
    }

    if (scope === 'web') {
      const url = decodeRef(sourceId);
      const res = await this.deps.webSearch.search({ query: url, searchResultsLimit: 1, pageContextLimit: 1 });
      const item = res.items[0];
      const text = item?.pageContext?.excerpt ?? item?.snippet ?? '';
      if (!text.trim()) return null;
      return {
        chunkRef: input.chunkRef, scope, sourceType, sourceId, chunkIndex, text,
        resolvedEntities: { webUrl: url, ...opt('webTitle', item?.title) },
      };
    }

    if (scope === 'lark_contacts') {
      const people = await this.deps.larkContacts.searchContacts({ companyId: input.companyId, query: sourceId, limit: 10 });
      const person = people.find(p =>
        [readString(p.larkOpenId), readString(p.externalUserId), readString(p.larkUserId)]
          .filter((v): v is string => Boolean(v))
          .includes(sourceId),
      );
      if (!person) return null;
      const text = normalizeText([person.displayName, person.email, sourceId].filter(Boolean).join('\n'));
      return {
        chunkRef: input.chunkRef, scope, sourceType, sourceId, chunkIndex, text,
        resolvedEntities: {
          ...opt('recipientEmail', person.email),
          ...opt('recipientName', person.displayName),
          recipientOpenId: sourceId,
        },
      };
    }

    if (scope === 'skills') {
      const skill = await this.deps.skills.readById({ companyId: input.companyId, ...opt('departmentId', input.departmentId), skillId: sourceId });
      if (!skill) return null;
      return { chunkRef: input.chunkRef, scope, sourceType, sourceId, chunkIndex, text: skill.markdown, resolvedEntities: { skillId: skill.id, skillSlug: skill.slug } };
    }

    if (scope === 'zoho_books') {
      const decoded = decodeRef(sourceId);
      const [orgId, recordId] = decoded.split(':');
      if (!recordId) return null;
      const module = sourceType === 'books_invoice' ? 'invoices' : 'contacts';
      const res = await this.deps.zohoBooks.getRecord({
        companyId: input.companyId, userId: input.userId,
        ...opt('departmentId', input.departmentId),
        ...opt('organizationId', orgId || undefined),
        module, recordId,
      });
      if (!res.allowed || !res.record) return null;
      const record = res.record;
      const text = normalizeText(JSON.stringify(record, null, 2));
      return {
        chunkRef: input.chunkRef, scope, sourceType, sourceId: recordId, chunkIndex, text,
        resolvedEntities: {
          ...(sourceType === 'books_contact' ? { contactId: recordId } : {}),
          ...(sourceType === 'books_invoice' ? { invoiceId: recordId } : {}),
          ...opt('organizationId',  res.organizationId),
          ...opt('customerId',      readString(record.customer_id)),
          ...opt('invoiceNumber',   readString(record.invoice_number)),
          ...opt('customerName',    readString(record.customer_name) ?? readString(record.contact_name)),
          ...opt('customerEmail',   readString(record.email)),
        },
      };
    }

    // personalHistory / files / zoho_crm — no standalone chunk fetch in this implementation
    return null;
  }
}
