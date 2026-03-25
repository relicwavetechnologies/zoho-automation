import { ChatGoogle } from '@langchain/google';
import { ChatOpenAI } from '@langchain/openai';

import type { AgentInvokeInputDTO } from '../../contracts';
import { aiModelControlService, type AiControlTargetKey, type AiModelProvider } from '../../ai-models';
import { CompanyContextResolutionError, companyContextResolver, zohoRetrievalService } from '../support';
import { BaseAgent } from '../base';
import type { ZohoSourceType } from '../../integrations/zoho/zoho-provider.adapter';
import { ZohoIntegrationError } from '../../integrations/zoho/zoho.errors';
import { zohoGatewayService } from '../../integrations/zoho/zoho-gateway.service';
import { COMPANY_CONTROL_KEYS, isCompanyControlEnabled } from '../../support/runtime-controls';
import type { ZohoScopeMode } from '../../tools/zoho-role-access.service';
import { logger } from '../../../utils/logger';

const DEFAULT_RESULT_LIMIT = 3;
const MAX_ALL_RESULT_LIMIT = 25;
const SYNTHESIS_MODEL_TARGET = 'mastra.synthesis' as const;
const resolveZohoScopeMode = (scope?: unknown): ZohoScopeMode =>
  scope === 'show_all' ? 'company_scoped' : 'email_scoped';

const hasProviderCredentials = (provider: AiModelProvider): boolean => {
  if (provider === 'google') {
    return Boolean((process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim());
  }
  if (provider === 'groq') {
    return Boolean((process.env.GROQ_API_KEY || '').trim());
  }
  return Boolean((process.env.OPENAI_API_KEY || '').trim());
};

const extractTextContent = (content: unknown): string => {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item && typeof (item as { text?: unknown }).text === 'string') {
          return (item as { text: string }).text;
        }
        return '';
      })
      .join(' ')
      .trim();
  }
  return '';
};

const invokeSynthesisTarget = async (targetKey: AiControlTargetKey, prompt: string): Promise<string | null> => {
  try {
    const resolved = await aiModelControlService.resolveTarget(targetKey);
    if (!hasProviderCredentials(resolved.effectiveProvider)) {
      return null;
    }

    const model =
      resolved.effectiveProvider === 'google'
        ? new ChatGoogle({
          model: resolved.effectiveModelId,
          apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
          thinkingLevel: resolved.effectiveThinkingLevel,
        })
        : new ChatOpenAI({
          model: resolved.effectiveModelId,
          temperature: 0,
          apiKey: resolved.effectiveProvider === 'groq' ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY,
          configuration: resolved.effectiveProvider === 'groq'
            ? { baseURL: 'https://api.groq.com/openai/v1' }
            : undefined,
        });

    const response = await model.invoke(prompt);
    const text = extractTextContent(response.content);
    return text.length > 0 ? text : null;
  } catch (error) {
    logger.warn('zoho.agent.synthesis.invoke_failed', {
      targetKey,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
    return null;
  }
};

type SourceRef = {
  source: 'vector' | 'rest';
  id: string;
};

type LiveRecord = {
  sourceType: ZohoSourceType;
  sourceId: string;
  payload: Record<string, unknown>;
};

type VectorMatch = {
  sourceType: ZohoSourceType;
  sourceId: string;
  chunkIndex: number;
  payload: unknown;
  score: number;
};

type QueryIntent = {
  preferredSourceTypes: ZohoSourceType[];
  createdAfter?: Date;
  targetLimit: number;
  pageSize: number;
  maxPages: number;
  sortBy: 'Created_Time' | 'Modified_Time';
  sortOrder: 'asc' | 'desc';
};

type ModuleFailure = {
  sourceType: ZohoSourceType;
  moduleName: string;
  reasonCode: string;
  reasonMessage: string;
  statusCode?: number;
};

type LiveFetchStatus = 'success' | 'empty' | 'partial' | 'blocked' | 'degraded';

type LiveFetchResult = {
  status: LiveFetchStatus;
  records: LiveRecord[];
  sourceRefs: SourceRef[];
  fallbackUsed: boolean;
  degraded: boolean;
  partial: boolean;
  scopeMode: ZohoScopeMode;
  reasonCode?: string;
  reasonMessage?: string;
  moduleFailures: ModuleFailure[];
};

const normalizeText = (input: string): string => input.toLowerCase().trim();

const containsAny = (text: string, patterns: string[]): boolean =>
  patterns.some((pattern) => text.includes(pattern));

const extractRequestedLimit = (objective: string): number => {
  const text = normalizeText(objective);
  if (containsAny(text, ['all ', 'all my', 'current all', 'show me all', 'list all'])) {
    return MAX_ALL_RESULT_LIMIT;
  }
  const explicit = text.match(/\b(?:top|recent|latest|last|show|list)\b(?:\s+[a-z]+){0,2}\s+(\d{1,2})\b/);
  if (explicit) {
    const parsed = Number.parseInt(explicit[1] ?? '', 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.min(MAX_ALL_RESULT_LIMIT, parsed);
    }
  }
  return DEFAULT_RESULT_LIMIT;
};

const startOfDay = (now: Date): Date =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

const startOfWeek = (now: Date): Date => {
  const start = startOfDay(now);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  return start;
};

const startOfMonth = (now: Date): Date =>
  new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

const subtractDays = (now: Date, days: number): Date => {
  const start = startOfDay(now);
  start.setDate(start.getDate() - days);
  return start;
};

const subtractWeeks = (now: Date, weeks: number): Date => subtractDays(now, weeks * 7);

const subtractMonths = (now: Date, months: number): Date => {
  const start = startOfDay(now);
  start.setMonth(start.getMonth() - months);
  return start;
};

const clampPositiveRange = (value: number, max: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.floor(value)));
};

