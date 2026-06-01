#!/usr/bin/env tsx

import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';

import { loadAndValidateEnv } from '../src/config/env';
import { LarkChannelAdapter } from '../src/infrastructure/channels/lark/lark.adapter';
import type { ConversationHandle, StatusHandle } from '../src/application/channels/channel.adapter';
import type { FinalReply, StatusUpdate } from '../src/domain/channel/outbound';
import type { Logger } from '../src/shared/logger';
import { asChatId, asCorrelationId, asMessageId } from '../src/shared/ids';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function resolveFixturePath(raw: string | undefined): string {
  if (!raw) {
    return path.resolve(process.cwd(), '../.context/attachments/vwtiW9/pasted_text_2026-05-27_00-13-43.txt');
  }
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type LogEntry = {
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  data?: Record<string, unknown>;
};

class RecordingLogger implements Logger {
  constructor(
    private readonly bindings: Record<string, unknown> = {},
    readonly entries: LogEntry[] = [],
  ) {}

  private record(level: LogEntry['level'], event: string, data?: Record<string, unknown>): void {
    const entry = {
      level,
      event,
      data: {
        ...this.bindings,
        ...(data ?? {}),
      },
    } satisfies LogEntry;
    this.entries.push(entry);
    const line = JSON.stringify({
      level,
      event,
      ...this.bindings,
      ...(data ?? {}),
    });
    if (level === 'warn' || level === 'error') console.error(line);
    else console.log(line);
  }

  debug(event: string, data?: Record<string, unknown>): void { this.record('debug', event, data); }
  info(event: string, data?: Record<string, unknown>): void { this.record('info', event, data); }
  warn(event: string, data?: Record<string, unknown>): void { this.record('warn', event, data); }
  error(event: string, data?: Record<string, unknown>): void { this.record('error', event, data); }
  child(bindings: Record<string, unknown>): Logger {
    return new RecordingLogger({ ...this.bindings, ...bindings }, this.entries);
  }
}

type Scenario = {
  name: string;
  statusSteps: number;
  statusDelayMs: number;
  replyText: string;
  executionTrace?: string;
};

function buildTimeline(step: number, total: number): StatusUpdate['timeline'] {
  const completed = Math.max(0, step - 1);
  const recent = [
    '[done] Searching the web',
    '[done] Searching knowledge base',
    '[done] Updating plan',
    `[run]  Executing step ${step}`,
  ].slice(Math.max(0, step - 4));
  const narration = [
    'Searching the web...',
    'Searching knowledge base...',
    'Updating plan...',
  ].slice(0, Math.min(3, step));
  return {
    phase: `Executing · ${completed}/${total}`,
    progressPct: Math.min(92, 10 + Math.round((completed / Math.max(1, total)) * 78)),
    completedSteps: completed,
    totalSteps: total,
    liveLabel: step >= total ? 'Preparing response…' : `Working through step ${step}/${total}…`,
    narration,
    narrationActive: step >= total ? 'Preparing the final response...' : `Running analysis step ${step}...`,
    recent,
    plan: Array.from({ length: Math.min(total, 5) }, (_, index) => {
      const seq = index + 1;
      const status = seq < step ? 'done' : seq === step ? 'running' : 'pending';
      return {
        status,
        title: seq === 1
          ? 'Search web'
          : seq === 2
            ? 'Search knowledge base'
            : seq === 3
              ? 'Update plan'
              : seq === 4
                ? 'Analyze overdue data'
                : 'Draft response',
        toolFamily: seq <= 3 ? 'context' : 'other',
      };
    }),
  };
}

function buildStressTrace(stepCount: number, verbosity: 'realistic' | 'expanded'): string {
  const lines = [
    '---',
    `**Trace** (${stepCount} steps, 96.4s; showing last 5)`,
  ];
  const suffix = verbosity === 'expanded'
    ? ' — extracted rows, normalized currencies, merged buckets, and prepared formatted output with detailed metadata for the final response card'
    : ' — completed successfully';
  for (let step = Math.max(1, stepCount - 4); step <= stepCount; step += 1) {
    lines.push(`✓ Completed analysis step ${step}${suffix}`);
  }
  return lines.join('\n');
}

async function loadBuildFinalCard(): Promise<(input: {
  markdown: string;
  branding?: { departmentLabel?: string; departmentColor?: 'green' | 'blue' | 'purple' | 'orange' | 'red' | 'turquoise' | 'grey' };
  actions?: readonly { label: string; value: string; style?: 'primary' | 'danger' | 'default' }[];
  executionTrace?: string;
}) => string> {
  const module = await import('../src/infrastructure/channels/lark/lark-card.builder.ts');
  const candidate = (module as { buildFinalCard?: unknown }).buildFinalCard
    ?? (module as { default?: { buildFinalCard?: unknown } }).default?.buildFinalCard;
  if (typeof candidate !== 'function') {
    throw new Error('Could not load buildFinalCard from lark-card.builder.ts');
  }
  return candidate as ReturnType<typeof loadBuildFinalCard> extends Promise<infer T> ? T : never;
}

function classifyOutcome(statusHandle: StatusHandle | null, finalMessageId: string, logs: readonly LogEntry[]): 'updated_same_card' | 'sent_new_card' | 'plain_text_fallback' {
  if (logs.some(entry => entry.event === 'lark.adapter.plain_text_fallback_sent')) {
    return 'plain_text_fallback';
  }
  if (statusHandle && String(statusHandle.messageId) === finalMessageId) {
    return 'updated_same_card';
  }
  return 'sent_new_card';
}

async function runScenario(params: {
  adapter: LarkChannelAdapter;
  logger: RecordingLogger;
  conversation: ConversationHandle;
  scenario: Scenario;
  buildFinalCard: Awaited<ReturnType<typeof loadBuildFinalCard>>;
}): Promise<Record<string, unknown>> {
  const { adapter, logger, conversation, scenario, buildFinalCard } = params;
  const logsBefore = logger.entries.length;
  const runStart = Date.now();

  console.log(`\n=== Scenario: ${scenario.name} ===`);
  const statusHandleResult = await adapter.sendStatus(conversation, {
    kind: 'status',
    terminal: false,
    branding: { departmentLabel: 'Finance', departmentColor: 'green' },
    timeline: buildTimeline(1, scenario.statusSteps),
  });
  if (!statusHandleResult.ok) {
    throw new Error(`Initial status send failed: ${statusHandleResult.error.message}`);
  }
  let statusHandle: StatusHandle | null = statusHandleResult.value;

  for (let step = 2; step <= scenario.statusSteps; step += 1) {
    await sleep(scenario.statusDelayMs);
    const editResult = await adapter.editStatus(statusHandle, {
      kind: 'status',
      terminal: false,
      branding: { departmentLabel: 'Finance', departmentColor: 'green' },
      timeline: buildTimeline(step, scenario.statusSteps),
    });
    if (editResult.ok) statusHandle = editResult.value;
  }

  const cardPayload = buildFinalCard({
    markdown: scenario.replyText,
    branding: { departmentLabel: 'Finance', departmentColor: 'green' },
    ...(scenario.executionTrace ? { executionTrace: scenario.executionTrace } : {}),
  });

  const finalReply: FinalReply = {
    kind: 'final',
    format: 'markdown',
    text: scenario.replyText,
    branding: { departmentLabel: 'Finance', departmentColor: 'green' },
    ...(scenario.executionTrace ? { executionTrace: scenario.executionTrace } : {}),
  };

  const finalResult = await adapter.sendFinalReply(conversation, finalReply);
  const scenarioLogs = logger.entries.slice(logsBefore);
  if (!finalResult.ok) {
    return {
      scenario: scenario.name,
      success: false,
      durationMs: Date.now() - runStart,
      statusMessageId: statusHandle ? String(statusHandle.messageId) : null,
      error: finalResult.error.message,
      cardBytes: cardPayload.length,
      logEvents: scenarioLogs,
    };
  }

  const finalMessageId = String(finalResult.value.messageId);
  const outcome = classifyOutcome(statusHandle, finalMessageId, scenarioLogs);

  return {
    scenario: scenario.name,
    success: true,
    durationMs: Date.now() - runStart,
    statusMessageId: statusHandle ? String(statusHandle.messageId) : null,
    finalMessageId,
    outcome,
    cardBytes: cardPayload.length,
    logEvents: scenarioLogs,
  };
}

function buildScenarios(replyText: string): Scenario[] {
  return [
    {
      name: 'exact-response',
      statusSteps: 4,
      statusDelayMs: 1700,
      replyText,
    },
    {
      name: 'stress-trace',
      statusSteps: 8,
      statusDelayMs: 1700,
      replyText,
      executionTrace: buildStressTrace(18, 'expanded'),
    },
  ];
}

async function main(): Promise<void> {
  const env = loadAndValidateEnv(process.env);
  const chatId = arg('--chat-id') ?? 'oc_4da3c8e6a6a2b9eb29a2aea24fd17e50';
  const fixturePath = resolveFixturePath(arg('--fixture-path'));
  const outputPath = path.resolve(process.cwd(), arg('--output') ?? '../.context/lark-finalize-sim-result.json');
  const replyText = fs.readFileSync(fixturePath, 'utf8').trim();
  const buildFinalCard = await loadBuildFinalCard();

  const logger = new RecordingLogger({ script: 'simulate-lark-finalize' });
  const adapter = new LarkChannelAdapter({ env, logger });
  const scenarios = buildScenarios(replyText);

  console.log(JSON.stringify({
    chatId,
    fixturePath,
    outputPath,
    replyChars: replyText.length,
    scenarios: scenarios.map(s => ({
      name: s.name,
      statusSteps: s.statusSteps,
      statusDelayMs: s.statusDelayMs,
      hasExecutionTrace: !!s.executionTrace,
    })),
  }, null, 2));

  const results: Record<string, unknown>[] = [];
  for (const [index, scenario] of scenarios.entries()) {
    const correlationId = asCorrelationId(`sim-${Date.now()}-${index + 1}`);
    const conversation: ConversationHandle = {
      channel: 'lark',
      chatId: asChatId(chatId),
      correlationId,
      replyInThread: false,
    };

    const result = await runScenario({
      adapter,
      logger,
      conversation,
      scenario,
      buildFinalCard,
    });
    results.push(result);

    const printable = {
      scenario: result['scenario'],
      success: result['success'],
      outcome: result['outcome'],
      durationMs: result['durationMs'],
      statusMessageId: result['statusMessageId'],
      finalMessageId: result['finalMessageId'],
      cardBytes: result['cardBytes'],
    };
    console.log(JSON.stringify(printable, null, 2));
  }

  fs.writeFileSync(outputPath, JSON.stringify({
    ranAt: new Date().toISOString(),
    chatId,
    fixturePath,
    results,
  }, null, 2));

  console.log(`\nSaved run report to ${outputPath}`);
}

void main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
