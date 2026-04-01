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
import { getCachedSearchIntent, type SearchIntent } from '../orchestration/search-intent-classifier';

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
  | 'searchIntent'
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
  customerId?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  skillId?: string;
  skillSlug?: string;
  authorityLevel?: 'authoritative' | 'documentary' | 'contextual' | 'public';
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
const normalizeEntityToken = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

const STRUCTURED_INTERNAL_CUES = /\b(invoice|invoices|statement|statements|payment|payments|overdue|balance|balances|vendor|vendors|customer|customers|contact|contacts|deal|deals|account|accounts|lead|leads)\b/i;
const AUTHORITATIVE_ENTITY_SCOPES = new Set(['zoho_books', 'zoho_crm', 'files', 'workspace']);
const RESULT_SCOPE_TO_SOURCE_KEY: Record<string, ContextSearchBrokerSourceKey> = {
  personal_history: 'personalHistory',
  files: 'files',
  lark_contacts: 'larkContacts',
  zoho_crm: 'zohoCrmContext',
  zoho_books: 'zohoBooksLive',
  workspace: 'workspace',
  web: 'web',
  skills: 'skills',
};

export function computeSourceWeights(intent: SearchIntent): Record<ContextSearchBrokerSourceKey, number> {
  switch (intent.queryType) {
    case 'company_entity':
      return {
        zohoBooksLive: 2.0,
        zohoCrmContext: 1.8,
        files: 1.1,
        workspace: 1.0,
        web: 0.8,
        personalHistory: 0.0,
        larkContacts: 0.0,
        skills: 0.5,
      };
    case 'person_entity':
      return {
        larkContacts: 2.0,
        zohoCrmContext: 1.6,
        zohoBooksLive: 1.2,
        files: 0.8,
        workspace: 0.8,
        personalHistory: 0.3,
        web: 0.5,
        skills: 0.3,
      };
    case 'financial_record':
      return {
        zohoBooksLive: 2.5,
        zohoCrmContext: 1.0,
        files: 1.0,
        workspace: 0.5,
        larkContacts: 0.0,
        personalHistory: 0.0,
        web: 0.0,
        skills: 0.3,
      };
    case 'document':
      return {
        files: 2.0,
        workspace: 1.8,
        zohoBooksLive: 0.8,
        zohoCrmContext: 0.6,
        larkContacts: 0.0,
        personalHistory: 0.2,
        web: 0.4,
        skills: 0.5,
      };
    case 'conversation':
      return {
        personalHistory: 2.0,
        files: 0.5,
        zohoCrmContext: 0.3,
        zohoBooksLive: 0.3,
        larkContacts: 0.0,
        web: 0.0,
        workspace: 0.3,
        skills: 0.2,
      };
    default:
      return {
        zohoBooksLive: 1.6,
        zohoCrmContext: 1.5,
        files: 1.15,
        workspace: 1.05,
        personalHistory: 0.15,
        larkContacts: 0.75,
        web: 0.75,
        skills: 0.5,
      };
  }
}

const extractEntityTokens = (query: string): string[] =>
  Array.from(new Set(
    normalizeLookupText(query)
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  ));

const computeEntityTextMatchScore = (query: string, values: Array<string | undefined>): number => {
  const normalizedQuery = normalizeLookupText(query);
  const compactQuery = normalizeEntityToken(normalizedQuery);
  const haystacks = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => normalizeLookupText(value));
  if (!compactQuery || haystacks.length === 0) {
    return 0;
  }

  let best = 0;
  const queryTokens = extractEntityTokens(query);
  for (const haystack of haystacks) {
    const compactHaystack = normalizeEntityToken(haystack);
    if (!compactHaystack) {
      continue;
    }
    if (compactHaystack === compactQuery) {
      best = Math.max(best, 1);
      continue;
    }
    if (compactHaystack.includes(compactQuery) || compactQuery.includes(compactHaystack)) {
      best = Math.max(best, 0.92);
    }

    const haystackTokens = new Set(
      haystack.split(/[^a-z0-9]+/g).map((token) => token.trim()).filter((token) => token.length >= 2),
    );
    if (queryTokens.length > 0 && haystackTokens.size > 0) {
      let overlap = 0;
      for (const token of queryTokens) {
        if (haystackTokens.has(token)) {
          overlap += 1;
        }
      }
      best = Math.max(best, overlap / queryTokens.length);
    }
  }

  return best;
};