const inferSourceTypes = (objective: string): ZohoSourceType[] => {
  const text = normalizeText(objective);
  const preferred: ZohoSourceType[] = [];

  if (containsAny(text, [' lead', 'leads', ' prospect', 'prospects'])) preferred.push('zoho_lead');
  if (containsAny(text, [' account', 'accounts', ' company', 'companies', ' organization', 'organizations'])) preferred.push('zoho_account');
  if (containsAny(text, [' deal', 'deals', ' opportunity', 'opportunities'])) preferred.push('zoho_deal');
  if (containsAny(text, [' contact', 'contacts'])) preferred.push('zoho_contact');
  if (containsAny(text, [' ticket', 'tickets', ' case', 'cases', 'support'])) preferred.push('zoho_ticket');

  return preferred.length > 0
    ? [...new Set(preferred)]
    : ['zoho_lead', 'zoho_account', 'zoho_deal', 'zoho_contact', 'zoho_ticket'];
};

const inferCreatedAfter = (objective: string): Date | undefined => {
  const text = normalizeText(objective);
  const now = new Date();
  const dynamicRange =
    text.match(/\b(?:last|past)\s+(\d{1,3})\s+day[s]?\b/) ??
    text.match(/\b(?:last|past)\s+(\d{1,2})\s+week[s]?\b/) ??
    text.match(/\b(?:last|past)\s+(\d{1,2})\s+month[s]?\b/);

  if (dynamicRange) {
    const amount = Number.parseInt(dynamicRange[1] ?? '', 10);
    if (/\bday[s]?\b/.test(dynamicRange[0])) {
      const days = clampPositiveRange(amount, 365);
      if (days > 0) return subtractDays(now, days);
    }
    if (/\bweek[s]?\b/.test(dynamicRange[0])) {
      const weeks = clampPositiveRange(amount, 52);
      if (weeks > 0) return subtractWeeks(now, weeks);
    }
    if (/\bmonth[s]?\b/.test(dynamicRange[0])) {
      const months = clampPositiveRange(amount, 24);
      if (months > 0) return subtractMonths(now, months);
    }
  }

  if (containsAny(text, ['this week', 'current week'])) {
    return startOfWeek(now);
  }
  if (containsAny(text, ['today', 'todays', "today's"])) {
    return startOfDay(now);
  }
  if (containsAny(text, ['this month', 'current month'])) {
    return startOfMonth(now);
  }
  return undefined;
};

