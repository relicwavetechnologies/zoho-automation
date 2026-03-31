import { promises as fs } from 'fs';
import path from 'path';

import type { VercelCitation, VercelRuntimeRequestContext } from '../orchestration/vercel/types';
import { channelIdentityRepository } from '../channels/channel-identity.repository';
import { zohoRetrievalService } from '../agents/support/zoho-retrieval.service';
import { zohoBooksClient } from '../integrations/zoho/zoho-books.client';
import { zohoGatewayService } from '../integrations/zoho/zoho-gateway.service';
import { webSearchService } from '../integrations/search/web-search.service';
import { personalVectorMemoryService } from '../integrations/vector/personal-vector-memory.service';
import { vectorDocumentRepository } from '../integrations/vector/vector-document.repository';
import { skillService } from '../skills/skill.service';
import { fileRetrievalService } from './file-retrieval.service';
import { logger } from '../../utils/logger';

export type ContextSearchBrokerSourceKey =
  | 'personalHistory'
  | 'files'
  | 'larkContacts'
  | 'zohoCrmContext'
  | 'zohoBooksLive'
  | 'workspace'
  | 'web'
  | 'skills';

export type ContextSearchBrokerSources = {
  personalHistory?: boolean;
  files?: boolean;
  larkContacts?: boolean;
  zohoCrmContext?: boolean;
  zohoBooksLive?: boolean;
  workspace?: boolean;
  web?: boolean;
  skills?: boolean;
};

type ContextSearchBrokerRuntime = Pick<
  VercelRuntimeRequestContext,
  | 'channel'
  | 'companyId'
  | 'userId'
  | 'requesterAiRole'
  | 'requesterEmail'
  | 'departmentId'
  | 'departmentZohoReadScope'
  | 'workspace'
>;

export type ContextSearchBrokerSearchInput = {
  runtime: ContextSearchBrokerRuntime;
  query: string;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  sources?: ContextSearchBrokerSources;
  site?: string;
  webMode?: 'search' | 'focusedSearch' | 'fetchPageContext';
};

export type ContextSearchBrokerFetchInput = {
  runtime: ContextSearchBrokerRuntime;
  chunkRef: string;
};

export type ContextSearchBrokerResult = {
  scope: string;
  sourceType: string;
  sourceId: string;
  chunkIndex: number;
  score: number;
  excerpt: string;
  chunkRef: string;
  sourceLabel: string;
  asOf?: string;
  url?: string;
  title?: string;
  fileName?: string;
  displayName?: string;
  email?: string;
  organizationId?: string;
  skillId?: string;
  skillSlug?: string;
};

type SourceCoverage = {
  enabled: boolean;
  status: 'queried' | 'disabled' | 'unavailable' | 'error';
  resultCount: number;
  error?: string;
};

export type ContextSearchBrokerSearchOutput = {
  results: ContextSearchBrokerResult[];
  matches: ContextSearchBrokerResult[];
  resolvedEntities: Record<string, string>;
  sourceCoverage: Record<ContextSearchBrokerSourceKey, SourceCoverage>;
  citations: Array<Record<string, unknown>>;
  nextFetchRefs: string[];
  searchSummary: string;
};

export type ContextSearchBrokerFetchOutput = {
  chunkRef: string;
  scope: string;
  sourceType: string;
  sourceId: string;
  chunkIndex: number;
  text: string;
  resolvedEntities: Record<string, string>;
};

type SearchScaleStrategy =
  | 'default'
  | 'focused_books'
  | 'focused_crm'
  | 'focused_files'
  | 'focused_workspace'
  | 'focused_web'
  | 'focused_history'
  | 'broad_first';

const TEXT_FILE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.yml',
  '.yaml',
  '.toml',
  '.env',
  '.csv',
  '.sql',
  '.html',
  '.css',
  '.scss',
  '.xml',
]);
const WORKSPACE_IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo']);
const WORKSPACE_FILE_LIMIT = 150;
const WORKSPACE_MAX_FILE_BYTES = 100_000;

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const uniqueStrings = (values: Array<string | undefined | null>): string[] =>
  Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)));

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, ' ');
const normalizeLookupText = (value: string): string => normalizeText(value).toLowerCase();

const SOURCE_CONSTRAINED_PATTERNS: Array<{ strategy: SearchScaleStrategy; pattern: RegExp }> = [
  {
    strategy: 'focused_books',
    pattern: /\b(?:in|from|inside|within|under)\s+(?:zoho\s+books|books)\b|\b(?:zoho\s+books|books)\s+(?:only|first)\b/i,
  },
  {
    strategy: 'focused_crm',
    pattern: /\b(?:in|from|inside|within|under)\s+(?:zoho\s+crm|crm)\b|\b(?:zoho\s+crm|crm)\s+(?:only|first)\b/i,
  },
  {
    strategy: 'focused_files',
    pattern: /\b(?:in|from|inside|within|under)\s+(?:files|docs|documents|pdfs|attachments)\b/i,
  },
  {
    strategy: 'focused_workspace',
    pattern: /\b(?:in|from|inside|within|under)\s+workspace\b/i,
  },
  {
    strategy: 'focused_web',
    pattern: /\b(?:on|from|search)\s+(?:the\s+)?(?:web|internet|online)\b|\bgoogle\b/i,
  },
  {
    strategy: 'focused_history',
    pattern: /\b(?:in|from|inside|within|under)\s+(?:history|memory|chat|conversation)\b/i,
  },
];

