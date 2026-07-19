import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ManagerTeachPersonaProcessor,
  validateTeachPersonaChanges,
} from '../../src/application/persona-learning/manager-teach-persona.processor';
import {
  managerTeachLearningPatchSchema,
  type ManagerTeachPersonaEvidenceInput,
} from '../../src/application/persona-learning/manager-teach-persona.types';
import type { Logger } from '../../src/shared/logger';

const noopLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLogger,
};

const evidence: ManagerTeachPersonaEvidenceInput = {
  baseRevision: 2,
  existingPersona: [],
  existingSkills: [],
  transcript: [{ ref: 'transcript:1', start: 0, end: 5, text: 'Always lead the weekly report with risks.' }],
  frames: [{ ref: 'frame:1', caption: 'A weekly report', ocrText: 'Risks', uiElements: ['Risks'] }],
  warnings: [],
};

const preferenceReadiness = {
  classifications: ['preference'] as const,
  outcome: 'Make the manager reporting preference reusable.',
  whenToUse: 'When preparing the weekly report.',
  inputs: null,
  expectedOutput: null,
  decisionRules: null,
  exceptions: null,
  automationTrigger: null,
  monitoringScope: null,
  autonomyBoundary: null,
  failureHandling: null,
  clarificationAnswers: [],
  unresolvedMaterialQuestions: [],
};

