#!/usr/bin/env tsx
/**
 * Live Agent Seat test: multi-tab Semrush workbook export (mixed shapes + tabName).
 *
 * Scenario:
 *   - 10-domain backlinks_comparison (max Semrush batch)
 *   - domain_overview for the first N comparison targets (separate tabs)
 *   - ambiguous guard without tabName
 *   - XLSX workbook with explicit tabName per dataset
 *   - direct_queue for small multi-tab workbooks (sample only when row estimate is large/unknown)
 *
 * Usage:
 *   cd advance-backend
 *   pnpm dev:e2e   # DB tunnel + Redis (separate terminal)
 *   pnpm dev       # workers + Lark delivery (separate terminal)
 *   pnpm tsx scripts/run-semrush-multitab-export.ts
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/agent-seat.ts');

/** Max backlinks batch — stresses one wide comparison tab. */
const BACKLINK_TARGETS = [
  'emiactech.com',
  'decentro.tech',
  'policyholder.gov.in',
  'whatmycarworth.com',
  'giztrendzone.com',
  'technewsera.com',
  'theedgesearch.com',
  'gamengadgets.com',
  'travelexperta.com',
  'manvsclock.com',
] as const;

/** One overview tab per domain (mixed shape vs backlinks). Cap at 9 so total datasets ≤ 10. */
const OVERVIEW_DOMAINS = BACKLINK_TARGETS.slice(0, 6);

interface StepResult {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly data?: unknown;
}

function extractLastJson(text: string): unknown {
  const marker = text.lastIndexOf('\n{');
  const start = marker >= 0 ? marker + 1 : text.lastIndexOf('{');
  if (start < 0) throw new Error(`No JSON in output: ${text.slice(-400)}`);
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error(`Incomplete JSON: ${text.slice(-400)}`);
}