const GENERIC_SEARCH_VERBS = /\b(search|find|look up|lookup|check|trace|get details|tell me about|show me|who is|what is)\b/i;
const STRUCTURED_INTERNAL_CUES = /\b(invoice|invoices|statement|statements|payment|payments|overdue|balance|balances|vendor|vendors|customer|customers|contact|contacts|deal|deals|account|accounts|lead|leads)\b/i;
const ENTITY_SUFFIX_CUES = /\b(llc|inc|ltd|limited|corp|corporation|company|private limited|pvt ltd|gmbh|plc)\b/i;
const PERSON_LOOKUP_CUES = /\b(email|mail|phone|number|address|person|people|teammate|employee|coworker|colleague|open id|openid)\b/i;
const AMBIGUOUS_SEARCH_NOISE = /\b(please|plz|kindly|search|find|look up|lookup|check|show|me|for|about|details|info|information)\b/gi;
const AUTHORITATIVE_ENTITY_SCOPES = new Set(['zoho_books', 'zoho_crm', 'files', 'workspace']);
const SOURCE_PRIORITY_BY_SCOPE: Record<string, number> = {
  zoho_books: 1.6,
  zoho_crm: 1.5,
  files: 1.15,
  workspace: 1.05,
  skills: 0.95,
  web: 0.75,
  personal_history: 0.15,
  lark_contacts: 0.1,
};

const inferSearchScaleStrategy = (input: {
  query: string;
  explicitSourcesProvided: boolean;
  site?: string;
}): SearchScaleStrategy => {
  if (input.explicitSourcesProvided || input.site?.trim()) {
    return 'default';
  }

  const normalized = normalizeLookupText(input.query);
  for (const candidate of SOURCE_CONSTRAINED_PATTERNS) {
    if (candidate.pattern.test(normalized)) {
      return candidate.strategy;
    }
  }

  const deNoised = normalized.replace(AMBIGUOUS_SEARCH_NOISE, ' ').replace(/\s+/g, ' ').trim();
  const tokenCount = deNoised.length > 0 ? deNoised.split(/\s+/).length : 0;
  const genericEntityLookup =
    GENERIC_SEARCH_VERBS.test(normalized)
    && !STRUCTURED_INTERNAL_CUES.test(normalized)
    && (ENTITY_SUFFIX_CUES.test(normalized) || (tokenCount >= 2 && tokenCount <= 8));

  if (genericEntityLookup) {
    return 'broad_first';
  }

  return 'default';
};

const isCompanyEntityLookupQuery = (query: string): boolean => {
  const normalized = normalizeLookupText(query);
  if (!normalized || PERSON_LOOKUP_CUES.test(normalized)) {
    return false;
  }
  if (ENTITY_SUFFIX_CUES.test(normalized)) {
    return true;
  }
  if (!GENERIC_SEARCH_VERBS.test(normalized) || STRUCTURED_INTERNAL_CUES.test(normalized)) {
    return false;
  }
  const deNoised = normalized.replace(AMBIGUOUS_SEARCH_NOISE, ' ').replace(/\s+/g, ' ').trim();
  const tokenCount = deNoised.length > 0 ? deNoised.split(/\s+/).length : 0;
  return tokenCount >= 2 && tokenCount <= 6;
};

const rankContextSearchResults = (
  results: ContextSearchBrokerResult[],
  input: { query: string; limit: number },
): ContextSearchBrokerResult[] => {
  const companyLookup = isCompanyEntityLookupQuery(input.query);
  const filtered = results.filter((result) => {
    if (!companyLookup) {
      return true;
    }
    if (result.scope === 'personal_history' && result.sourceType === 'chat_turn') {
      return false;
    }
    if (result.scope === 'lark_contacts') {
      return false;
    }
    return true;
  });
  const hasAuthoritativeEntityHit = filtered.some((result) => AUTHORITATIVE_ENTITY_SCOPES.has(result.scope));
  const ranked = filtered
    .map((result, index) => {
      const priority = SOURCE_PRIORITY_BY_SCOPE[result.scope] ?? 1;
      const authoritativeBoost = companyLookup && AUTHORITATIVE_ENTITY_SCOPES.has(result.scope) ? 0.2 : 0;
      const effectiveScore = (result.score * priority) + authoritativeBoost - (index * 0.0001);
      return {
        result,
        effectiveScore,
      };
    })
    .filter(({ result }) => !(companyLookup && hasAuthoritativeEntityHit && (result.scope === 'web' || result.scope === 'skills')))
    .sort((left, right) => right.effectiveScore - left.effectiveScore)
    .slice(0, input.limit)
    .map(({ result }) => result);
  return ranked;
};

const applySearchScaleStrategy = (
  sources: Record<ContextSearchBrokerSourceKey, boolean>,
  strategy: SearchScaleStrategy,
  hasWorkspace: boolean,
) => {
  if (strategy === 'default') {
    return;
  }

  const resetAllSources = () => {
    for (const key of Object.keys(sources) as ContextSearchBrokerSourceKey[]) {
      sources[key] = false;
    }
  };

  switch (strategy) {
    case 'focused_books':
      resetAllSources();
      sources.zohoBooksLive = true;
      break;
    case 'focused_crm':
      resetAllSources();
      sources.zohoCrmContext = true;
      break;
    case 'focused_files':
      resetAllSources();
      sources.files = true;
      break;
    case 'focused_workspace':
      resetAllSources();
      sources.workspace = hasWorkspace;
      break;
    case 'focused_web':
      resetAllSources();
      sources.web = true;
      break;
    case 'focused_history':
      resetAllSources();
      sources.personalHistory = true;
      break;
    case 'broad_first':
      sources.personalHistory = true;
      sources.files = true;
      sources.larkContacts = true;
      sources.zohoCrmContext = true;
      sources.zohoBooksLive = true;
      sources.workspace = hasWorkspace;
      sources.web = false;
      break;
    default:
      break;
  }
};