const buildQueryIntent = (objective: string): QueryIntent => {
  const targetLimit = extractRequestedLimit(objective);
  const createdAfter = inferCreatedAfter(objective);
  return {
    preferredSourceTypes: inferSourceTypes(objective),
    createdAfter,
    targetLimit,
    pageSize: Math.min(50, Math.max(10, targetLimit * 3)),
    maxPages: createdAfter ? 4 : 2,
    sortBy: createdAfter ? 'Created_Time' : 'Modified_Time',
    sortOrder: 'desc',
  };
};

const toRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const parseTimestamp = (value: unknown): number | null => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const getRecordTimestamp = (record: LiveRecord): number | null =>
  parseTimestamp(record.payload.Created_Time)
  ?? parseTimestamp(record.payload.Modified_Time)
  ?? null;

const matchesTimeFilter = (record: LiveRecord, createdAfter?: Date): boolean => {
  if (!createdAfter) {
    return true;
  }
  const timestamp = getRecordTimestamp(record);
  return timestamp !== null && timestamp >= createdAfter.getTime();
};

const buildLiveSourceRefs = (records: LiveRecord[]): SourceRef[] =>
  records.map((r) => ({ source: 'rest', id: `${r.sourceType}:${r.sourceId}` }));

const buildVectorSourceRefs = (
  matches: Array<{ sourceType: string; sourceId: string; chunkIndex: number }>,
): SourceRef[] =>
  matches.map((m) => ({
    source: 'vector' as const,
    id: `${m.sourceType}:${m.sourceId}#${m.chunkIndex}`,
  }));

const readField = (payload: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
};

const buildPlainTextFallback = (objective: string, liveRecords: LiveRecord[]): string => {
  if (liveRecords.length === 0) {
    return 'The live Zoho API did not return matching records for this query.';
  }

  const limit = extractRequestedLimit(objective);
  const lines = liveRecords.slice(0, limit).map((record, index) => {
    const label =
      readField(record.payload, ['Deal_Name', 'Full_Name', 'Subject', 'Name', 'name', 'Company']) ??
      `${record.sourceType}:${record.sourceId}`;
    const createdAt = readField(record.payload, ['Created_Time', 'Modified_Time']);
    const suffix = createdAt ? ` (${createdAt})` : '';
    return `${index + 1}. [${record.sourceType}] ${label}${suffix}`;
  });

  return `Here are the live Zoho records I found:\n${lines.join('\n')}`;
};

const isListRequest = (objective: string): boolean => {
  const text = normalizeText(objective);
  return containsAny(text, [
    'show me all',
    'list all',
    'all my',
    'all leads',
    'all accounts',
    'all deals',
    'all contacts',
    'all tickets',
    'with name',
    'with company',
    'with email',
    'with status',
    'with amount',
    'with stage',
  ]);
};

