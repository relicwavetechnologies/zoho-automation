import type { AgentInvokeInputDTO } from '../../contracts';
import { CompanyContextResolutionError, companyContextResolver, zohoRetrievalService } from '../support';
import { BaseAgent } from '../base';
import { resolveZohoProvider } from '../../integrations/zoho/zoho-provider.resolver';
import type { ZohoSourceType } from '../../integrations/zoho/zoho-provider.adapter';
import { ZohoIntegrationError } from '../../integrations/zoho/zoho.errors';
import { zohoDataClient } from '../../integrations/zoho/zoho-data.client';
import { normalizeEmail } from '../../integrations/zoho/zoho-email-scope';
import { COMPANY_CONTROL_KEYS, isCompanyControlEnabled } from '../../support/runtime-controls';
import { logger } from '../../../utils/logger';

const DEFAULT_RESULT_LIMIT = 3;
const MAX_ALL_RESULT_LIMIT = 25;

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

const inferSourceTypes = (objective: string): ZohoSourceType[] => {
  const text = normalizeText(objective);
  const preferred: ZohoSourceType[] = [];

  if (containsAny(text, [' lead', 'leads', ' prospect', 'prospects'])) preferred.push('zoho_lead');
  if (containsAny(text, [' deal', 'deals', ' opportunity', 'opportunities'])) preferred.push('zoho_deal');
  if (containsAny(text, [' contact', 'contacts'])) preferred.push('zoho_contact');
  if (containsAny(text, [' ticket', 'tickets', ' case', 'cases', 'support'])) preferred.push('zoho_ticket');

  return preferred.length > 0
    ? [...new Set(preferred)]
    : ['zoho_lead', 'zoho_deal', 'zoho_contact', 'zoho_ticket'];
};

