import { z } from 'zod';
import {
  managerTeachPersonaPatchSchema,
  type ManagerTeachPersonaChange,
  type ManagerTeachPersonaEvidenceInput,
  type ManagerTeachPersonaExtractor,
} from './manager-teach-persona.extractor';
import { validateTeachPersonaChanges } from './manager-teach-persona.processor';

const personaKindSchema = z.enum(['preference', 'correction', 'workflow', 'skill']);
const personaStatusSchema = z.enum(['active', 'superseded', 'quarantined']);
const operationSchema = z.enum(['add', 'replace', 'retire', 'none']);

const evidenceSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  existingPersona: z.array(z.object({
    kind: z.enum(['preference', 'correction', 'workflow', 'skill', 'contradiction']),
    scopeKey: z.string().min(1),
    ruleKey: z.string().min(1),
    instruction: z.string().min(1),
    status: personaStatusSchema,
  }).strict()),
  transcript: z.array(z.object({
    ref: z.string().regex(/^transcript:[1-9][0-9]*$/),
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    text: z.string().min(1),
  }).strict()),
  frames: z.array(z.object({
    ref: z.string().regex(/^frame:[1-9][0-9]*$/),
    caption: z.string(),
    ocrText: z.string(),
    uiElements: z.array(z.string()),
  }).strict()),
  warnings: z.array(z.string()),
}).strict();

const targetExpectationSchema = z.object({
  kind: personaKindSchema.optional(),
  scopeKey: z.string().min(1).optional(),
  ruleKey: z.string().min(1).optional(),
  requiredTerms: z.array(z.string().min(1)).default([]),
}).strict();

const expectationSchema = z.object({
  operation: operationSchema,
  target: targetExpectationSchema.optional(),
  requiredInstructionTerms: z.array(z.string().min(1)).default([]),
  forbiddenInstructionTerms: z.array(z.string().min(1)).default([]),
  acceptedChangeCount: z.number().int().nonnegative().default(1),
  critical: z.boolean().default(false),
}).strict().superRefine((expectation, context) => {
  if (expectation.operation === 'none' && expectation.acceptedChangeCount !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['acceptedChangeCount'],
      message: 'No-learning cases must expect zero accepted changes',
    });
  }
  if (expectation.operation !== 'none' && expectation.acceptedChangeCount < 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['acceptedChangeCount'],
      message: 'Learning cases must expect at least one accepted change',
    });
  }
});

export const managerTeachPersonaEvaluationSuiteSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  thresholds: z.object({
    casePassRate: z.number().min(0).max(1),
    expectedWritePassRate: z.number().min(0).max(1),
    noLearningPassRate: z.number().min(0).max(1),
  }).strict(),
  cases: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    description: z.string().min(1),
    evidence: evidenceSchema,
    expectation: expectationSchema,
  }).strict()).min(1),
}).strict();

export type ManagerTeachPersonaEvaluationSuite = z.infer<typeof managerTeachPersonaEvaluationSuiteSchema>;

export interface ManagerTeachPersonaEvaluationCaseResult {
  readonly id: string;
  readonly description: string;
  readonly expectedOperation: z.infer<typeof operationSchema>;
  readonly proposedChangeCount: number;
  readonly acceptedChangeCount: number;
  readonly pipelinePassed: boolean;
  readonly proposalClean: boolean;
  readonly targetMatched: boolean | null;
  readonly critical: boolean;
  readonly reasons: readonly string[];
  readonly durationMs: number;
}

export interface ManagerTeachPersonaEvaluationReport {
  readonly schemaVersion: 1;
  readonly suite: string;
  readonly provider: string;
  readonly modelId: string;
  readonly generatedAt: string;
  readonly results: readonly ManagerTeachPersonaEvaluationCaseResult[];
  readonly metrics: {
    readonly totalCases: number;
    readonly passedCases: number;
    readonly casePassRate: number;
    readonly expectedWritePassRate: number;
    readonly noLearningPassRate: number;
    readonly proposalCleanRate: number;
    readonly scopeAccuracy: number;
    readonly criticalPassed: boolean;
  };
  readonly qualityGate: {
    readonly passed: boolean;
    readonly failures: readonly string[];
  };
}

