import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDeepSeek } from '@ai-sdk/deepseek';
import {
  evaluateManagerTeachPersona,
  managerTeachPersonaEvaluationSuiteSchema,
  type ManagerTeachPersonaEvaluationCaseResult,
} from '../src/application/persona-learning/manager-teach-persona.evaluation';
import { DeepSeekManagerTeachPersonaExtractor } from '../src/application/persona-learning/manager-teach-persona.extractor';

const DEFAULT_FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/manager-teach-persona-eval.json', import.meta.url),
);

async function main(): Promise<void> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required to run the live Teach evaluation');

  const fixturePath = argumentValue('--fixture') ?? DEFAULT_FIXTURE_PATH;
  const jsonOutput = process.argv.includes('--json');
  const fullSuite = managerTeachPersonaEvaluationSuiteSchema.parse(
    JSON.parse(await readFile(fixturePath, 'utf8')) as unknown,
  );
  const requestedCases = argumentValue('--case')?.split(',').map(value => value.trim()).filter(Boolean);
  const suite = requestedCases?.length
    ? {
      ...fullSuite,
      cases: fullSuite.cases.filter(evaluationCase => requestedCases.includes(evaluationCase.id)),
    }
    : fullSuite;
  if (suite.cases.length === 0) {
    throw new Error(`No evaluation cases matched --case=${requestedCases?.join(',') ?? ''}`);
  }
  const modelId = process.env.MANAGER_TEACH_PERSONA_MODEL?.trim() || 'deepseek-v4-pro';
  const timeoutSeconds = positiveNumber(process.env.MANAGER_TEACH_PERSONA_TIMEOUT_SECONDS, 300);
  const minConfidence = unitInterval(process.env.MANAGER_TEACH_PERSONA_MIN_CONFIDENCE, 0.9);
  const deepSeek = createDeepSeek({
    apiKey,
    ...(process.env.DEEPSEEK_BASE_URL?.trim()
      ? { baseURL: process.env.DEEPSEEK_BASE_URL.trim() }
      : {}),
  });
  const extractor = new DeepSeekManagerTeachPersonaExtractor(
    deepSeek(modelId),
    modelId,
    timeoutSeconds * 1_000,
  );

  if (!jsonOutput) {
    process.stdout.write(`Evaluating ${suite.cases.length} Teach cases with ${modelId}\n`);
  }
  const report = await evaluateManagerTeachPersona(
    suite,
    extractor,
    minConfidence,
    jsonOutput ? undefined : printCase,
  );

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const metrics = report.metrics;
    process.stdout.write('\nTeach evaluation summary\n');
    process.stdout.write(`  Pipeline: ${metrics.passedCases}/${metrics.totalCases} (${percent(metrics.casePassRate)})\n`);
    process.stdout.write(`  Expected writes: ${percent(metrics.expectedWritePassRate)}\n`);
    process.stdout.write(`  No-learning: ${percent(metrics.noLearningPassRate)}\n`);
    process.stdout.write(`  Scope accuracy: ${percent(metrics.scopeAccuracy)}\n`);
    process.stdout.write(`  Clean model proposals: ${percent(metrics.proposalCleanRate)}\n`);
    process.stdout.write(`  Critical safety: ${metrics.criticalPassed ? 'PASS' : 'FAIL'}\n`);
    process.stdout.write(`  Quality gate: ${report.qualityGate.passed ? 'PASS' : 'FAIL'}\n`);
    for (const failure of report.qualityGate.failures) process.stdout.write(`    - ${failure}\n`);
  }

  if (!report.qualityGate.passed) process.exitCode = 1;
}

function printCase(result: ManagerTeachPersonaEvaluationCaseResult): void {
  const status = result.pipelinePassed ? 'PASS' : 'FAIL';
  process.stdout.write(
    `[${status}] ${result.id} (${result.durationMs}ms, proposed ${result.proposedChangeCount}, accepted ${result.acceptedChangeCount})\n`,
  );
  for (const reason of result.reasons) process.stdout.write(`       ${reason}\n`);
}

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function unitInterval(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function percent(value: number): string {
  return `${Math.round(value * 1_000) / 10}%`;
}

main().catch(error => {
  process.stderr.write(`Teach evaluation failed: ${safeErrorMessage(error)}\n`);
  process.exitCode = 2;
});

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 1_000);
}