function seat(args: string[]): unknown {
  const result = spawnSync('pnpm', ['tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  return extractLastJson(combined);
}

function turnBegin(): void {
  seat(['turn', 'begin']);
}

function invokeSemrush(args: Record<string, unknown>) {
  turnBegin();
  const res = seat(['invoke', 'semrush', JSON.stringify(args)]) as {
    data?: { result?: Record<string, unknown> };
    error?: { message?: string };
  };
  const result = res.data?.result;
  if (!result || result.status === 'blocked') {
    return { ok: false as const, reason: String(result?.message ?? res.error?.message ?? 'blocked') };
  }
  const candidate = result.exportCandidate as { candidateId?: string } | undefined;
  const preview = result.preview as { rows?: unknown[] } | undefined;
  if (!candidate?.candidateId) {
    return {
      ok: false as const,
      reason: `no exportCandidate (status=${String(result.status)}, rows=${preview?.rows?.length ?? 0})`,
    };
  }
  return {
    ok: true as const,
    candidateId: candidate.candidateId,
    previewRows: preview?.rows?.length ?? 0,
    operation: String((args as { operation?: string }).operation ?? 'semrush'),
  };
}

function invokeDataExport(args: Record<string, unknown>) {
  turnBegin();
  const res = seat(['invoke', 'dataExport', JSON.stringify(args)]) as {
    data?: { result?: Record<string, unknown> };
    error?: { message?: string };
  };
  return res.data?.result ?? { status: 'error', message: res.error?.message };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const results: StepResult[] = [];
  const log = (step: string, ok: boolean, detail: string, data?: unknown) => {
    results.push({ step, ok, detail, data });
    console.error(`[multitab] ${ok ? '✓' : '✗'} ${step}: ${detail}`);
  };

  console.error(`[multitab] Backlinks targets: ${BACKLINK_TARGETS.length}`);
  console.error(`[multitab] Overview tabs: ${OVERVIEW_DOMAINS.length}`);

  const backlinks = invokeSemrush({
    operation: 'backlinks_comparison',
    targets: [...BACKLINK_TARGETS],
  });
  if (!backlinks.ok) {
    log('semrush.backlinks_comparison', false, backlinks.reason);
    printSummary(results);
    process.exit(1);
  }
  log(
    'semrush.backlinks_comparison',
    true,
    `${BACKLINK_TARGETS.length} targets → candidate ${backlinks.candidateId} (${backlinks.previewRows} preview rows)`,
  );

  const overviewCandidates: Array<{ domain: string; candidateId: string }> = [];
  for (const domain of OVERVIEW_DOMAINS) {
    const overview = invokeSemrush({
      operation: 'domain_overview',
      domain,
      database: 'in',
    });
    if (!overview.ok) {
      log(`semrush.domain_overview.${domain}`, false, overview.reason);
      continue;
    }
    overviewCandidates.push({ domain, candidateId: overview.candidateId });
    log(`semrush.domain_overview.${domain}`, true, `candidate ${overview.candidateId}`);
  }

  if (overviewCandidates.length === 0) {
    log('semrush.overview_batch', false, 'no overview candidates');
    printSummary(results);
    process.exit(1);
  }

  const allIds = [backlinks.candidateId, ...overviewCandidates.map(o => o.candidateId)];

  const ambiguous = invokeDataExport({
    op: 'plan',
    datasets: allIds.map(id => ({ candidateId: id })),
    destination: { format: 'xlsx', title: 'Semrush workbook — no tabs (should fail)' },
    userIntent: 'explicit_export',
  }) as { status?: string; message?: string };
  const ambiguousOk = ambiguous.status === 'ambiguous';
  log(
    'plan.without_tabName',
    ambiguousOk,
    ambiguousOk ? 'correctly blocked mixed shapes' : String(ambiguous.message ?? ambiguous.status),
    ambiguous,
  );

  const datasets = [
    { candidateId: backlinks.candidateId, tabName: 'Backlinks (10 domains)' },
    ...overviewCandidates.map(o => ({
      candidateId: o.candidateId,
      tabName: `Overview — ${o.domain}`,
    })),
  ];

  const plan = invokeDataExport({
    op: 'plan',
    datasets,
    destination: {
      format: 'xlsx',
      title: `Semrush competitive workbook — ${BACKLINK_TARGETS.length}+${overviewCandidates.length} tabs`,
    },
    userIntent: 'explicit_export',
  }) as {
    status?: string;
    success?: boolean;
    planId?: string;
    exportJobId?: string;
    exportQueued?: boolean;
    sampleRows?: number;
    reason?: string;
    message?: string;
  };

  const planId = plan.planId;
  const directQueued = plan.status === 'direct_queue' || plan.exportQueued === true;
  if (directQueued) {
    log(
      'plan.with_tabName',
      true,
      `${datasets.length} tabs → direct_queue${plan.exportJobId ? ` (job ${plan.exportJobId})` : ''}`,
      { tabCount: datasets.length, exportJobId: plan.exportJobId, planId },
    );
    console.error('[multitab] waiting 90s for full export worker + delivery…');
    await sleep(90_000);
    printSummary(results);
    console.log(JSON.stringify({
      summary: {
        backlinkTargets: BACKLINK_TARGETS.length,
        overviewTabs: overviewCandidates.length,
        totalTabs: datasets.length,
        planId,
        exportJobId: plan.exportJobId,
      },
      results,
    }, null, 2));
    return;
  }

  if (plan.status !== 'sample_required' || !planId) {
    log('plan.with_tabName', false, String(plan.message ?? plan.status), plan);
    printSummary(results);
    process.exit(1);
  }
  log(
    'plan.with_tabName',
    true,
    `${datasets.length} tabs → sample_required (${plan.reason ?? 'large_or_unknown'})`,
    { tabCount: datasets.length, sampleRows: plan.sampleRows, reason: plan.reason },
  );

  const sample = invokeDataExport({ op: 'sample', planId }) as {
    status?: string;
    success?: boolean;
    sampleRunId?: string;
    exportJobId?: string;
    message?: string;
  };
  if (sample.status !== 'sample_queued' && !sample.success) {
    log('sample.queue', false, String(sample.message ?? sample.status), sample);
    printSummary(results);
    process.exit(1);
  }
  log('sample.queue', true, `sample job ${sample.exportJobId ?? 'queued'}`, sample);

  console.error('[multitab] waiting 90s for sample worker + delivery…');
  await sleep(90_000);

  const confirm = invokeDataExport({
    op: 'confirm_sample',
    sampleRunId: planId,
  }) as { status?: string; success?: boolean; exportJobId?: string; message?: string };
  const confirmOk = confirm.status === 'full_queued' || (confirm.success === true && Boolean(confirm.exportJobId));
  log(
    'confirm_sample',
    confirmOk,
    confirmOk ? `full export ${confirm.exportJobId}` : String(confirm.message ?? confirm.status),
    confirm,
  );

  printSummary(results);
  console.log(JSON.stringify({
    summary: {
      backlinkTargets: BACKLINK_TARGETS.length,
      overviewTabs: overviewCandidates.length,
      totalTabs: datasets.length,
      planId,
      sampleJobId: sample.exportJobId,
      fullJobId: confirm.exportJobId,
    },
    results,
  }, null, 2));
}

function printSummary(results: readonly StepResult[]): void {
  console.error('\n── Multi-tab Semrush export test ──');
  for (const row of results) {
    console.error(`${row.ok ? '✓' : '✗'} ${row.step.padEnd(36)} ${row.detail}`);
  }
  console.error(`── ${results.filter(r => r.ok).length}/${results.length} passed ──\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