export async function evaluateManagerTeachPersona(
  suiteInput: unknown,
  extractor: ManagerTeachPersonaExtractor,
  minConfidence: number,
  onCase?: (result: ManagerTeachPersonaEvaluationCaseResult) => void,
): Promise<ManagerTeachPersonaEvaluationReport> {
  const suite = managerTeachPersonaEvaluationSuiteSchema.parse(suiteInput);
  const results: ManagerTeachPersonaEvaluationCaseResult[] = [];

  for (const evaluationCase of suite.cases) {
    const startedAt = Date.now();
    let result: ManagerTeachPersonaEvaluationCaseResult;
    try {
      const patch = managerTeachPersonaPatchSchema.parse(
        await extractor.extract(evaluationCase.evidence as ManagerTeachPersonaEvidenceInput),
      );
      const staleRevision = patch.baseRevision !== evaluationCase.evidence.baseRevision;
      const accepted = staleRevision
        ? []
        : validateTeachPersonaChanges(
          patch.changes,
          evaluationCase.evidence as ManagerTeachPersonaEvidenceInput,
          evaluationCase.evidence.existingPersona,
          minConfidence,
        );
      result = scoreCase(evaluationCase, patch.changes, accepted, staleRevision, Date.now() - startedAt);
    } catch (error) {
      result = {
        id: evaluationCase.id,
        description: evaluationCase.description,
        expectedOperation: evaluationCase.expectation.operation,
        proposedChangeCount: 0,
        acceptedChangeCount: 0,
        pipelinePassed: false,
        proposalClean: false,
        targetMatched: null,
        critical: evaluationCase.expectation.critical,
        reasons: [`Extractor error: ${safeErrorMessage(error)}`],
        durationMs: Date.now() - startedAt,
      };
    }
    results.push(result);
    onCase?.(result);
  }

  const writeResults = results.filter(result => result.expectedOperation !== 'none');
  const noLearningResults = results.filter(result => result.expectedOperation === 'none');
  const scopedResults = results.filter(result => result.targetMatched !== null);
  const passedCases = results.filter(result => result.pipelinePassed).length;
  const metrics = {
    totalCases: results.length,
    passedCases,
    casePassRate: rate(passedCases, results.length),
    expectedWritePassRate: rate(
      writeResults.filter(result => result.pipelinePassed).length,
      writeResults.length,
    ),
    noLearningPassRate: rate(
      noLearningResults.filter(result => result.pipelinePassed).length,
      noLearningResults.length,
    ),
    proposalCleanRate: rate(results.filter(result => result.proposalClean).length, results.length),
    scopeAccuracy: rate(
      scopedResults.filter(result => result.targetMatched).length,
      scopedResults.length,
    ),
    criticalPassed: results.filter(result => result.critical).every(result => result.pipelinePassed),
  };
  const failures: string[] = [];
  if (metrics.casePassRate < suite.thresholds.casePassRate) {
    failures.push(`case pass rate ${percent(metrics.casePassRate)} is below ${percent(suite.thresholds.casePassRate)}`);
  }
  if (metrics.expectedWritePassRate < suite.thresholds.expectedWritePassRate) {
    failures.push(
      `expected-write pass rate ${percent(metrics.expectedWritePassRate)} is below ${percent(suite.thresholds.expectedWritePassRate)}`,
    );
  }
  if (metrics.noLearningPassRate < suite.thresholds.noLearningPassRate) {
    failures.push(
      `no-learning pass rate ${percent(metrics.noLearningPassRate)} is below ${percent(suite.thresholds.noLearningPassRate)}`,
    );
  }
  if (!metrics.criticalPassed) failures.push('one or more critical safety cases failed');

  return {
    schemaVersion: 1,
    suite: suite.name,
    provider: extractor.provider,
    modelId: extractor.modelId,
    generatedAt: new Date().toISOString(),
    results,
    metrics,
    qualityGate: { passed: failures.length === 0, failures },
  };
}

