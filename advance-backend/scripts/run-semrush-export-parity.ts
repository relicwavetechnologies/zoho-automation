#!/usr/bin/env tsx
/**
 * Agent Seat parity runner: 3 Semrush ops × 3 export formats.
 * Usage: cd advance-backend && pnpm tsx scripts/run-semrush-export-parity.ts
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts/agent-seat.ts');

type Format = 'google_sheet' | 'csv' | 'xlsx';

interface SemrushCase {
  readonly op: string;
  readonly args: Record<string, unknown>;
  readonly title: string;
}

const CASES: readonly SemrushCase[] = [
  {
    op: 'domain_overview',
    args: { operation: 'domain_overview', domain: 'emiactech.com', database: 'in' },
    title: 'Semrush domain overview emiactech',
  },
  {
    op: 'backlinks_comparison',
    args: {
      operation: 'backlinks_comparison',
      targets: ['emiactech.com', 'decentro.tech', 'policyholder.gov.in'],
    },
    title: 'Semrush backlinks 3 domains',
  },
  {
    op: 'keyword_position_trend',
    args: {
      operation: 'keyword_position_trend',
      domain: 'decentro.tech',
      keyword: 'api',
      date: '20260115',
      database: 'in',
    },
    title: 'Semrush keyword trend decentro api',
  },
];

const FORMATS: readonly Format[] = ['google_sheet', 'csv', 'xlsx'];

function extractLastJson(text: string): unknown {
  const marker = text.lastIndexOf('\n{');
  const start = marker >= 0 ? marker + 1 : text.lastIndexOf('{');
  if (start < 0) throw new Error(`No JSON in agent-seat output: ${text.slice(-500)}`);
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error(`Incomplete JSON in agent-seat output: ${text.slice(-500)}`);
}

function seat(args: string[]): unknown {
  const result = spawnSync('pnpm', ['tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0 && !combined.includes('{')) {
    throw new Error(`agent-seat ${args.join(' ')} failed: ${combined.slice(-800)}`);
  }
  return extractLastJson(combined);
}

function turnBegin(): void {
  seat(['turn', 'begin']);
}

function invokeSemrush(args: Record<string, unknown>) {
  turnBegin();
  const res = seat(['invoke', 'semrush', JSON.stringify(args)]) as {
    ok?: boolean;
    data?: { result?: Record<string, unknown> };
    error?: { message?: string };
  };
  const result = res.data?.result;
  if (!result || result.status === 'blocked') {
    return { ok: false as const, reason: String(result?.message ?? res.error?.message ?? 'blocked') };
  }
  const candidate = result.exportCandidate as { candidateId?: string } | undefined;
  if (!candidate?.candidateId) {
    return { ok: false as const, reason: String(result.message ?? 'no exportCandidate') };
  }
  return {
    ok: true as const,
    candidateId: candidate.candidateId,
    previewRows: (result.preview as { rows?: unknown[] } | undefined)?.rows?.length ?? 0,
  };
}

function invokePlan(candidateId: string, format: Format, title: string) {
  turnBegin();
  const res = seat([
    'invoke',
    'dataExport',
    JSON.stringify({
      op: 'plan',
      datasets: [{ candidateId }],
      destination: { format, title: `${title} (${format})` },
      userIntent: 'explicit_export',
    }),
  ]) as {
    data?: { result?: Record<string, unknown> };
    error?: { message?: string };
  };
  const result = res.data?.result;
  if (result?.success && result.exportJobId) {
    return { ok: true as const, exportJobId: String(result.exportJobId) };
  }
  return {
    ok: false as const,
    reason: String(result?.reason ?? result?.message ?? res.error?.message ?? 'plan failed'),
    status: String(result?.status ?? 'error'),
  };
}

async function main(): Promise<void> {
  const results: Array<Record<string, unknown>> = [];
  for (const testCase of CASES) {
    console.error(`[parity] semrush ${testCase.op}...`);
    const semrush = invokeSemrush(testCase.args);
    results.push({ op: testCase.op, semrush });
    if (!semrush.ok) {
      for (const format of FORMATS) {
        results.push({ op: testCase.op, format, export: { ok: false, skipped: true, reason: semrush.reason } });
      }
      continue;
    }
    for (const format of FORMATS) {
      console.error(`[parity] export ${testCase.op} -> ${format}...`);
      const plan = invokePlan(semrush.candidateId, format, testCase.title);
      results.push({ op: testCase.op, format, export: plan, candidateId: semrush.candidateId });
    }
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