const inferCreatedAfter = (objective: string): Date | undefined => {
  const text = normalizeText(objective);
  const now = new Date();

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

export class ZohoReadAgent extends BaseAgent {
  readonly key = 'zoho-read';

  private async fetchLiveRecords(input: {
    companyId: string;
    taskId: string;
    objective: string;
    requesterEmail?: string;
    strictUserScopeEnabled: boolean;
  }): Promise<{ records: LiveRecord[]; sourceRefs: SourceRef[]; fallbackUsed: boolean }> {
    const intent = buildQueryIntent(input.objective);
    const records: LiveRecord[] = [];
    const seen = new Set<string>();
    const provider = await resolveZohoProvider({ companyId: input.companyId });

    logger.debug('zoho.agent.live_fetch.start', {
      taskId: input.taskId,
      companyId: input.companyId,
      mode: provider.providerMode,
      sourceTypes: intent.preferredSourceTypes,
      createdAfter: intent.createdAfter?.toISOString(),
      pageSize: intent.pageSize,
      maxPages: intent.maxPages,
      strictUserScopeEnabled: input.strictUserScopeEnabled,
    });

    if (input.strictUserScopeEnabled) {
      const requesterEmail = normalizeEmail(input.requesterEmail);
      if (!requesterEmail) {
        throw new ZohoIntegrationError({
          message: 'Requester email is required for strict user-scoped Zoho reads',
          code: 'auth_failed',
          retriable: false,
        });
      }

      for (const sourceType of intent.preferredSourceTypes) {
        const scopedRecords = await zohoDataClient.fetchUserScopedRecords({
          companyId: input.companyId,
          environment: provider.environment,
          sourceType,
          requesterEmail,
          limit: intent.targetLimit,
          maxPages: intent.maxPages,
          sortBy: intent.sortBy,
          sortOrder: intent.sortOrder,
        });

        for (const record of scopedRecords) {
          if (!matchesTimeFilter(record, intent.createdAfter)) {
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

        if (records.length >= intent.targetLimit) {
          break;
        }
      }

      return {
        records,
        sourceRefs: buildLiveSourceRefs(records),
        fallbackUsed: false,
      };
    }

    for (const sourceType of intent.preferredSourceTypes) {
      let cursor: string | undefined;
      let pagesFetched = 0;

      while (pagesFetched < intent.maxPages && records.length < intent.targetLimit) {
        const page = await provider.adapter.fetchHistoricalPage({
          context: {
            companyId: input.companyId,
            environment: provider.environment,
            connectionId: provider.connectionId,
          },
          cursor,
          pageSize: intent.pageSize,
          sourceType,
          sortBy: intent.sortBy,
          sortOrder: intent.sortOrder,
        });
        pagesFetched += 1;

        const pageRecords = page.records.map((record) => ({
          sourceType: record.sourceType,
          sourceId: record.sourceId,
          payload: record.payload,
        })) as LiveRecord[];

        for (const record of pageRecords) {
          if (!matchesTimeFilter(record, intent.createdAfter)) {
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

        const encounteredOlderRecord =
          Boolean(intent.createdAfter)
          && pageRecords.some((record) => {
            const timestamp = getRecordTimestamp(record);
            return timestamp !== null && timestamp < intent.createdAfter!.getTime();
          });

        if (!page.nextCursor || encounteredOlderRecord || records.length >= intent.targetLimit) {
          break;
        }
        cursor = page.nextCursor;
      }
    }

    return {
      records,
      sourceRefs: buildLiveSourceRefs(records),
      fallbackUsed: false,
    };
  }

  private async synthesiseWithLLM(input: {
    objective: string;
    liveRecords: LiveRecord[];
    vectorContext: VectorMatch[];
  }): Promise<string> {
    const [{ mastra }, { buildMastraAgentRunOptions }] = await Promise.all([
      import('../../integrations/mastra/mastra.instance'),
      import('../../integrations/mastra/mastra-model-control'),
    ]);

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
      'You are answering a Zoho CRM question.',
      'Rules:',
      '- Treat live Zoho API records as the source of truth.',
      '- Use vector context only as supporting context; it may be stale.',
      '- Do not say there are zero records if live records are present below.',
      '- If you summarize records, stay grounded to the provided data.',
      '- Never say "see above", "listed above", or imply hidden UI content.',
      '- If the user asked to list records, include the actual records inline in the answer.',
      '',
      '## Live Zoho API records',
      liveSnippet,
      '',
      '## Supporting vector context',
      vectorSnippet,
    ].join('\n');

    const agent = mastra.getAgent('synthesisAgent');
    const runOptions = await buildMastraAgentRunOptions('mastra.synthesis');
    const result = await agent.generate(promptText, runOptions as any);
    return result.text;
  }

  async invoke(input: AgentInvokeInputDTO) {
    const startedAt = Date.now();
    let apiCalls = 0;
    let strictUserScopeEnabled = true;

    try {
      const VECTOR_CONTEXT_ENABLED = process.env.ZOHO_VECTOR_CONTEXT_ENABLED !== 'false';
      const intent = buildQueryIntent(input.objective);
      const retrievalLimit = Math.min(10, Math.max(DEFAULT_RESULT_LIMIT, intent.targetLimit + 2));

      const companyId = await companyContextResolver.resolveCompanyId({
        companyId: input.contextPacket.companyId,
        larkTenantKey: input.contextPacket.larkTenantKey,
      });
      apiCalls++;
      strictUserScopeEnabled = await isCompanyControlEnabled({
        controlKey: COMPANY_CONTROL_KEYS.zohoUserScopedReadStrictEnabled,
        companyId,
        defaultValue: true,
      });
      const requesterEmail =
        typeof input.contextPacket.requesterEmail === 'string'
          ? input.contextPacket.requesterEmail.trim()
          : '';

      if (strictUserScopeEnabled && !normalizeEmail(requesterEmail)) {
        return this.failure(
          input,
          'Requester email is required for strict user-scoped Zoho reads.',
          'strict_scope_missing_requester_email',
          'Requester email missing from trusted request context',
          false,
          { latencyMs: Date.now() - startedAt, apiCalls },
        );
      }

      let liveRecords: LiveRecord[] = [];
      let liveSourceRefs: SourceRef[] = [];

      try {
        const live = await this.fetchLiveRecords({
          companyId,
          taskId: input.taskId,
          objective: input.objective,
          requesterEmail,
          strictUserScopeEnabled,
        });
        liveRecords = live.records;
        liveSourceRefs = live.sourceRefs;
        apiCalls += 2;

        logger.debug('zoho.agent.live_fetch.success', {
          taskId: input.taskId,
          companyId,
          mode: 'rest',
          sourceTypes: intent.preferredSourceTypes,
          recordCount: liveRecords.length,
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

      if (liveRecords.length === 0) {
        if (strictUserScopeEnabled) {
          return this.failure(
            input,
            'No Zoho records matched your user-scoped access.',
            'strict_scope_no_matching_records',
            'Strict user scope yielded zero records',
            false,
            { latencyMs: Date.now() - startedAt, apiCalls },
          );
        }

        const answer = 'The live Zoho API did not return matching records for this query.';
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
        const strictUnenforceable =
          strictUserScopeEnabled
          && error.code === 'schema_mismatch'
          && error.message.toLowerCase().includes('strict user scope cannot be enforced');
        return this.failure(
          input,
          strictUnenforceable ? 'Strict user scope is not enforceable for one or more Zoho modules.' : 'Zoho provider retrieval failed',
          strictUnenforceable ? 'strict_scope_unenforceable_module' : error.code,
          error.message,
          error.retriable,
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