const parseDate = (value: string | undefined, edge: 'start' | 'end'): Date | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return new Date(Number.NaN);
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    if (edge === 'start') parsed.setUTCHours(0, 0, 0, 0);
    else parsed.setUTCHours(23, 59, 59, 999);
  }
  return parsed;
};

const dateMatches = (timestampIso: string | undefined, dateFrom: Date | null, dateTo: Date | null): boolean => {
  if (!dateFrom && !dateTo) return true;
  if (!timestampIso) return false;
  const parsed = new Date(timestampIso);
  if (Number.isNaN(parsed.getTime())) return false;
  if (dateFrom && parsed < dateFrom) return false;
  if (dateTo && parsed > dateTo) return false;
  return true;
};

const encodeRefSegment = (value: string): string => Buffer.from(value, 'utf8').toString('base64url');
const decodeRefSegment = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');

const buildChunkRef = (scope: string, sourceType: string, sourceId: string, chunkIndex: number): string =>
  `${scope}:${sourceType}:${sourceId}:${chunkIndex}`;

const parseChunkRef = (chunkRef: string): {
  scope: string;
  sourceType: string;
  sourceId: string;
  chunkIndex: number;
} | null => {
  const parts = chunkRef.split(':');
  if (parts.length !== 4) return null;
  const [scope, sourceType, sourceId, chunkIndexRaw] = parts;
  const chunkIndex = Number.parseInt(chunkIndexRaw ?? '', 10);
  if (!scope || !sourceType || !sourceId || Number.isNaN(chunkIndex)) return null;
  return { scope, sourceType, sourceId, chunkIndex };
};

const buildSourceLabel = (input: {
  scope: string;
  title?: string;
  fileName?: string;
  displayName?: string;
  sourceType: string;
  asOf?: string;
  domain?: string;
}): string => {
  const asOf = input.asOf ? ` · ${input.asOf}` : '';
  if (input.scope === 'lark_contacts') return `Lark contact · ${input.displayName ?? input.title ?? input.sourceType}${asOf}`;
  if (input.scope === 'files') return `Company file · ${input.fileName ?? input.title ?? input.sourceType}${asOf}`;
  if (input.scope === 'personal_history') return `Personal history · ${input.title ?? input.sourceType}${asOf}`;
  if (input.scope === 'zoho_crm') return `Zoho CRM context · ${input.title ?? input.sourceType}${asOf}`;
  if (input.scope === 'zoho_books') return `Zoho Books · ${input.title ?? input.sourceType}${asOf}`;
  if (input.scope === 'web') return `Web · ${input.domain ?? input.title ?? input.sourceType}${asOf}`;
  if (input.scope === 'skills') return `Skill · ${input.title ?? input.sourceType}${asOf}`;
  if (input.scope === 'workspace') return `Workspace · ${input.fileName ?? input.title ?? input.sourceType}${asOf}`;
  return `${input.scope} · ${input.title ?? input.sourceType}${asOf}`;
};

const setResolvedEntity = (target: Record<string, string>, key: string, value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed || target[key]) return;
  target[key] = trimmed;
};

const extractWorkspaceFiles = async (rootPath: string): Promise<string[]> => {
  const collected: string[] = [];
  const queue = [rootPath];
  while (queue.length > 0 && collected.length < WORKSPACE_FILE_LIMIT) {
    const current = queue.shift()!;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true }) as Array<any>;
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (collected.length >= WORKSPACE_FILE_LIMIT) break;
      if (entry.isDirectory()) {
        if (!WORKSPACE_IGNORED_DIRS.has(entry.name)) {
          queue.push(path.join(current, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const fullPath = path.join(current, entry.name);
      const ext = path.extname(entry.name).toLowerCase();
      if (TEXT_FILE_EXTENSIONS.has(ext) || entry.name.toLowerCase().includes('.env')) {
        collected.push(fullPath);
      }
    }
  }
  return collected;
};

const searchWorkspace = async (input: {
  runtime: ContextSearchBrokerRuntime;
  query: string;
  limit: number;
}): Promise<ContextSearchBrokerResult[]> => {
  const workspacePath = input.runtime.workspace?.path?.trim();
  if (!workspacePath) return [];
  const tokens = uniqueStrings(
    input.query
      .toLowerCase()
      .split(/[^a-z0-9@._/-]+/i)
      .map((token) => token.trim()),
  );
  if (tokens.length === 0) return [];

  const files = await extractWorkspaceFiles(workspacePath);
  const matches: ContextSearchBrokerResult[] = [];
  for (const filePath of files) {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    if (stat.size > WORKSPACE_MAX_FILE_BYTES) continue;
    let text = '';
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch {
      continue;
    }
    const relativePath = path.relative(workspacePath, filePath) || path.basename(filePath);
    const lowerPath = relativePath.toLowerCase();
    const lowerText = text.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (lowerPath === token) score += 8;
      else if (lowerPath.includes(token)) score += 5;
      if (lowerText.includes(token)) score += 2;
    }
    if (score <= 0) continue;
    const firstIndex = tokens
      .map((token) => lowerText.indexOf(token))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0] ?? 0;
    const excerpt = normalizeText(text.slice(Math.max(0, firstIndex - 160), Math.min(text.length, firstIndex + 360)));
    const sourceId = encodeRefSegment(relativePath);
    const asOf = stat.mtime.toISOString();
    matches.push({
      scope: 'workspace',
      sourceType: 'workspace_file',
      sourceId,
      chunkIndex: 0,
      score,
      excerpt,
      chunkRef: buildChunkRef('workspace', 'workspace_file', sourceId, 0),
      sourceLabel: buildSourceLabel({
        scope: 'workspace',
        fileName: relativePath,
        sourceType: 'workspace_file',
        asOf,
      }),
      asOf,
      fileName: relativePath,
      title: relativePath,
    });
  }

  return matches.sort((left, right) => right.score - left.score).slice(0, input.limit);
};

