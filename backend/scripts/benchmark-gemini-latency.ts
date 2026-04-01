import 'dotenv/config';

import { performance } from 'node:perf_hooks';

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, type LanguageModelUsage } from 'ai';

import config from '../src/config';

type BenchmarkRow = {
  prompt: string;
  ttftMs: number | null;
  totalMs: number;
  tokens: number;
  error?: string;
};

const apiKey =
  config.GEMINI_API_KEY
  || process.env.GOOGLE_API_KEY
  || process.env.GEMINI_API_KEY
  || '';

if (!apiKey) {
  throw new Error('Missing GEMINI_API_KEY or GOOGLE_API_KEY');
}

const google = createGoogleGenerativeAI({ apiKey });
const benchmarkModelId = process.env.GEMINI_BENCHMARK_MODEL ?? 'gemini-3.1-flash-lite-preview';
const model = google(benchmarkModelId);

const mediumSystemPrompt = [
  'You are a measured internal assistant who answers with concise, structured output.',
  'Read the request carefully, identify the key entities, and avoid inventing facts.',
  'When the request is ambiguous, state the ambiguity explicitly and ask for the smallest useful clarification.',
  'If the user asks for a list, return the list directly and keep the surrounding commentary brief.',
  'If the user asks for a summary, preserve the important details, names, numbers, and dates.',
  'Prefer concrete bullet points over long paragraphs when the answer is procedural.',
  'Do not expand a short request into a long essay.',
  'Do not repeat the user request unless it helps to disambiguate the result.',
  'When you mention a record, keep identifiers and names intact.',
  'If no records exist, say that plainly.',
  'Avoid speculation, avoid filler, and avoid internal chain-of-thought.',
  'Use direct, calm language and give the shortest complete answer.',
  'If there are multiple plausible interpretations, separate them clearly.',
  'For operational tasks, prioritize the most likely next action.',
  'For financial tasks, preserve record IDs, amounts, currency, and due dates when available.',
].join(' ');

const buildFullSystemPrompt = (): string => {
  const fakeContext = {
    conversationKey: 'lark:chat:demo-123',
    runtime: {
      companyId: 'company-demo',
      userId: 'user-demo',
      requesterAiRole: 'MEMBER',
      departmentId: 'dept-demo',
      departmentName: 'Operations',
      departmentRoleSlug: 'OPS',
      allowedToolIds: ['contextSearch', 'zohoBooks', 'larkTask', 'larkCalendar'],
      runExposedToolIds: ['zohoBooks', 'larkTask'],
      plannerCandidateToolIds: ['zohoBooks', 'larkTask'],
      toolSelectionReason: 'demo benchmark prompt',
    },
    routerAcknowledgement: {
      kind: 'structured',
      route: 'lark',
      intent: 'create_task',
      confidence: 0.91,
    },
    childRouteHints: {
      route: 'lark',
      domain: 'workspace',
      operationType: 'task_create',
      normalizedIntent: 'create task',
      suggestedToolIds: ['larkTask'],
    },
    latestUserMessage: 'Create a task called test',
    queryEnrichment: {
      rawMessage: 'Create a task called test',
      expandedQuery: 'create a task called test in lark tasks',
      sourceHint: 'lark',
    },
    hasAttachedFiles: false,
    groundedFiles: [],
    threadSummary: {
      summary: 'Latest discussion centers on task creation and follow-up action items.',
      latestObjective: 'Create a task for a quick benchmark.',
      latestUserGoal: 'Validate streaming latency under a large system prompt.',
      activeEntities: [
        { ordinal: 1, recordId: 'task-001', label: 'Demo task' },
        { ordinal: 2, recordId: 'invoice-009', label: 'Sample invoice' },
      ],
      resolvedRefs: [
        { key: 'taskId', value: 'task-001' },
        { key: 'ownerEmail', value: 'demo@example.com' },
      ],
      completedActions: [
        'Read the request.',
        'Identified the target tool family.',
        'Prepared a benchmark prompt.',
      ],
      completedWrites: ['Created a draft task record.'],
      pendingApprovals: ['None.'],
      constraints: ['Keep output brief.', 'Preserve identifiers.'],
      recentTaskSummaries: [
        { taskId: 'task-001', summary: 'Checked routing behavior.', completedAt: '2026-04-01T00:00:00.000Z' },
        { taskId: 'task-002', summary: 'Validated tool exposure.', completedAt: '2026-04-01T00:01:00.000Z' },
        { taskId: 'task-003', summary: 'Measured step latency.', completedAt: '2026-04-01T00:02:00.000Z' },
      ],
    },
    taskState: {
      activeObjective: 'Run a latency benchmark.',
      pendingApproval: null,
      completedMutations: [],
      activeSourceArtifacts: [],
    },
    conversationRetrievalSnippets: [
      'Internal note: keep the benchmark self-contained.',
      'Internal note: measure TTFT separately from total time.',
      'Internal note: report output tokens from the stream usage object.',
    ],
    behaviorProfileContext: 'Prefer concise operational answers.',
    durableMemoryContext: 'User often asks for code-level diagnostics and benchmark runs.',
    relevantMemoryFactsContext: 'No special restrictions.',
    memoryWriteStatusContext: 'Memory writes disabled for benchmark.',
    activeTaskContext: 'Benchmark task context: generate a task named test and report timing.',
  };

  return JSON.stringify(fakeContext, null, 2);
};

const fullSystemPrompt = buildFullSystemPrompt();

const buildMediumPrompt = (): { system: string; prompt: string } => ({
  system: mediumSystemPrompt,
  prompt: 'List 3 invoices.',
});

const buildFullPrompt = (): { system: string; prompt: string } => ({
  system: fullSystemPrompt,
  prompt: 'Create a task called test.',
});

const formatMs = (value: number | null): string => (value == null ? 'n/a' : `${Math.round(value)}`);

async function runCase(input: {
  prompt: string;
  system?: string;
}): Promise<BenchmarkRow> {
  const startedAt = performance.now();
  let firstChunkAt: number | null = null;
  let sawAnyChunk = false;

  try {
    const result = streamText({
      model,
      system: input.system,
      prompt: input.prompt,
      temperature: 0,
      maxOutputTokens: 96,
    });

    for await (const part of result.fullStream) {
      if (!sawAnyChunk) {
        sawAnyChunk = true;
        firstChunkAt = performance.now();
      }
      void part;
    }

    const totalUsage: LanguageModelUsage = await result.totalUsage;
    const totalMs = performance.now() - startedAt;

    return {
      prompt: input.system ? (input.prompt === 'List 3 invoices.' ? 'Medium' : 'Full') : 'Minimal',
      ttftMs: firstChunkAt == null ? null : firstChunkAt - startedAt,
      totalMs,
      tokens: totalUsage.outputTokens ?? 0,
    };
  } catch (error) {
    return {
      prompt: input.system ? (input.prompt === 'List 3 invoices.' ? 'Medium' : 'Full') : 'Minimal',
      ttftMs: firstChunkAt == null ? null : firstChunkAt - startedAt,
      totalMs: performance.now() - startedAt,
      tokens: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const cases = [
    { prompt: 'Say hello' },
    buildMediumPrompt(),
    buildFullPrompt(),
  ];

  const results: BenchmarkRow[] = [];
  for (const benchmarkCase of cases) {
    results.push(await runCase(benchmarkCase));
  }

  console.table(
    results.map((row) => ({
      model: benchmarkModelId,
      prompt: row.prompt,
      TTFT_ms: formatMs(row.ttftMs),
      total_ms: Math.round(row.totalMs),
      tokens: row.tokens,
      error: row.error ?? '',
    })),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