const formatRecordLine = (record: LiveRecord, index: number): string => {
  const payload = record.payload;

  if (record.sourceType === 'zoho_lead') {
    const name =
      readField(payload, ['Full_Name', 'Lead_Name', 'Name']) ??
      `${record.sourceType}:${record.sourceId}`;
    const company = readField(payload, ['Company']);
    const email = readField(payload, ['Email']);
    const status = readField(payload, ['Lead_Status', 'Status']);
    const created = readField(payload, ['Created_Time']);
    const parts = [name];
    if (company) parts.push(`company: ${company}`);
    if (email) parts.push(`email: ${email}`);
    if (status) parts.push(`status: ${status}`);
    if (created) parts.push(`created: ${created}`);
    return `${index + 1}. ${parts.join(' | ')}`;
  }

  if (record.sourceType === 'zoho_deal') {
    const name =
      readField(payload, ['Deal_Name', 'Name']) ??
      `${record.sourceType}:${record.sourceId}`;
    const stage = readField(payload, ['Stage']);
    const amount = readField(payload, ['Amount']);
    const closeDate = readField(payload, ['Closing_Date', 'Close_Date']);
    const parts = [name];
    if (stage) parts.push(`stage: ${stage}`);
    if (amount) parts.push(`amount: ${amount}`);
    if (closeDate) parts.push(`close: ${closeDate}`);
    return `${index + 1}. ${parts.join(' | ')}`;
  }

  if (record.sourceType === 'zoho_account') {
    const name =
      readField(payload, ['Account_Name', 'Name']) ??
      `${record.sourceType}:${record.sourceId}`;
    const website = readField(payload, ['Website']);
    const phone = readField(payload, ['Phone']);
    const industry = readField(payload, ['Industry']);
    const owner = readField(payload, ['Owner', 'Account_Owner']);
    const parts = [name];
    if (industry) parts.push(`industry: ${industry}`);
    if (website) parts.push(`website: ${website}`);
    if (phone) parts.push(`phone: ${phone}`);
    if (owner) parts.push(`owner: ${owner}`);
    return `${index + 1}. ${parts.join(' | ')}`;
  }

  if (record.sourceType === 'zoho_contact') {
    const name =
      readField(payload, ['Full_Name', 'Name']) ??
      `${record.sourceType}:${record.sourceId}`;
    const company = readField(payload, ['Account_Name', 'Company']);
    const email = readField(payload, ['Email']);
    const phone = readField(payload, ['Phone', 'Mobile']);
    const parts = [name];
    if (company) parts.push(`company: ${company}`);
    if (email) parts.push(`email: ${email}`);
    if (phone) parts.push(`phone: ${phone}`);
    return `${index + 1}. ${parts.join(' | ')}`;
  }

  const subject =
    readField(payload, ['Subject', 'Name']) ??
    `${record.sourceType}:${record.sourceId}`;
  const status = readField(payload, ['Status']);
  const priority = readField(payload, ['Priority']);
  const created = readField(payload, ['Created_Time']);
  const parts = [subject];
  if (status) parts.push(`status: ${status}`);
  if (priority) parts.push(`priority: ${priority}`);
  if (created) parts.push(`created: ${created}`);
  return `${index + 1}. ${parts.join(' | ')}`;
};

const buildDeterministicListResponse = (objective: string, liveRecords: LiveRecord[]): string => {
  const limit = extractRequestedLimit(objective);
  const rows = liveRecords.slice(0, limit).map(formatRecordLine);
  return `I found ${Math.min(liveRecords.length, limit)} matching Zoho records:\n${rows.join('\n')}`;
};

const SOURCE_MODULE_LABELS: Record<ZohoSourceType, string> = {
  zoho_lead: 'Leads',
  zoho_contact: 'Contacts',
  zoho_account: 'Accounts',
  zoho_deal: 'Deals',
  zoho_ticket: 'Cases',
};

const buildModuleFailure = (sourceType: ZohoSourceType, error: unknown): ModuleFailure => {
  if (error instanceof ZohoIntegrationError) {
    return {
      sourceType,
      moduleName: SOURCE_MODULE_LABELS[sourceType],
      reasonCode: error.code,
      reasonMessage: error.message,
      statusCode: error.statusCode,
    };
  }

  return {
    sourceType,
    moduleName: SOURCE_MODULE_LABELS[sourceType],
    reasonCode: 'unknown',
    reasonMessage: error instanceof Error ? error.message : 'Unknown Zoho module failure',
  };
};