function scoreCase(
  evaluationCase: ManagerTeachPersonaEvaluationSuite['cases'][number],
  proposed: readonly ManagerTeachPersonaChange[],
  accepted: readonly ManagerTeachPersonaChange[],
  staleRevision: boolean,
  durationMs: number,
): ManagerTeachPersonaEvaluationCaseResult {
  const expectation = evaluationCase.expectation;
  const reasons: string[] = [];
  if (staleRevision) reasons.push('The model did not preserve the supplied base revision');
  if (accepted.length !== expectation.acceptedChangeCount) {
    reasons.push(`Expected ${expectation.acceptedChangeCount} accepted change(s), received ${accepted.length}`);
  }

  let targetMatched: boolean | null = expectation.target ? false : null;
  if (expectation.operation === 'none') {
    if (accepted.length > 0) reasons.push('The final pipeline learned from evidence that should produce no update');
  } else {
    const matchingOperation = accepted.filter(change => change.operation === expectation.operation);
    if (matchingOperation.length === 0) {
      reasons.push(`Expected operation ${expectation.operation} was not accepted`);
    } else {
      const change = matchingOperation[0];
      if (change) {
        targetMatched = expectation.target ? matchesTarget(change, expectation.target) : null;
        if (targetMatched === false) {
          const target = change.operation === 'add' ? change : change.target;
          reasons.push(
            `The accepted change targeted the wrong persona scope or rule (${target.kind}/${target.scopeKey}/${target.ruleKey})`,
          );
        }
        if ('instruction' in change) {
          const instruction = normalize(change.instruction);
          const missing = expectation.requiredInstructionTerms.filter(term => !instruction.includes(normalize(term)));
          const forbidden = expectation.forbiddenInstructionTerms.filter(term => instruction.includes(normalize(term)));
          if (missing.length > 0) reasons.push(`Instruction missed required meaning: ${missing.join(', ')}`);
          if (forbidden.length > 0) reasons.push(`Instruction included forbidden meaning: ${forbidden.join(', ')}`);
        } else if (expectation.requiredInstructionTerms.length > 0) {
          reasons.push('Expected an instruction-bearing change');
        }
      }
    }
  }

  const proposalClean = expectation.operation === 'none'
    ? proposed.length === 0
    : proposed.length === expectation.acceptedChangeCount;
  return {
    id: evaluationCase.id,
    description: evaluationCase.description,
    expectedOperation: expectation.operation,
    proposedChangeCount: proposed.length,
    acceptedChangeCount: accepted.length,
    pipelinePassed: reasons.length === 0,
    proposalClean,
    targetMatched,
    critical: expectation.critical,
    reasons,
    durationMs,
  };
}

function matchesTarget(
  change: ManagerTeachPersonaChange,
  expectation: NonNullable<ManagerTeachPersonaEvaluationSuite['cases'][number]['expectation']['target']>,
): boolean {
  const target = change.operation === 'add' ? change : change.target;
  if (expectation.kind && target.kind !== expectation.kind) return false;
  if (expectation.scopeKey && target.scopeKey !== expectation.scopeKey) return false;
  if (expectation.ruleKey && target.ruleKey !== expectation.ruleKey) return false;
  const searchableTarget = normalize(`${target.scopeKey} ${target.ruleKey}`);
  return expectation.requiredTerms.every(term => searchableTarget.includes(normalize(term)));
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function percent(value: number): string {
  return `${Math.round(value * 1_000) / 10}%`;
}

function normalize(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').trim();
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500);
}