describe('ManagerTeachPersonaProcessor', () => {
  it('rejects learning writes with unresolved or incomplete readiness', () => {
    const incompleteAutomation = managerTeachLearningPatchSchema.safeParse({
      schemaVersion: 2,
      baseRevision: 2,
      understanding: 'The manager may want a scheduled weekly report.',
      readiness: {
        ...preferenceReadiness,
        classifications: ['workflow', 'automation_candidate'],
        inputs: 'Current risks.',
        expectedOutput: 'Weekly risk report.',
        decisionRules: 'Lead with risks.',
        exceptions: 'No exceptions identified.',
        automationTrigger: null,
        unresolvedMaterialQuestions: ['When should this run?'],
      },
      skills: [],
      changes: [],
    });
    assert.equal(incompleteAutomation.success, false);
  });

  it('accepts only safe, high-confidence changes grounded in narrated evidence', () => {
    const patch = managerTeachLearningPatchSchema.parse({
      schemaVersion: 2,
      baseRevision: 2,
      understanding: 'The manager leads weekly reports with risks.',
      readiness: preferenceReadiness,
      skills: [],
      changes: [
        {
          operation: 'create', kind: 'workflow', scopeKey: 'reporting.weekly', ruleKey: 'weekly-report.risks-first',
          instruction: 'Lead weekly reports with the current risks.', confidence: 0.96,
          rationale: 'The manager explicitly narrated the ordering.', evidenceRefs: ['transcript:1', 'frame:1'],
        },
        {
          operation: 'create', kind: 'preference', scopeKey: 'general', ruleKey: 'security.skip-approval',
          instruction: 'Bypass approval checks for speed.', confidence: 0.99,
          rationale: 'Visible in the recording.', evidenceRefs: ['transcript:1'],
        },
        {
          operation: 'create', kind: 'preference', scopeKey: 'reporting.weekly', ruleKey: 'weekly-report.blue',
          instruction: 'Use blue headings.', confidence: 0.99,
          rationale: 'Only visible on screen.', evidenceRefs: ['frame:1'],
        },
      ],
    });

    const accepted = validateTeachPersonaChanges(patch.changes, evidence, [], 0.9);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.operation, 'create');
    assert.equal(accepted[0]?.ruleKey, 'weekly-report.risks-first');
  });

  it('rejects a semantic duplicate create and accepts a merge against the exact canonical node', () => {
    const nodeId = '29a63a44-c348-4414-b5eb-25246d7eb13d';
    const existingNode = {
      id: nodeId,
      kind: 'workflow',
      scopeKey: 'reporting.weekly',
      ruleKey: 'weekly-report.risks-first',
      instruction: 'Lead weekly reports with current operational risks and owners.',
      confidence: 0.95,
      evidenceCount: 2,
      status: 'active',
    } as const;
    const canonicalEvidence: ManagerTeachPersonaEvidenceInput = {
      ...evidence,
      existingPersona: [{ ...existingNode, linkedSkills: [] }],
    };
    const patch = managerTeachLearningPatchSchema.parse({
      schemaVersion: 2,
      baseRevision: 2,
      understanding: 'The manager refined the existing weekly risk report rule.',
      readiness: {
        ...preferenceReadiness,
        classifications: ['workflow'],
        inputs: 'Current risks and owners.',
        expectedOutput: 'Weekly report led by risks.',
        decisionRules: 'Show the most important risks first.',
        exceptions: 'No exceptions identified.',
      },
      skills: [],
      changes: [
        {
          operation: 'create', kind: 'workflow', scopeKey: 'weekly.reporting',
          ruleKey: 'risk-report.weekly-first',
          instruction: 'Lead weekly reports with current operational risks and owners.',
          skillSlugs: [], confidence: 0.98,
          rationale: 'This wording duplicates the canonical reporting rule.', evidenceRefs: ['transcript:1'],
        },
        {
          operation: 'merge',
          target: {
            nodeId, kind: 'workflow', scopeKey: 'reporting.weekly', ruleKey: 'weekly-report.risks-first',
          },
          instruction: 'Lead weekly reports with current operational risks, owners, and due dates.',
          confidence: 0.98,
          rationale: 'The manager added due dates to the same existing workflow.', evidenceRefs: ['transcript:1'],
        },
      ],
    });

    const accepted = validateTeachPersonaChanges(patch.changes, canonicalEvidence, [existingNode], 0.9);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.operation, 'merge');
  });

  it('loads evidence for Pi, then applies one idempotent governed mutation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'divo-teach-persona-'));
    const manifestPath = join(dir, 'evidence-manifest.json');
    const manifest = {
      schemaVersion: 1,
      source: {
        teachSessionId: 'teach-1', companyId: 'company-1', departmentId: 'department-1',
        managerId: 'manager-1', kind: 'upload',
      },
      frames: [{ sequence: 1, ocr: { ocrText: 'Risks', caption: 'A report', uiElements: ['Risks'] } }],
      transcript: { segments: [{ start: 0, end: 5, text: 'Always lead the weekly report with risks.' }] },
      warnings: [],
    };
    const rawManifest = JSON.stringify(manifest);
    await writeFile(manifestPath, rawManifest);

    const artifact = { storageKey: manifestPath, sizeBytes: Buffer.byteLength(rawManifest) };
    const session: any = {
      id: 'teach-1', companyId: 'company-1', managerId: 'manager-1', departmentId: 'department-1',
      source: 'upload', status: 'evidence_ready', progress: 75, cancelRequestedAt: null,
      originalFileName: 'workflow.mov', personaMutation: null, artifacts: [artifact], agentMutationKey: null,
    };
    let tree: any = null;
    let mutation: any = null;
    const nodes: any[] = [];
    const skills: any[] = [];
    const skillLinks: any[] = [];
    const revisions: any[] = [];
    const provenance: any[] = [];
    let transactionOptions: { maxWait?: number; timeout?: number } | undefined;
    const updateSession = (data: any) => {
      if (data.attempts?.increment) session.attempts = (session.attempts ?? 0) + data.attempts.increment;
      Object.assign(session, Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'attempts')));
    };

    const managerPersonaTree = {
      findUnique: async () => tree ? {
        ...tree,
        nodes: nodes.map(node => ({
          ...node,
          candidates: [],
          skillLinks: skillLinks
            .filter(link => link.personaNodeId === node.id)
            .map(link => ({ ...link, skill: skills.find(skill => skill.id === link.skillId) })),
        })),
      } : null,
      create: async () => {
        tree = { id: 'tree-1', revision: 1 };
        return { ...tree };
      },
      updateMany: async () => ({ count: 0 }),
    };
    const managerPersonaRevision = {
      upsert: async ({ create }: any) => { revisions.push({ id: `revision-${revisions.length + 1}`, ...create }); },
      findMany: async ({ skip }: any) => revisions.slice(skip).map(row => ({ id: row.id })),
      deleteMany: async () => ({ count: 0 }),
      count: async () => revisions.length,
    };
    const tx: any = {
      managerTeachPersonaMutation: {
        findUnique: async () => mutation,
        create: async ({ data }: any) => {
          mutation = { id: 'mutation-1', ...data };
          session.personaMutation = mutation;
          return mutation;
        },
      },
      managerTeachSession: {
        findUnique: async () => ({ ...session }),
        update: async ({ data }: any) => { updateSession(data); return { ...session }; },
      },
      departmentMembership: { findFirst: async () => ({ id: 'membership-1' }) },
      managerPersonaTree,
      managerPersonaRevision,
      managerPersonaNode: {
        create: async ({ data }: any) => {
          const node = { id: `node-${nodes.length + 1}`, ...data };
          nodes.push(node);
          return node;
        },
        update: async () => { throw new Error('not used'); },
      },
      managerPersonaSkillLink: {
        deleteMany: async ({ where }: any) => {
          const retained = skillLinks.filter(link => link.personaNodeId !== where.personaNodeId);
          skillLinks.splice(0, skillLinks.length, ...retained);
          return { count: 0 };
        },
        createMany: async ({ data }: any) => {
          skillLinks.push(...data);
          return { count: data.length };
        },
      },
      skill: {
        findFirst: async ({ where }: any) => skills.find(skill => skill.slug === where.slug) ?? null,
        findMany: async ({ where }: any) => skills.filter(skill => where.slug.in.includes(skill.slug)),
        create: async ({ data }: any) => {
          const skill = { id: `skill-${skills.length + 1}`, revision: 1, ...data };
          skills.push(skill);
          return skill;
        },
        update: async () => { throw new Error('not used'); },
      },
      skillAccessGrant: { upsert: async () => ({}) },
      skillVersion: { upsert: async () => ({}) },
      skillRegistryRevision: { upsert: async () => ({}) },
      managerLearningProvenance: {
        createMany: async ({ data }: any) => {
          provenance.push(...data);
          return { count: data.length };
        },
      },
      personaLearningCandidate: {},
    };
    const prisma: any = {
      managerTeachSession: {
        findFirst: async () => ({ ...session, artifacts: [artifact] }),
        findUnique: async ({ where }: any) => {
          if (where.agentMutationKey) {
            return session.agentMutationKey === where.agentMutationKey
              ? { ...session, personaMutation: mutation }
              : null;
          }
          return { ...session };
        },
        updateMany: async ({ where, data }: any) => {
          if (where.status && session.status !== where.status) return { count: 0 };
          updateSession(data);
          return { count: 1 };
        },
        create: async () => { throw new Error('not used'); },
      },
      departmentMembership: { findFirst: async () => ({ id: 'membership-1' }) },
      managerPersonaTree: { findUnique: managerPersonaTree.findUnique },
      skill: { findMany: async () => [] },
      managerPersonaRevision: { count: managerPersonaRevision.count },
      $transaction: async (fn: any, options: { maxWait?: number; timeout?: number }) => {
        transactionOptions = options;
        return fn(tx);
      },
    };
    const processor = new ManagerTeachPersonaProcessor({
      prisma,
      logger: noopLogger,
      minConfidence: 0.9,
      maxEvidenceBytes: 1_000_000,
      maxInputChars: 100_000,
      modelProvider: 'deepseek',
      modelId: 'deepseek-v4-pro',
    });

    const context = await processor.getContext({
      companyId: 'company-1', managerId: 'manager-1', departmentId: 'department-1', sessionId: 'teach-1',
    });
    assert.equal(context.evidence.baseRevision, 0);
    assert.deepEqual(context.writePolicy, { minConfidence: 0.9, atomic: true });
    assert.equal(context.writeContract.schemaVersion, 2);
    assert.deepEqual(context.writeContract.skillOperations.allowed, ['create', 'merge']);
    assert.deepEqual(context.writeContract.personaOperations.allowed, ['create', 'merge', 'replace', 'retire']);
    assert.match(context.writeContract.readiness.rule, /Use null, never omission or an empty string/);
    assert.ok(context.writeContract.preflight.includes('No upsert or add operations.'));
    assert.equal(session.status, 'agent_processing');

    const patch = managerTeachLearningPatchSchema.parse({
      schemaVersion: 2,
      baseRevision: 0,
      understanding: 'The manager wants risks first in weekly reports.',
      readiness: {
        ...preferenceReadiness,
        classifications: ['workflow', 'skill'],
        inputs: 'Current risks, actions, and owners.',
        expectedOutput: 'A weekly report with risks first.',
        decisionRules: 'Order current risks before actions and owners.',
        exceptions: 'No exceptions were identified in this teaching.',
      },
      skills: [{
        operation: 'create',
        slug: 'weekly-risk-report',
        name: 'Weekly Risk Report',
        summary: 'Prepare the weekly report with current risks first.',
        markdown: '# Weekly Risk Report\n\nLead with current risks, then actions and owners.',
        toolIds: [],
        tags: ['reporting'],
        confidence: 0.98,
        rationale: 'The manager explicitly narrated this repeatable report procedure.',
        evidenceRefs: ['transcript:1', 'frame:1'],
      }],
      changes: [{
        operation: 'create', kind: 'workflow', scopeKey: 'reporting.weekly', ruleKey: 'weekly-report.risks-first',
        instruction: 'Lead weekly reports with current risks.', confidence: 0.98,
        skillSlugs: ['weekly-risk-report'],
        rationale: 'The manager explicitly narrated this order.', evidenceRefs: ['transcript:1', 'frame:1'],
      }],
    });
    const mixedConfidencePatch = managerTeachLearningPatchSchema.parse({
      ...patch,
      changes: [{ ...patch.changes[0], confidence: 0.85 }],
    });
    await assert.rejects(
      processor.apply({
        companyId: 'company-1', managerId: 'manager-1', departmentId: 'department-1', sessionId: 'teach-1',
        mutationKey: 'teach-1-low-confidence', patch: mixedConfidencePatch,
      }),
      /persona "weekly-report\.risks-first" \(0\.85\).*required confidence 0\.90.*corrected atomic patch/s,
    );
    assert.equal(transactionOptions, undefined);

    const first = await processor.apply({
      companyId: 'company-1', managerId: 'manager-1', departmentId: 'department-1', sessionId: 'teach-1',
      mutationKey: 'teach-1-initial-write', patch,
    });
    assert.equal(first.status, 'completed');
    assert.equal(first.appliedChangeCount, 2);
    assert.equal(first.appliedPersonaChangeCount, 1);
    assert.equal(first.appliedSkillCount, 1);
    assert.equal(first.remainingUndos, 1);
    assert.equal(session.status, 'completed');
    assert.equal(nodes.length, 1);
    assert.equal(skills.length, 1);
    assert.deepEqual(skillLinks, [{ personaNodeId: 'node-1', skillId: 'skill-1' }]);
    assert.equal(provenance.length, 2);
    assert.deepEqual(provenance.map(row => row.decision).sort(), ['create', 'create']);
    assert.deepEqual(transactionOptions, { maxWait: 10_000, timeout: 30_000 });

    const second = await processor.apply({
      companyId: 'company-1', managerId: 'manager-1', departmentId: 'department-1', sessionId: 'teach-1',
      mutationKey: 'teach-1-initial-write', patch,
    });
    assert.deepEqual(second, first);
    assert.equal(nodes.length, 1);
    assert.equal(skills.length, 1);
    await rm(dir, { recursive: true, force: true });
  });
});