const buildResolvedEntities = (results: ContextSearchBrokerResult[]): Record<string, string> => {
  const resolved: Record<string, string> = {};
  for (const result of results) {
    if (result.scope === 'lark_contacts') {
      setResolvedEntity(resolved, 'recipientEmail', result.email);
      setResolvedEntity(resolved, 'recipientName', result.displayName);
      setResolvedEntity(resolved, 'recipientOpenId', result.sourceId);
    }
    if (result.scope === 'web') {
      setResolvedEntity(resolved, 'webUrl', result.url);
      setResolvedEntity(resolved, 'webTitle', result.title);
    }
    if (result.scope === 'files') {
      setResolvedEntity(resolved, 'fileAssetId', result.sourceId);
      setResolvedEntity(resolved, 'fileName', result.fileName);
    }
    if (result.scope === 'workspace') {
      setResolvedEntity(resolved, 'workspacePath', result.fileName);
    }
    if (result.scope === 'skills') {
      setResolvedEntity(resolved, 'skillId', result.skillId ?? result.sourceId);
      setResolvedEntity(resolved, 'skillSlug', result.skillSlug ?? result.sourceId);
    }
    if (result.scope === 'zoho_books') {
      setResolvedEntity(resolved, 'contactId', result.sourceId);
      setResolvedEntity(resolved, 'organizationId', result.organizationId);
      setResolvedEntity(resolved, 'customerName', result.displayName ?? result.title);
      setResolvedEntity(resolved, 'customerEmail', result.email);
    }
  }
  return resolved;
};

const buildZohoGatewayRequester = (runtime: ContextSearchBrokerRuntime) => ({
  companyId: runtime.companyId,
  userId: runtime.userId,
  departmentId: runtime.departmentId,
  requesterEmail: runtime.requesterEmail,
  requesterAiRole: runtime.requesterAiRole,
  departmentZohoReadScope: runtime.departmentZohoReadScope,
});