export const rankContextSearchResults = (
  results: ContextSearchBrokerResult[],
  input: {
    query: string;
    limit: number;
    companyLookup?: boolean;
    weights: Record<ContextSearchBrokerSourceKey, number>;
  },
): ContextSearchBrokerResult[] => {
  const companyLookup = input.companyLookup ?? false;
  const filtered = results.filter((result) => {
    const sourceKey = RESULT_SCOPE_TO_SOURCE_KEY[result.scope];
    if (sourceKey && input.weights[sourceKey] <= 0) {
      return false;
    }
    if (!companyLookup) {
      return true;
    }
    if (result.scope === 'personal_history' && result.sourceType === 'chat_turn') {
      return false;
    }
    if (result.scope === 'lark_contacts') {
      return false;
    }
    if (result.scope === 'files') {
      const fileMatchScore = computeEntityTextMatchScore(input.query, [
        result.title,
        result.fileName,
        result.excerpt,
      ]);
      return fileMatchScore >= 0.45;
    }
    return true;
  });
  const hasAuthoritativeEntityHit = filtered.some((result) => AUTHORITATIVE_ENTITY_SCOPES.has(result.scope));
  const ranked = filtered
    .map((result, index) => {
      const sourceKey = RESULT_SCOPE_TO_SOURCE_KEY[result.scope];
      const priority = sourceKey ? input.weights[sourceKey] : 1;
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

export function selectInitialSources(
  intent: SearchIntent,
  weights: Record<ContextSearchBrokerSourceKey, number>,
  sources: Record<ContextSearchBrokerSourceKey, boolean>,
) {
  for (const key of Object.keys(sources) as ContextSearchBrokerSourceKey[]) {
    sources[key] = false;
  }

  if (intent.sourceHint) {
    const hintMap: Record<NonNullable<SearchIntent['sourceHint']>, ContextSearchBrokerSourceKey> = {
      books: 'zohoBooksLive',
      crm: 'zohoCrmContext',
      files: 'files',
      web: 'web',
      history: 'personalHistory',
      lark: 'larkContacts',
    };
    const key = hintMap[intent.sourceHint];
    if (key && weights[key] > 0) {
      sources[key] = true;
    }
    return;
  }

  if (intent.queryType === 'company_entity') {
    if (weights.zohoBooksLive > 0) {
      sources.zohoBooksLive = true;
    }
    return;
  }

  if (intent.queryType === 'person_entity') {
    if (intent.lookupTarget === 'contact_info') {
      if (weights.larkContacts > 0) {
        sources.larkContacts = true;
      }
      return;
    }
    if (weights.larkContacts > 0) {
      sources.larkContacts = true;
    }
    if (weights.zohoBooksLive > 0) {
      sources.zohoBooksLive = true;
    }
    return;
  }

  if (intent.queryType === 'financial_record') {
    if (weights.zohoBooksLive > 0) {
      sources.zohoBooksLive = true;
    }
    return;
  }

  if (intent.queryType === 'document') {
    if (weights.files > 0) {
      sources.files = true;
    }
    if (weights.workspace > 0) {
      sources.workspace = true;
    }
    return;
  }

  if (intent.queryType === 'conversation') {
    if (weights.personalHistory > 0) {
      sources.personalHistory = true;
    }
    return;
  }

  for (const [key, weight] of Object.entries(weights) as Array<[ContextSearchBrokerSourceKey, number]>) {
    if (weight > 0 && key !== 'web') {
      sources[key] = true;
    }
  }
}

export function computeInternalLimit(intent: SearchIntent, requestedLimit: number): number {
  const minimums: Record<SearchIntent['queryType'], number> = {
    company_entity: 20,
    financial_record: 50,
    person_entity: 15,
    document: 15,
    conversation: 10,
    general: 10,
  };
  return Math.max(requestedLimit, minimums[intent.queryType] ?? 10);
}

export function isEntityConsistentResult(
  result: ContextSearchBrokerResult,
  intent: SearchIntent,
): boolean {
  if (result.score <= 0) {
    return false;
  }

  const text = `${result.title ?? ''} ${result.excerpt ?? ''}`.toLowerCase();

  if (intent.queryType === 'company_entity' && intent.extractedEntity) {
    const tokens = intent.extractedEntity
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 2);
    const matchCount = tokens.filter((token) => text.includes(token)).length;
    return matchCount >= Math.min(2, tokens.length);
  }

  if (intent.queryType === 'financial_record') {
    return result.scope === 'zoho_books';
  }

  if (intent.queryType === 'person_entity' && intent.extractedEntity) {
    const firstName = intent.extractedEntity.toLowerCase().split(/\s+/)[0];
    return text.includes(firstName);
  }

  return result.score >= 0.65;
}

export function getAuthorityLevel(scope: string): 'authoritative' | 'documentary' | 'contextual' | 'public' {
  if (scope === 'zoho_books' || scope === 'zoho_crm') return 'authoritative';
  if (scope === 'files' || scope === 'workspace') return 'documentary';
  if (scope === 'personal_history' || scope === 'lark_contacts') return 'contextual';
  if (scope === 'web') return 'public';
  return 'contextual';
}

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
      setResolvedEntity(resolved, 'organizationId', result.organizationId);
      setResolvedEntity(resolved, 'customerName', result.displayName ?? result.title);
      setResolvedEntity(resolved, 'customerEmail', result.email);
      if (result.sourceType === 'books_contact') {
        setResolvedEntity(resolved, 'contactId', result.sourceId);
        setResolvedEntity(resolved, 'customerId', result.customerId ?? result.sourceId);
      }
      if (result.sourceType === 'books_invoice') {
        setResolvedEntity(resolved, 'invoiceId', result.invoiceId ?? result.sourceId);
        setResolvedEntity(resolved, 'invoiceNumber', result.invoiceNumber);
        setResolvedEntity(resolved, 'customerId', result.customerId);
      }
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
  const matchScore = computeEntityTextMatchScore(query, [
    readString(record.contact_name),
    readString(record.customer_name),
    readString(record.company_name),
    readString(record.email),
    readString(record.website),
    JSON.stringify(record),
  ]);
  const decay = Math.min(index * 0.01, 0.18);
  return Math.max(matchScore - decay, matchScore > 0 ? 0.3 : 0);
};

const scoreZohoBooksInvoiceMatch = (record: Record<string, unknown>, query: string, index: number): number => {
  const matchScore = computeEntityTextMatchScore(query, [
    readString(record.customer_name),
    readString(record.contact_name),
    readString(record.company_name),
    readString(record.invoice_number),
    readString(record.reference_number),
    readString(record.email),
    JSON.stringify(record),
  ]);
  const decay = Math.min(index * 0.01, 0.18);
  return Math.max(matchScore - decay, matchScore > 0 ? 0.3 : 0);
};

const searchZohoBooksLive = async (input: {
  runtime: ContextSearchBrokerRuntime;
  query: string;
  limit: number;
  companyLookup?: boolean;
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
  const companyLookup = input.companyLookup ?? false;

  const pushCandidate = (record: Record<string, unknown>, resolvedOrganizationId: string | undefined, rankIndex: number) => {
    const contactId = readString(record.contact_id) ?? readString(record.id);
    if (!contactId) return;
    const key = `${resolvedOrganizationId ?? ''}:${contactId}`;
    if (seen.has(key)) return;
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
    const score = scoreZohoBooksContactMatch(record, input.query, rankIndex);
    if (companyLookup && score < 0.45) {
      return;
    }
    seen.add(key);
    const asOf = readString(record.last_modified_time) ?? readString(record.created_time);
    matches.push({
      scope: 'zoho_books',
      sourceType: 'books_contact',
      sourceId: contactId,
      chunkIndex: 0,
      score,
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
      customerId: readString(record.customer_id) ?? contactId,
      title: displayName,
    });
  };

  const pushInvoiceCandidate = (record: Record<string, unknown>, resolvedOrganizationId: string | undefined, rankIndex: number) => {
    const invoiceId = readString(record.invoice_id) ?? readString(record.id);
    if (!invoiceId) return;
    const key = `${resolvedOrganizationId ?? ''}:invoice:${invoiceId}`;
    if (seen.has(key)) return;
    const customerName =
      readString(record.customer_name)
      ?? readString(record.contact_name)
      ?? readString(record.company_name);
    const invoiceNumber = readString(record.invoice_number) ?? invoiceId;
    const customerId = readString(record.customer_id) ?? readString(record.contact_id);
    const score = scoreZohoBooksInvoiceMatch(record, input.query, rankIndex);
    if (companyLookup && score < 0.45) {
      return;
    }
    seen.add(key);
    const asOf =
      readString(record.last_modified_time)
      ?? readString(record.updated_time)
      ?? readString(record.created_time)
      ?? readString(record.date);
    matches.push({
      scope: 'zoho_books',
      sourceType: 'books_invoice',
      sourceId: invoiceId,
      chunkIndex: 0,
      score,
      excerpt: normalizeText([
        customerName,
        invoiceNumber,
        readString(record.status),
        readString(record.amount_due),
        readString(record.balance),
        readString(record.due_date),
        readString(resolvedOrganizationId),
      ].filter(Boolean).join('\n')),
      chunkRef: buildChunkRef('zoho_books', 'books_invoice', encodeRefSegment(`${resolvedOrganizationId}:${invoiceId}`), 0),
      sourceLabel: buildSourceLabel({
        scope: 'zoho_books',
        title: customerName ?? invoiceNumber,
        sourceType: 'books_invoice',
        asOf,
      }),
      asOf,
      displayName: customerName,
      email: readString(record.email),
      organizationId: resolvedOrganizationId,
      customerId,
      invoiceId,
      invoiceNumber,
      title: customerName ? `${customerName} (${invoiceNumber})` : invoiceNumber,
    });
  };

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
          const resolvedOrganizationId = auth.organizationId ?? organizationId;
          pushCandidate(record, resolvedOrganizationId, ((page - 1) * perPage) + index);
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

  if (matches.length === 0 && companyLookup) {
    const scanPageLimit = 5;
    const scanPerPage = 200;
    for (const organizationId of organizationIds) {
      for (let page = 1; page <= scanPageLimit; page += 1) {
        const auth = await zohoGatewayService.listAuthorizedRecords({
          domain: 'books',
          module: 'contacts',
          requester,
          organizationId: organizationId || undefined,
          limit: scanPerPage,
          page,
          perPage: scanPerPage,
        });
        if (auth.allowed !== true) {
          break;
        }
        const payload = asRecord(auth.payload) ?? {};
        const records = Array.isArray(payload.records)
          ? payload.records.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry))
          : [];
        for (const [index, record] of records.entries()) {
          pushCandidate(record, auth.organizationId ?? organizationId, ((page - 1) * scanPerPage) + index);
        }
        if (matches.length >= input.limit * 3 || records.length < scanPerPage) {
          break;
        }
      }
      if (matches.length >= input.limit * 3) {
        break;
      }
    }
  }

  if (matches.length < input.limit * 2) {
    const invoicePerPage = 200;
    const invoicePageLimit = companyLookup ? 8 : 3;
    for (const organizationId of organizationIds) {
      for (const queryVariant of queries) {
        for (let page = 1; page <= invoicePageLimit; page += 1) {
          const auth = await zohoGatewayService.listAuthorizedRecords({
            domain: 'books',
            module: 'invoices',
            requester,
            organizationId: organizationId || undefined,
            query: queryVariant,
            limit: invoicePerPage,
            page,
            perPage: invoicePerPage,
          });
          if (auth.allowed !== true) {
            break;
          }
          const payload = asRecord(auth.payload) ?? {};
          const records = Array.isArray(payload.records)
            ? payload.records.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry))
            : [];
          for (const [index, record] of records.entries()) {
            pushInvoiceCandidate(record, auth.organizationId ?? organizationId, ((page - 1) * invoicePerPage) + index);
          }
          if (matches.length >= input.limit * 3 || records.length < invoicePerPage) {
            break;
          }
        }
        if (matches.length >= input.limit * 3) {
          break;
        }
      }
      if (matches.length >= input.limit * 3) {
        break;
      }
    }
  }

  if (matches.length === 0 && companyLookup) {
    const invoiceScanPerPage = 200;
    const invoiceScanPageLimit = 6;
    for (const organizationId of organizationIds) {
      for (let page = 1; page <= invoiceScanPageLimit; page += 1) {
        const auth = await zohoGatewayService.listAuthorizedRecords({
          domain: 'books',
          module: 'invoices',
          requester,
          organizationId: organizationId || undefined,
          limit: invoiceScanPerPage,
          page,
          perPage: invoiceScanPerPage,
        });
        if (auth.allowed !== true) {
          break;
        }
        const payload = asRecord(auth.payload) ?? {};
        const records = Array.isArray(payload.records)
          ? payload.records.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => Boolean(entry))
          : [];
        for (const [index, record] of records.entries()) {
          pushInvoiceCandidate(record, auth.organizationId ?? organizationId, ((page - 1) * invoiceScanPerPage) + index);
        }
        if (matches.length >= input.limit * 3 || records.length < invoiceScanPerPage) {
          break;
        }
      }
      if (matches.length >= input.limit * 3) {
        break;
      }
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
    const requestedLimit = Math.max(1, Math.min(input.limit ?? 5, 10));
    const sources = this.normalizeSources(input.sources);
    const searchIntent = await getCachedSearchIntent({
      runtime: input.runtime,
      message: query,
    });
    const companyEntityLookup = searchIntent.queryType === 'company_entity';
    const weights = computeSourceWeights(searchIntent);
    const internalLimit = computeInternalLimit(searchIntent, requestedLimit);
    if (!input.sources) {
      selectInitialSources(searchIntent, weights, sources);
    } else {
      for (const key of Object.keys(sources) as ContextSearchBrokerSourceKey[]) {
        if (weights[key] <= 0) {
          sources[key] = false;
        }
      }
    }
    const dateFrom = parseDate(input.dateFrom, 'start');
    const dateTo = parseDate(input.dateTo, 'end');
    const sourceCoverage = Object.fromEntries(
      (Object.keys(sources) as ContextSearchBrokerSourceKey[]).map((key) => [key, {
        enabled: sources[key],
        status: sources[key] ? 'queried' : 'disabled',
        resultCount: 0,
      }]),
    ) as Record<ContextSearchBrokerSourceKey, SourceCoverage>;
    const escalationStages: string[] = [];

    const results: ContextSearchBrokerResult[] = [];

    const sourceRunners: Record<ContextSearchBrokerSourceKey, () => Promise<ContextSearchBrokerResult[]>> = {
      personalHistory: async () => {
        const matches = await personalVectorMemoryService.query({
          companyId: input.runtime.companyId,
          requesterUserId: input.runtime.userId,
          text: query,
          limit: internalLimit,
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
      },
      files: async () => {
        const search = await fileRetrievalService.search({
          companyId: input.runtime.companyId,
          query,
          limit: internalLimit,
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
        }).slice(0, internalLimit);
      },
      larkContacts: async () => {
        const people = await channelIdentityRepository.searchLarkContacts({
          companyId: input.runtime.companyId,
          query,
          limit: internalLimit,
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
      },
      zohoCrmContext: async () => {
        const matches = await zohoRetrievalService.query({
          companyId: input.runtime.companyId,
          requesterUserId: input.runtime.userId,
          requesterEmail: input.runtime.requesterEmail,
          text: query,
          limit: internalLimit,
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
      },
      zohoBooksLive: async () => searchZohoBooksLive({
        runtime: input.runtime,
        query,
        limit: internalLimit,
        companyLookup: companyEntityLookup,
      }),
      workspace: async () => searchWorkspace({
        runtime: input.runtime,
        query,
        limit: internalLimit,
      }),
      web: async () => {
        const result = await webSearchService.search({
          query,
          exactDomain: input.site?.trim() || undefined,
          searchResultsLimit: internalLimit,
          pageContextLimit: Math.min(input.webMode === 'fetchPageContext' ? 4 : 2, internalLimit),
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
      },
      skills: async () => {
        const skills = await skillService.searchVisibleSkills({
          companyId: input.runtime.companyId,
          departmentId: input.runtime.departmentId,
          query,
          limit: internalLimit,
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
      },
    };

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

    const runNewlyEnabledSources = async (keys: ContextSearchBrokerSourceKey[]) => {
      await Promise.all(keys.map((key) => runSource(key, sourceRunners[key])));
    };

    const rerankResults = () => rankContextSearchResults(results, {
      query,
      limit: internalLimit,
      companyLookup: companyEntityLookup,
      weights,
    });

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

    await runNewlyEnabledSources(
      (Object.keys(sources) as ContextSearchBrokerSourceKey[]).filter((key) => sources[key]),
    );

    let topResults = rerankResults();
    let consistentResults = topResults.filter((result) => isEntityConsistentResult(result, searchIntent));

    if (consistentResults.length === 0) {
      const round2Sources = ([
        'zohoBooksLive',
        'zohoCrmContext',
        'files',
        'workspace',
        'personalHistory',
        'larkContacts',
      ] as ContextSearchBrokerSourceKey[]).filter((key) => {
        const weight = weights[key];
        return weight > 0 && !sourceCoverage[key].enabled;
      });

      if (round2Sources.length > 0) {
        for (const key of round2Sources) {
          enableSource(key, 'broader_internal');
        }
        await runNewlyEnabledSources(round2Sources);
        topResults = rerankResults();
        consistentResults = topResults.filter((result) => isEntityConsistentResult(result, searchIntent));
      }
    }

    if (consistentResults.length === 0 && weights.web > 0 && enableSource('web', 'web_last')) {
      await runNewlyEnabledSources(['web']);
      topResults = rerankResults();
      consistentResults = topResults.filter((result) => isEntityConsistentResult(result, searchIntent));
    }

    const finalResults = (consistentResults.length > 0 ? consistentResults : [])
      .slice(0, requestedLimit)
      .map((result) => ({
        ...result,
        authorityLevel: getAuthorityLevel(result.scope),
      }));

    const resolvedEntities = buildResolvedEntities(finalResults);
    const citations = this.toCitations(finalResults);
    const sourcesChecked = Object.entries(sourceCoverage)
      .filter(([, value]) => value.enabled)
      .map(([key]) => key)
      .join(', ');
    const searchSummary = finalResults.length > 0
      ? `Found ${finalResults.length} result(s) matching "${searchIntent.extractedEntity ?? query}" across ${sourcesChecked}.`
      : `No matching records found for "${searchIntent.extractedEntity ?? query}". Checked: ${sourcesChecked}.`;

    return {
      results: finalResults,
      matches: finalResults,
      resolvedEntities,
      sourceCoverage,
      citations,
      nextFetchRefs: finalResults.map((result) => result.chunkRef),
      searchSummary,
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
      const [organizationId, recordId] = decoded.split(':');
      if (!recordId) return null;
      const moduleName = parsed.sourceType === 'books_invoice' ? 'invoices' : 'contacts';
      const auth = await zohoGatewayService.getAuthorizedRecord({
        domain: 'books',
        module: moduleName,
        recordId,
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
        sourceId: recordId,
        chunkIndex: parsed.chunkIndex,
        text,
        resolvedEntities: {
          ...(parsed.sourceType === 'books_contact' ? { contactId: recordId } : {}),
          ...(parsed.sourceType === 'books_invoice' ? { invoiceId: recordId } : {}),
          ...(auth.organizationId ? { organizationId: auth.organizationId } : {}),
          ...(readString(record.customer_id) ? { customerId: readString(record.customer_id)! } : {}),
          ...(readString(record.invoice_number) ? { invoiceNumber: readString(record.invoice_number)! } : {}),
          ...(readString(record.customer_name)
            ? { customerName: readString(record.customer_name)! }
            : readString(record.contact_name)
              ? { customerName: readString(record.contact_name)! }
              : {}),
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