const summarizeModuleFailures = (failures: ModuleFailure[]): string => {
  const summary = failures
    .slice(0, 2)
    .map((failure) => `${failure.moduleName}: ${failure.reasonMessage}`)
    .join('; ');
  return failures.length > 2 ? `${summary}; and ${failures.length - 2} more` : summary;
};

const buildNoDataAnswer = (scopeMode: ZohoScopeMode, reasonMessage?: string): string => {
  if (reasonMessage) {
    return reasonMessage;
  }
  return scopeMode === 'company_scoped'
    ? 'No company-scoped Zoho records matched this query.'
    : 'No email-scoped Zoho records matched this query.';
};

const appendReasonNote = (answer: string, reasonMessage?: string): string => {
  if (!reasonMessage || !reasonMessage.trim()) {
    return answer;
  }
  return `${answer}\n\nNote: ${reasonMessage.trim()}`;
};

export class ZohoReadAgent extends BaseAgent {
  readonly key = 'zoho-read';

  private async fetchLiveRecords(input: {
    companyId: string;
    taskId: string;
    objective: string;
    requesterEmail?: string;
    requesterAiRole?: string;
    departmentZohoReadScope?: 'personalized' | 'show_all';
    scopeMode: ZohoScopeMode;
    strictUserScopeEnabled: boolean;
  }): Promise<LiveFetchResult> {
    const intent = buildQueryIntent(input.objective);
    const records: LiveRecord[] = [];
    const moduleFailures: ModuleFailure[] = [];
    const seen = new Set<string>();

    logger.debug('zoho.agent.live_fetch.start', {
      taskId: input.taskId,
      companyId: input.companyId,
      mode: 'gateway',
      sourceTypes: intent.preferredSourceTypes,
      createdAfter: intent.createdAfter?.toISOString(),
      pageSize: intent.pageSize,
      maxPages: intent.maxPages,
      strictUserScopeEnabled: input.strictUserScopeEnabled,
      scopeMode: input.scopeMode,
    });

    for (const sourceType of intent.preferredSourceTypes) {
      try {
        const auth = await zohoGatewayService.listAuthorizedRecords({
          domain: 'crm',
          module: SOURCE_MODULE_LABELS[sourceType],
          requester: {
            companyId: input.companyId,
            requesterEmail: input.requesterEmail,
            requesterAiRole: input.requesterAiRole,
            departmentZohoReadScope: input.departmentZohoReadScope,
          },
          query: input.objective,
          limit: intent.targetLimit,
        });
        if (!auth.allowed) {
          moduleFailures.push(buildModuleFailure(sourceType, new ZohoIntegrationError({
            message: auth.denialReason ?? 'Zoho gateway denied access',
            code: 'auth_failed',
            retriable: false,
          })));
          break;
        }
        const pageRecords = (auth.payload?.records ?? []).map((record) => ({
          sourceType,
          sourceId: String(record.id ?? ''),
          payload: record,
        })) as LiveRecord[];

        for (const record of pageRecords) {
          if (!record.sourceId || !matchesTimeFilter(record, intent.createdAfter)) {
            continue;
          }
          const key = `${record.sourceType}:${record.sourceId}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          records.push(record);
          if (records.length >= intent.targetLimit) {
            break;
          }
        }
      } catch (error) {
        moduleFailures.push(buildModuleFailure(sourceType, error));
      }
      if (records.length >= intent.targetLimit) {
        break;
      }
    }

    return {
      status:
        records.length > 0
          ? moduleFailures.length > 0 ? 'partial' : 'success'
          : moduleFailures.length > 0
            ? input.scopeMode === 'email_scoped' && input.strictUserScopeEnabled ? 'blocked' : 'degraded'
            : 'empty',
      records,
      sourceRefs: buildLiveSourceRefs(records),
      fallbackUsed: false,
      degraded: moduleFailures.length > 0,
      partial: records.length > 0 && moduleFailures.length > 0,
      scopeMode: input.scopeMode,
      reasonCode:
        records.length === 0 && moduleFailures.length > 0
          ? input.scopeMode === 'email_scoped' && input.strictUserScopeEnabled
            ? 'strict_scope_unenforceable_module'
            : 'company_scope_partial_failure'
          : undefined,
      reasonMessage:
        records.length === 0 && moduleFailures.length > 0
          ? input.scopeMode === 'email_scoped' && input.strictUserScopeEnabled
            ? `No records returned because email-scoped access could not be fully enforced: ${summarizeModuleFailures(moduleFailures)}.`
            : `No records returned because Zoho modules could not be queried cleanly: ${summarizeModuleFailures(moduleFailures)}.`
          : moduleFailures.length > 0
            ? `Returned available Zoho records, but some modules could not be fully checked: ${summarizeModuleFailures(moduleFailures)}.`
            : undefined,
      moduleFailures,
    };
  }

  private async synthesiseWithLLM(input: {
    objective: string;
    liveRecords: LiveRecord[];
    vectorContext: VectorMatch[];
  }): Promise<string> {
    const liveSnippet = JSON.stringify(input.liveRecords.slice(0, 12), null, 2);
    const vectorSnippet =
      input.vectorContext.length > 0
        ? JSON.stringify(
          input.vectorContext.slice(0, 5).map((match) => ({
            sourceType: match.sourceType,
            sourceId: match.sourceId,
            score: match.score,
            payload: toRecord(match.payload),
          })),
          null,
          2,
        )
        : '(no supporting vector context)';

    const promptText = [
      `User request: "${input.objective}"`,
      '',
      'You are Divo CRM synthesis for a Zoho question.',
      'Rules:',
      '- Treat live Zoho API records as the source of truth.',
      '- Use vector context only as supporting context; it may be stale.',
      '- Do not say there are zero records if live records are present below.',
      '- If you summarize records, stay grounded to the provided data.',
      '- Never say "see above", "listed above", or imply hidden UI content.',
      '- If the user asked to list records, include the actual records inline in the answer.',
      '- Lead with the answer and keep the response concise.',
      '- Mention only the most relevant records unless the user explicitly asked for all of them.',
      '',
      '## Live Zoho API records',
      liveSnippet,
      '',
      '## Supporting vector context',
      vectorSnippet,
    ].join('\n');

    const synthesized = await invokeSynthesisTarget(SYNTHESIS_MODEL_TARGET, promptText);
    if (synthesized) {
      return synthesized;
    }

    if (input.liveRecords.length === 0) {
      return 'No Zoho records matched the request.';
    }

    const preview = input.liveRecords
      .slice(0, 5)
      .map((record) => `${record.sourceType}:${record.sourceId}`)
      .join(', ');
    return `Found ${input.liveRecords.length} Zoho records. Sample IDs: ${preview}.`;
  }

  async invoke(input: AgentInvokeInputDTO) {
    const startedAt = Date.now();
    let apiCalls = 0;
    let resolvedCompanyId: string | undefined;
    let strictUserScopeEnabled = true;
    let scopeMode: ZohoScopeMode = 'email_scoped';

    try {
      const VECTOR_CONTEXT_ENABLED = process.env.ZOHO_VECTOR_CONTEXT_ENABLED !== 'false';
      const intent = buildQueryIntent(input.objective);
      const retrievalLimit = Math.min(10, Math.max(DEFAULT_RESULT_LIMIT, intent.targetLimit + 2));

      const companyId = await companyContextResolver.resolveCompanyId({
        companyId: input.contextPacket.companyId,
        larkTenantKey: input.contextPacket.larkTenantKey,
      });
      resolvedCompanyId = companyId;
      apiCalls++;
      strictUserScopeEnabled = await isCompanyControlEnabled({
        controlKey: COMPANY_CONTROL_KEYS.zohoUserScopedReadStrictEnabled,
        companyId,
        defaultValue: true,
      });
      const departmentZohoReadScope =
        input.contextPacket.departmentZohoReadScope === 'show_all' ? 'show_all' : 'personalized';
      scopeMode = strictUserScopeEnabled
        ? resolveZohoScopeMode(departmentZohoReadScope)
        : 'company_scoped';
      const requesterEmail =
        typeof input.contextPacket.requesterEmail === 'string'
          ? input.contextPacket.requesterEmail.trim()
          : '';

      let liveRecords: LiveRecord[] = [];
      let liveSourceRefs: SourceRef[] = [];
      let liveResult: LiveFetchResult | null = null;

      try {
        const live = await this.fetchLiveRecords({
          companyId,
          taskId: input.taskId,
          objective: input.objective,
          requesterEmail,
          requesterAiRole: typeof input.contextPacket.requesterAiRole === 'string' ? input.contextPacket.requesterAiRole : undefined,
          departmentZohoReadScope,
          scopeMode,
          strictUserScopeEnabled,
        });
        liveResult = live;
        liveRecords = live.records;
        liveSourceRefs = live.sourceRefs;
        apiCalls += 2;

        logger.debug('zoho.agent.live_fetch.complete', {
          taskId: input.taskId,
          companyId,
          mode: 'rest',
          sourceTypes: intent.preferredSourceTypes,
          scopeMode,
          status: live.status,
          recordCount: liveRecords.length,
          moduleFailureCount: live.moduleFailures.length,
          degraded: live.degraded,
          reasonCode: live.reasonCode,
          reasonMessage: live.reasonMessage,
        });
      } catch (error) {
        const isRateLimited =
          error instanceof ZohoIntegrationError
          && error.code === 'rate_limited';
        const logMeta = {
          taskId: input.taskId,
          companyId,
          code: error instanceof ZohoIntegrationError ? error.code : undefined,
          statusCode: error instanceof ZohoIntegrationError ? error.statusCode : undefined,
          reason: error instanceof Error ? error.message : 'unknown_error',
        };
        if (isRateLimited) {
          logger.error('zoho.agent.live_fetch.rate_limited', logMeta);
        } else {
          logger.warn('zoho.agent.live_fetch.failed', logMeta);
        }
        throw error;
      }

      if (!liveResult) {
        throw new Error('Live Zoho result was not computed');
      }

      if (liveRecords.length === 0) {
        const answer = buildNoDataAnswer(scopeMode, liveResult.reasonMessage);
        return this.success(
          input,
          answer,
          {
            companyId,
            answer,
            sourceRefs: [],
            sources: [],
            liveProviderMode: 'rest',
            fallbackUsed: false,
            liveRecordCount: 0,
            vectorRecordCount: 0,
            scopeMode,
            degraded: liveResult.degraded,
            partial: false,
            reasonCode: liveResult.reasonCode ?? null,
            reasonMessage: liveResult.reasonMessage ?? null,
            moduleFailures: liveResult.moduleFailures.length,
          },
          { latencyMs: Date.now() - startedAt, apiCalls },
        );
      }

      let vectorMatches: VectorMatch[] = [];
      let vectorSourceRefs: SourceRef[] = [];
      if (VECTOR_CONTEXT_ENABLED) {
        try {
          const requesterUserId =
            typeof input.contextPacket.channelIdentityId === 'string' && input.contextPacket.channelIdentityId.trim()
              ? input.contextPacket.channelIdentityId.trim()
              : typeof input.contextPacket.userId === 'string' && input.contextPacket.userId.trim()
                ? input.contextPacket.userId.trim()
                : undefined;
          vectorMatches = await zohoRetrievalService.query({
            companyId,
            requesterUserId,
            requesterEmail,
            scopeMode,
            strictUserScopeEnabled,
            text: input.objective,
            limit: retrievalLimit,
            sourceTypes: intent.preferredSourceTypes,
          });
          const authorizedSourceIds = new Set(liveRecords.map((record) => `${record.sourceType}:${record.sourceId}`));
          vectorMatches = vectorMatches.filter((match) => authorizedSourceIds.has(`${match.sourceType}:${match.sourceId}`));
          vectorSourceRefs = buildVectorSourceRefs(vectorMatches);
          apiCalls++;
        } catch (vecError) {
          logger.warn('zoho.agent.vector_context.failed', {
            taskId: input.taskId,
            companyId,
            reason: vecError instanceof Error ? vecError.message : 'unknown_error',
          });
        }
      }

      let answer: string;
      if (isListRequest(input.objective)) {
        answer = buildDeterministicListResponse(input.objective, liveRecords);
      } else {
        try {
          answer = await this.synthesiseWithLLM({
            objective: input.objective,
            liveRecords,
            vectorContext: vectorMatches,
          });
          apiCalls++;
        } catch (llmError) {
          logger.warn('zoho.agent.llm_synthesis.failed', {
            taskId: input.taskId,
            companyId,
            reason: llmError instanceof Error ? llmError.message : 'unknown_error',
          });
          answer = buildPlainTextFallback(input.objective, liveRecords);
        }
      }
      answer = appendReasonNote(answer, liveResult.reasonMessage);

      const allSourceRefs = [...liveSourceRefs, ...vectorSourceRefs];
      const summarySources = allSourceRefs.slice(0, 4).map((ref) => ref.id);

      return this.success(
        input,
        answer,
        {
          companyId,
          answer,
          sources: summarySources,
          sourceRefs: allSourceRefs,
          liveProviderMode: 'rest',
          fallbackUsed: false,
          liveRecordCount: liveRecords.length,
          vectorRecordCount: vectorMatches.length,
          scopeMode,
          degraded: liveResult.degraded,
          partial: liveResult.partial,
          reasonCode: liveResult.reasonCode ?? null,
          reasonMessage: liveResult.reasonMessage ?? null,
          moduleFailures: liveResult.moduleFailures.length,
        },
        { latencyMs: Date.now() - startedAt, apiCalls },
      );
    } catch (error) {
      if (error instanceof CompanyContextResolutionError) {
        return this.failure(
          input,
          error.message,
          error.code,
          error.message,
          false,
          { latencyMs: Date.now() - startedAt, apiCalls },
        );
      }

      if (error instanceof ZohoIntegrationError) {
        const answer = `I couldn't read Zoho CRM cleanly for this request. Reason: ${error.message}`;
        logger.warn('zoho.agent.soft_failure', {
          taskId: input.taskId,
          companyId: resolvedCompanyId,
          scopeMode,
          code: error.code,
          statusCode: error.statusCode,
          reason: error.message,
          requesterAiRole:
            typeof input.contextPacket.requesterAiRole === 'string' ? input.contextPacket.requesterAiRole : undefined,
        });
        return this.success(
          input,
          answer,
          {
            companyId: resolvedCompanyId ?? input.contextPacket.companyId,
            answer,
            sourceRefs: [],
            sources: [],
            liveProviderMode: 'rest',
            fallbackUsed: false,
            liveRecordCount: 0,
            vectorRecordCount: 0,
            scopeMode,
            degraded: true,
            partial: false,
            reasonCode: error.code,
            reasonMessage: error.message,
            moduleFailures: 0,
          },
          { latencyMs: Date.now() - startedAt, apiCalls },
        );
      }

      return this.failure(
        input,
        'Zoho retrieval failed',
        'embedding_unavailable',
        error instanceof Error ? error.message : 'unknown_error',
        true,
        { latencyMs: Date.now() - startedAt, apiCalls },
      );
    }
  }
}