const sanitizeZohoBooksSearchVariant = (value: string): string | undefined => {
  const cleaned = value
    .replace(/\b(can you|please|share|fetch|get|retrieve|show|reply in thread|in thread|from zoho books|zoho books|customer statement|statement|customer|only)\b/gi, ' ')
    .replace(/[“”"'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 1 ? cleaned : undefined;
};

const buildZohoBooksSearchQueries = (query: string): string[] => {
  const candidates = new Set<string>();
  const trimmed = query.trim();
  if (trimmed) candidates.add(trimmed);
  const forMatch = trimmed.match(/\bfor\s+(.+?)(?:\b(?:from|reply|please|in thread|only)\b|$)/i);
  const forVariant = sanitizeZohoBooksSearchVariant(forMatch?.[1] ?? '');
  if (forVariant) candidates.add(forVariant);
  const sanitized = sanitizeZohoBooksSearchVariant(trimmed);
  if (sanitized) candidates.add(sanitized);
  return Array.from(candidates).slice(0, 3);
};

const scoreZohoBooksContactMatch = (record: Record<string, unknown>, query: string, index: number): number => {
  const haystack = JSON.stringify(record).toLowerCase();
  const normalized = query.trim().toLowerCase();
  const compact = normalized.replace(/\s+/g, ' ');
  if (!compact) return Math.max(0.6 - index * 0.03, 0.2);
  if (haystack.includes(`"${compact}"`) || haystack.includes(`:${compact}`)) {
    return Math.max(0.98 - index * 0.02, 0.5);
  }
  if (haystack.includes(compact)) {
    return Math.max(0.94 - index * 0.03, 0.45);
  }
  return Math.max(0.7 - index * 0.04, 0.3);
};

const searchZohoBooksLive = async (input: {
  runtime: ContextSearchBrokerRuntime;
  query: string;
  limit: number;
}): Promise<ContextSearchBrokerResult[]> => {
  const queries = buildZohoBooksSearchQueries(input.query);
  if (queries.length === 0) return [];

  const requester = buildZohoGatewayRequester(input.runtime);
  const organizations = await zohoBooksClient.listOrganizations({
    companyId: input.runtime.companyId,
  }).catch(() => []);
  const organizationIds = uniqueStrings([
    ...organizations.map((organization) => organization.organizationId),
    '',
  ]);
  const matches: ContextSearchBrokerResult[] = [];
  const seen = new Set<string>();
  const perPage = 200;
  const maxPages = 20;

  for (const organizationId of organizationIds) {
    for (const queryVariant of queries) {
      for (let page = 1; page <= maxPages; page += 1) {
        const auth = await zohoGatewayService.listAuthorizedRecords({
          domain: 'books',
          module: 'contacts',
          requester,
          organizationId: organizationId || undefined,
          query: queryVariant,
          limit: perPage,
          page,
          perPage,
        });
        if (auth.allowed !== true) {
          break;
        }
        const payload = asRecord(auth.payload) ?? {};
        const records = Array.isArray(payload.records)
          ? payload.records.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry))
          : [];
        for (const [index, record] of records.entries()) {
          const contactId = readString(record.contact_id) ?? readString(record.id);
          if (!contactId) continue;
          const resolvedOrganizationId = auth.organizationId ?? organizationId;
          const key = `${resolvedOrganizationId}:${contactId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const displayName =
            readString(record.contact_name)
            ?? readString(record.customer_name)
            ?? readString(record.company_name)
            ?? readString(record.contact_person)
            ?? contactId;
          const email =
            readString(record.email)
            ?? readString(record.billing_address_email)
            ?? readString(record.primary_contact_email);
          const asOf = readString(record.last_modified_time) ?? readString(record.created_time);
          matches.push({
            scope: 'zoho_books',
            sourceType: 'books_contact',
            sourceId: contactId,
            chunkIndex: 0,
            score: scoreZohoBooksContactMatch(record, queryVariant, ((page - 1) * perPage) + index),
            excerpt: normalizeText([
              displayName,
              email,
              readString(record.company_name),
              readString(resolvedOrganizationId),
            ].filter(Boolean).join('\n')),
            chunkRef: buildChunkRef('zoho_books', 'books_contact', encodeRefSegment(`${resolvedOrganizationId}:${contactId}`), 0),
            sourceLabel: buildSourceLabel({
              scope: 'zoho_books',
              title: displayName,
              sourceType: 'books_contact',
              asOf,
            }),
            asOf,
            displayName,
            email,
            organizationId: resolvedOrganizationId,
            title: displayName,
          });
        }
        if (matches.length >= input.limit * 3 || records.length < perPage) {
          break;
        }
      }
      if (matches.length >= input.limit * 3) break;
    }
    if (matches.length >= input.limit * 3) {
      break;
    }
  }

  return matches
    .sort((left, right) => right.score - left.score)
    .slice(0, input.limit);
};

class ContextSearchBrokerService {
  private normalizeSources(input?: ContextSearchBrokerSources): Record<ContextSearchBrokerSourceKey, boolean> {
    return {
      personalHistory: input?.personalHistory ?? true,
      files: input?.files ?? true,
      larkContacts: input?.larkContacts ?? true,
      zohoCrmContext: input?.zohoCrmContext ?? true,
      zohoBooksLive: input?.zohoBooksLive ?? false,
      workspace: input?.workspace ?? false,
      web: input?.web ?? false,
      skills: input?.skills ?? false,
    };
  }

  private toCitations(results: ContextSearchBrokerResult[]): Array<Record<string, unknown>> {
    return results.map((result, index) => ({
      index: index + 1,
      chunkRef: result.chunkRef,
      scope: result.scope,
      sourceType: result.sourceType,
      sourceId: result.sourceId,
      sourceLabel: result.sourceLabel,
      asOf: result.asOf,
      excerpt: result.excerpt,
      score: result.score,
      ...(result.url ? { url: result.url } : {}),
      ...(result.fileName ? { fileName: result.fileName } : {}),
      ...(result.title ? { title: result.title } : {}),
    }));
  }

  private toVercelCitations(results: ContextSearchBrokerResult[]): VercelCitation[] {
    return results.map((result, index) => ({
      id: `${result.scope}-${index + 1}`,
      title: result.title ?? result.sourceLabel,
      url: result.url,
      kind: result.scope,
      sourceType: result.sourceType,
      sourceId: result.sourceId,
      ...(result.scope === 'files' ? { fileAssetId: result.sourceId } : {}),
      chunkIndex: result.chunkIndex,
    }));
  }

  async search(input: ContextSearchBrokerSearchInput): Promise<ContextSearchBrokerSearchOutput> {
  const query = input.query.trim();
  const limit = Math.max(1, Math.min(input.limit ?? 5, 10));
  const sources = this.normalizeSources(input.sources);
  const companyEntityLookup = isCompanyEntityLookupQuery(query);
  if (companyEntityLookup) {
    sources.larkContacts = false;
  }
  const searchStrategy = inferSearchScaleStrategy({
    query,
    explicitSourcesProvided: Boolean(input.sources),
      site: input.site,
    });
    applySearchScaleStrategy(sources, searchStrategy, Boolean(input.runtime.workspace?.path));
    const dateFrom = parseDate(input.dateFrom, 'start');
    const dateTo = parseDate(input.dateTo, 'end');
    const sourceCoverage = Object.fromEntries(
      (Object.keys(sources) as ContextSearchBrokerSourceKey[]).map((key) => [key, {
        enabled: sources[key],
        status: sources[key] ? 'queried' : 'disabled',
        resultCount: 0,
      }]),
    ) as Record<ContextSearchBrokerSourceKey, SourceCoverage>;
    const escalationStages: string[] = searchStrategy === 'broad_first' ? ['broad_first'] : [];

    const results: ContextSearchBrokerResult[] = [];

    const runSource = async (
      key: ContextSearchBrokerSourceKey,
      fn: () => Promise<ContextSearchBrokerResult[]>,
    ) => {
      if (!sources[key]) return;
      try {
        const hits = await fn();
        sourceCoverage[key].resultCount = hits.length;
        if (hits.length === 0 && key === 'workspace' && !input.runtime.workspace?.path) {
          sourceCoverage[key].status = 'unavailable';
          return;
        }
        results.push(...hits);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sourceCoverage[key].status = 'error';
        sourceCoverage[key].error = message;
        logger.warn('context.search.broker.source_failed', {
          companyId: input.runtime.companyId,
          channel: input.runtime.channel,
          source: key,
          error: message,
        });
      }
    };

    const enableSource = (key: ContextSearchBrokerSourceKey, stageLabel: string): boolean => {
      if (sources[key]) {
        return false;
      }
      sources[key] = true;
      sourceCoverage[key].enabled = true;
      sourceCoverage[key].status = 'queried';
      sourceCoverage[key].resultCount = 0;
      delete sourceCoverage[key].error;
      if (!escalationStages.includes(stageLabel)) {
        escalationStages.push(stageLabel);
      }
      return true;
    };

    await Promise.all([
      runSource('personalHistory', async () => {
        const matches = await personalVectorMemoryService.query({
          companyId: input.runtime.companyId,
          requesterUserId: input.runtime.userId,
          text: query,
          limit,
        });
        const normalized = await Promise.all(matches.map(async (match) => {
          const chunk = await vectorDocumentRepository.findChunkByText({
            companyId: input.runtime.companyId,
            sourceType: 'chat_turn',
            sourceId: match.sourceId,
            chunkText: match.content,
          });
          if (!chunk) return null;
          const asOf = chunk.sourceUpdatedAt?.toISOString?.() ?? chunk.createdAt?.toISOString?.() ?? undefined;
          if (!dateMatches(asOf, dateFrom, dateTo)) return null;
          return {
            scope: 'personal_history',
            sourceType: 'chat_turn',
            sourceId: match.sourceId,
            chunkIndex: chunk.chunkIndex,
            score: match.score,
            excerpt: normalizeText(match.content),
            chunkRef: buildChunkRef('personal_history', 'chat_turn', match.sourceId, chunk.chunkIndex),
            sourceLabel: buildSourceLabel({
              scope: 'personal_history',
              title: match.role ? `${match.role} turn` : 'conversation turn',
              sourceType: 'chat_turn',
              asOf,
            }),
            asOf,
            title: match.role ? `${match.role} turn` : 'conversation turn',
          } satisfies ContextSearchBrokerResult;
        }));
        return normalized.filter((entry): entry is ContextSearchBrokerResult => Boolean(entry));
      }),
      runSource('files', async () => {
        const search = await fileRetrievalService.search({
          companyId: input.runtime.companyId,
          query,
          limit,
          requesterAiRole: input.runtime.requesterAiRole,
          preferParentContext: true,
        });
        return search.matches.flatMap((match) => {
          const asOf = undefined;
          if (!match.sourceId || match.chunkIndex === undefined) return [];
          return [{
            scope: 'files',
            sourceType: 'file_document',
            sourceId: match.sourceId,
            chunkIndex: match.chunkIndex,
            score: match.score ?? 0,
            excerpt: normalizeText(match.displayText || match.text),
            chunkRef: buildChunkRef('files', 'file_document', match.sourceId, match.chunkIndex),
            sourceLabel: buildSourceLabel({
              scope: 'files',
              fileName: match.fileName,
              sourceType: 'file_document',
              asOf,
            }),
            asOf,
            fileName: match.fileName,
            title: match.fileName,
          }];
        }).slice(0, limit);
      }),
      runSource('larkContacts', async () => {
        const people = await channelIdentityRepository.searchLarkContacts({
          companyId: input.runtime.companyId,
          query,
          limit,
        });
        return people.map((person, index) => {
          const sourceId = readString(person.larkOpenId)
            ?? readString(person.externalUserId)
            ?? readString(person.larkUserId)
            ?? '';
          const excerpt = normalizeText([
            person.displayName,
            person.email,
            person.larkOpenId ?? person.externalUserId ?? person.larkUserId,
          ].filter(Boolean).join('\n'));
          const asOf = person.updatedAt?.toISOString?.() ?? person.createdAt?.toISOString?.() ?? undefined;
          return {
            scope: 'lark_contacts',
            sourceType: 'lark_contact',
            sourceId,
            chunkIndex: 0,
            score: Math.max(0.95 - index * 0.05, 0.55),
            excerpt,
            chunkRef: buildChunkRef('lark_contacts', 'lark_contact', sourceId, 0),
            sourceLabel: buildSourceLabel({
              scope: 'lark_contacts',
              displayName: readString(person.displayName),
              sourceType: 'lark_contact',
              asOf,
            }),
            asOf,
            displayName: readString(person.displayName),
            email: readString(person.email),
            title: readString(person.displayName) ?? readString(person.email),
          } satisfies ContextSearchBrokerResult;
        }).filter((entry) => Boolean(entry.sourceId));
      }),
      runSource('zohoCrmContext', async () => {
        const matches = await zohoRetrievalService.query({
          companyId: input.runtime.companyId,
          requesterUserId: input.runtime.userId,
          requesterEmail: input.runtime.requesterEmail,
          text: query,
          limit,
        });
        return matches.flatMap((match) => {
          const chunkText = readString(match.payload._chunk) ?? readString(match.payload.text);
          if (!chunkText) return [];
          const asOf = readString(match.payload.sourceUpdatedAt) ?? readString(match.payload.updatedAt) ?? readString(match.payload.createdAt);
          if (!dateMatches(asOf, dateFrom, dateTo)) return [];
          return [{
            scope: 'zoho_crm',
            sourceType: match.sourceType,
            sourceId: match.sourceId,
            chunkIndex: match.chunkIndex,
            score: match.score,
            excerpt: normalizeText(chunkText),
            chunkRef: buildChunkRef('zoho_crm', match.sourceType, match.sourceId, match.chunkIndex),
            sourceLabel: buildSourceLabel({
              scope: 'zoho_crm',
              title: readString(match.payload.citationTitle) ?? readString(match.payload.title),
              sourceType: match.sourceType,
              asOf,
            }),
            asOf,
            title: readString(match.payload.citationTitle) ?? readString(match.payload.title),
          }];
        });
      }),
      runSource('zohoBooksLive', async () => searchZohoBooksLive({
        runtime: input.runtime,
        query,
        limit,
      })),
      runSource('workspace', async () => searchWorkspace({
        runtime: input.runtime,
        query,
        limit,
      })),
      runSource('web', async () => {
        const result = await webSearchService.search({
          query,
          exactDomain: input.site?.trim() || undefined,
          searchResultsLimit: limit,
          pageContextLimit: Math.min(input.webMode === 'fetchPageContext' ? 4 : 2, limit),
          ...(input.webMode === 'fetchPageContext' ? { crawlUrl: query } : {}),
        });
        return result.items.map((item, index) => {
          const encodedUrl = encodeRefSegment(item.link);
          const excerpt = normalizeText(item.pageContext?.excerpt ?? item.snippet ?? '');
          return {
            scope: 'web',
            sourceType: 'web_result',
            sourceId: encodedUrl,
            chunkIndex: 0,
            score: Math.max(1 - index * 0.05, 0.5),
            excerpt,
            chunkRef: buildChunkRef('web', 'web_result', encodedUrl, 0),
            sourceLabel: buildSourceLabel({
              scope: 'web',
              title: item.title,
              sourceType: 'web_result',
              asOf: item.date,
              domain: item.domain,
            }),
            asOf: item.date,
            title: item.title,
            url: item.link,
          } satisfies ContextSearchBrokerResult;
        });
      }),
      runSource('skills', async () => {
        const skills = await skillService.searchVisibleSkills({
          companyId: input.runtime.companyId,
          departmentId: input.runtime.departmentId,
          query,
          limit,
        });
        return skills.map((skill, index) => ({
          scope: 'skills',
          sourceType: 'skill',
          sourceId: skill.id || skill.slug,
          chunkIndex: 0,
          score: Math.max(1 - index * 0.05, 0.5),
          excerpt: normalizeText(skill.summary || skill.name || skill.slug || skill.id),
          chunkRef: buildChunkRef('skills', 'skill', skill.id || skill.slug, 0),
          sourceLabel: buildSourceLabel({
            scope: 'skills',
            title: skill.name,
            sourceType: 'skill',
          }),
          title: skill.name,
          skillId: skill.id,
          skillSlug: skill.slug,
        }));
      }),
    ]);

    let topResults = rankContextSearchResults(results, { query, limit });

    if (topResults.length === 0) {
      const enabledBroaderInternal =
        enableSource('zohoBooksLive', 'broader_internal_live')
        || enableSource('zohoCrmContext', 'broader_internal_live');

      if (enabledBroaderInternal) {
        await Promise.all([
          runSource('zohoCrmContext', async () => {
            const matches = await zohoRetrievalService.query({
              companyId: input.runtime.companyId,
              requesterUserId: input.runtime.userId,
              requesterEmail: input.runtime.requesterEmail,
              text: query,
              limit,
            });
            return matches.flatMap((match) => {
              const chunkText = readString(match.payload._chunk) ?? readString(match.payload.text);
              if (!chunkText) return [];
              const asOf = readString(match.payload.sourceUpdatedAt) ?? readString(match.payload.updatedAt) ?? readString(match.payload.createdAt);
              if (!dateMatches(asOf, dateFrom, dateTo)) return [];
              return [{
                scope: 'zoho_crm',
                sourceType: match.sourceType,
                sourceId: match.sourceId,
                chunkIndex: match.chunkIndex,
                score: match.score,
                excerpt: normalizeText(chunkText),
                chunkRef: buildChunkRef('zoho_crm', match.sourceType, match.sourceId, match.chunkIndex),
                sourceLabel: buildSourceLabel({
                  scope: 'zoho_crm',
                  title: readString(match.payload.citationTitle) ?? readString(match.payload.title),
                  sourceType: match.sourceType,
                  asOf,
                }),
                asOf,
                title: readString(match.payload.citationTitle) ?? readString(match.payload.title),
              }];
            });
          }),
          runSource('zohoBooksLive', async () => searchZohoBooksLive({
            runtime: input.runtime,
            query,
            limit,
          })),
        ]);

        topResults = rankContextSearchResults(results, { query, limit });
      }
    }

    if (topResults.length === 0 && enableSource('web', 'web_last')) {
      await runSource('web', async () => {
        const result = await webSearchService.search({
          query,
          exactDomain: input.site?.trim() || undefined,
          searchResultsLimit: limit,
          pageContextLimit: Math.min(input.webMode === 'fetchPageContext' ? 4 : 2, limit),
          ...(input.webMode === 'fetchPageContext' ? { crawlUrl: query } : {}),
        });
        return result.items.map((item, index) => {
          const encodedUrl = encodeRefSegment(item.link);
          const excerpt = normalizeText(item.pageContext?.excerpt ?? item.snippet ?? '');
          return {
            scope: 'web',
            sourceType: 'web_result',
            sourceId: encodedUrl,
            chunkIndex: 0,
            score: Math.max(1 - index * 0.05, 0.5),
            excerpt,
            chunkRef: buildChunkRef('web', 'web_result', encodedUrl, 0),
            sourceLabel: buildSourceLabel({
              scope: 'web',
              title: item.title,
              sourceType: 'web_result',
              asOf: item.date,
              domain: item.domain,
            }),
            asOf: item.date,
            title: item.title,
            url: item.link,
          } satisfies ContextSearchBrokerResult;
        });
      });

      topResults = rankContextSearchResults(results, { query, limit });
    }

    const resolvedEntities = buildResolvedEntities(topResults);
    const citations = this.toCitations(topResults);

    return {
      results: topResults,
      matches: topResults,
      resolvedEntities,
      sourceCoverage,
      citations,
      nextFetchRefs: topResults.map((result) => result.chunkRef),
      searchSummary:
        topResults.length > 0
          ? `Found ${topResults.length} result${topResults.length === 1 ? '' : 's'} across ${Object.values(sourceCoverage).filter((entry) => entry.enabled && entry.resultCount > 0).length} source${Object.values(sourceCoverage).filter((entry) => entry.enabled && entry.resultCount > 0).length === 1 ? '' : 's'}${escalationStages.length > 0 ? ` after ${escalationStages.join(' -> ')}.` : '.'}`
          : `No relevant context was found for "${query}".`,
    };
  }

  async fetch(input: ContextSearchBrokerFetchInput): Promise<ContextSearchBrokerFetchOutput | null> {
    const parsed = parseChunkRef(input.chunkRef);
    if (!parsed) return null;

    if (parsed.scope === 'files') {
      const context = await fileRetrievalService.readChunkContext({
        companyId: input.runtime.companyId,
        fileAssetId: parsed.sourceId,
        chunkIndex: parsed.chunkIndex,
      });
      if (!context.text.trim()) return null;
      return {
        chunkRef: input.chunkRef,
        scope: parsed.scope,
        sourceType: parsed.sourceType,
        sourceId: parsed.sourceId,
        chunkIndex: parsed.chunkIndex,
        text: context.text,
        resolvedEntities: {
          fileAssetId: parsed.sourceId,
        },
      };
    }

    if (parsed.scope === 'lark_contacts') {
      const people = await channelIdentityRepository.searchLarkContacts({
        companyId: input.runtime.companyId,
        query: parsed.sourceId,
        limit: 10,
      });
      const person = people.find((entry) =>
        [readString(entry.larkOpenId), readString(entry.externalUserId), readString(entry.larkUserId)]
          .filter((value): value is string => Boolean(value))
          .includes(parsed.sourceId),
      );
      if (!person) return null;
      const text = normalizeText([
        person.displayName,
        person.email,
        person.larkOpenId ?? person.externalUserId ?? person.larkUserId,
      ].filter(Boolean).join('\n'));
      return {
        chunkRef: input.chunkRef,
        scope: parsed.scope,
        sourceType: parsed.sourceType,
        sourceId: parsed.sourceId,
        chunkIndex: parsed.chunkIndex,
        text,
        resolvedEntities: {
          ...(readString(person.email) ? { recipientEmail: readString(person.email)! } : {}),
          ...(readString(person.displayName) ? { recipientName: readString(person.displayName)! } : {}),
          recipientOpenId: parsed.sourceId,
        },
      };
    }

    if (parsed.scope === 'web') {
      const url = decodeRefSegment(parsed.sourceId);
      const result = await webSearchService.search({
        query: url,
        crawlUrl: url,
        searchResultsLimit: 1,
        pageContextLimit: 1,
      });
      const item = result.items[0];
      const text = item?.pageContext?.excerpt ?? item?.snippet ?? '';
      if (!text.trim()) return null;
      return {
        chunkRef: input.chunkRef,
        scope: parsed.scope,
        sourceType: parsed.sourceType,
        sourceId: parsed.sourceId,
        chunkIndex: parsed.chunkIndex,
        text,
        resolvedEntities: {
          webUrl: url,
          ...(item?.title ? { webTitle: item.title } : {}),
        },
      };
    }

    if (parsed.scope === 'zoho_books') {
      const decoded = decodeRefSegment(parsed.sourceId);
      const [organizationId, contactId] = decoded.split(':');
      if (!contactId) return null;
      const auth = await zohoGatewayService.getAuthorizedRecord({
        domain: 'books',
        module: 'contacts',
        recordId: contactId,
        organizationId: organizationId || undefined,
        requester: buildZohoGatewayRequester(input.runtime),
      });
      if (auth.allowed !== true) return null;
      const record = asRecord(auth.payload) ?? {};
      const text = normalizeText(JSON.stringify(record, null, 2));
      if (!text.trim()) return null;
      return {
        chunkRef: input.chunkRef,
        scope: parsed.scope,
        sourceType: parsed.sourceType,
        sourceId: contactId,
        chunkIndex: parsed.chunkIndex,
        text,
        resolvedEntities: {
          contactId,
          ...(auth.organizationId ? { organizationId: auth.organizationId } : {}),
          ...(readString(record.contact_name) ? { customerName: readString(record.contact_name)! } : {}),
          ...(readString(record.email) ? { customerEmail: readString(record.email)! } : {}),
        },
      };
    }

    if (parsed.scope === 'skills') {
      const skill = await skillService.readVisibleSkill({
        companyId: input.runtime.companyId,
        departmentId: input.runtime.departmentId,
        skillId: parsed.sourceId,
        skillSlug: parsed.sourceId,
      });
      if (!skill) return null;
      return {
        chunkRef: input.chunkRef,
        scope: parsed.scope,
        sourceType: parsed.sourceType,
        sourceId: parsed.sourceId,
        chunkIndex: parsed.chunkIndex,
        text: skill.markdown,
        resolvedEntities: {
          skillId: skill.id,
          skillSlug: skill.slug,
        },
      };
    }

    if (parsed.scope === 'workspace') {
      const workspacePath = input.runtime.workspace?.path?.trim();
      if (!workspacePath) return null;
      const relativePath = decodeRefSegment(parsed.sourceId);
      const fullPath = path.join(workspacePath, relativePath);
      const text = await fs.readFile(fullPath, 'utf8');
      return {
        chunkRef: input.chunkRef,
        scope: parsed.scope,
        sourceType: parsed.sourceType,
        sourceId: parsed.sourceId,
        chunkIndex: parsed.chunkIndex,
        text,
        resolvedEntities: {
          workspacePath: relativePath,
        },
      };
    }

    const fetched = await vectorDocumentRepository.fetchChunkByKey({
      companyId: input.runtime.companyId,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
      chunkIndex: parsed.chunkIndex,
    });
    const text = fetched.text?.trim();
    if (!text) return null;
    return {
      chunkRef: input.chunkRef,
      scope: parsed.scope,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
      chunkIndex: parsed.chunkIndex,
      text,
      resolvedEntities: {},
    };
  }

  toVercelCitationsFromSearch(output: ContextSearchBrokerSearchOutput): VercelCitation[] {
    return this.toVercelCitations(output.results);
  }
}

export const contextSearchBrokerService = new ContextSearchBrokerService();
