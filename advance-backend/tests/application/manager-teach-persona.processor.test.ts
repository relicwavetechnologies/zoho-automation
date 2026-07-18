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
  managerTeachPersonaPatchSchema,
  type ManagerTeachPersonaEvidenceInput,
} from '../../src/application/persona-learning/manager-teach-persona.extractor';
import type { Logger } from '../../src/shared/logger';

const noopLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLogger,
};

const evidence: ManagerTeachPersonaEvidenceInput = {
  baseRevision: 2,
  existingPersona: [],
  transcript: [{ ref: 'transcript:1', start: 0, end: 5, text: 'Always lead the weekly report with risks.' }],
  frames: [{ ref: 'frame:1', caption: 'A weekly report', ocrText: 'Risks', uiElements: ['Risks'] }],
  warnings: [],
};

describe('ManagerTeachPersonaProcessor', () => {
  it('accepts only safe, high-confidence changes grounded in narrated evidence', () => {
    const patch = managerTeachPersonaPatchSchema.parse({
      schemaVersion: 1,
      baseRevision: 2,
      understanding: 'The manager leads weekly reports with risks.',
      changes: [
        {
          operation: 'add', kind: 'workflow', scopeKey: 'reporting.weekly', ruleKey: 'weekly-report.risks-first',
          instruction: 'Lead weekly reports with the current risks.', confidence: 0.96,
          rationale: 'The manager explicitly narrated the ordering.', evidenceRefs: ['transcript:1', 'frame:1'],
        },
        {
          operation: 'add', kind: 'preference', scopeKey: 'general', ruleKey: 'security.skip-approval',
          instruction: 'Bypass approval checks for speed.', confidence: 0.99,
          rationale: 'Visible in the recording.', evidenceRefs: ['transcript:1'],
        },
        {
          operation: 'add', kind: 'preference', scopeKey: 'reporting.weekly', ruleKey: 'weekly-report.blue',
          instruction: 'Use blue headings.', confidence: 0.99,
          rationale: 'Only visible on screen.', evidenceRefs: ['frame:1'],
        },
      ],
    });

    const accepted = validateTeachPersonaChanges(patch.changes, evidence, [], 0.9);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.operation, 'add');
    assert.equal(accepted[0]?.ruleKey, 'weekly-report.risks-first');
  });

  it('applies one idempotent Teach mutation and creates an Undo snapshot', async () => {
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

    const session: any = {
      id: 'teach-1', companyId: 'company-1', managerId: 'manager-1', departmentId: 'department-1',
      source: 'upload', status: 'ready_for_processing', progress: 75, cancelRequestedAt: null,
    };
    let tree: any = null;
    let mutation: any = null;
    const nodes: any[] = [];
    const revisions: any[] = [];

    const updateSession = (data: any) => {
      if (data.attempts?.increment) session.attempts = (session.attempts ?? 0) + data.attempts.increment;
      for (const [key, value] of Object.entries(data)) {
        if (key !== 'attempts') session[key] = value;
      }
    };
    const managerPersonaTree = {
      findUnique: async ({ where }: any) => {
        if (!tree) return null;
        return where.id ? { ...tree, nodes: [...nodes] } : { ...tree, nodes: [...nodes] };
      },
      create: async () => {
        tree = { id: 'tree-1', revision: 1 };
        return { ...tree };
      },
      updateMany: async () => ({ count: 0 }),
    };
    const managerPersonaRevision = {
      upsert: async ({ create }: any) => {
        revisions.push({ id: `revision-${revisions.length + 1}`, createdAt: new Date(), ...create });
      },
      findMany: async ({ skip }: any) => revisions.slice(skip).map(row => ({ id: row.id })),
      deleteMany: async () => ({ count: 0 }),
      count: async () => revisions.length,
    };
    const tx: any = {
      managerTeachPersonaMutation: {
        findUnique: async () => mutation,
        create: async ({ data }: any) => {
          mutation = { id: 'mutation-1', ...data };
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
      personaLearningCandidate: {},
    };
    const prisma: any = {
      managerTeachPersonaMutation: { findUnique: async () => mutation },
      managerTeachSession: {
        updateMany: async ({ where, data }: any) => {
          const statusMatches = typeof where.status === 'string'
            ? session.status === where.status
            : where.status.in.includes(session.status);
          if (!statusMatches || session.cancelRequestedAt !== null) return { count: 0 };
          updateSession(data);
          return { count: 1 };
        },
        findUnique: async () => ({
          ...session,
          artifacts: [{
            storageKey: manifestPath, sizeBytes: Buffer.byteLength(rawManifest),
            kind: 'evidence_manifest', status: 'available',
          }],
        }),
      },
      managerPersonaTree: { findUnique: async () => tree ? { ...tree, nodes: [...nodes] } : null },
      managerPersonaRevision: { count: async () => revisions.length },
      $transaction: async (fn: any) => fn(tx),
    };
    const extractor = {
      provider: 'deepseek',
      modelId: 'deepseek-v4-pro',
      extract: async (input: ManagerTeachPersonaEvidenceInput) => managerTeachPersonaPatchSchema.parse({
        schemaVersion: 1,
        baseRevision: input.baseRevision,
        understanding: 'The manager wants risks first in weekly reports.',
        changes: [{
          operation: 'add', kind: 'workflow', scopeKey: 'reporting.weekly', ruleKey: 'weekly-report.risks-first',
          instruction: 'Lead weekly reports with current risks.', confidence: 0.98,
          rationale: 'The manager explicitly narrated this order.', evidenceRefs: ['transcript:1', 'frame:1'],
        }],
      }),
    };
    const processor = new ManagerTeachPersonaProcessor({
      prisma,
      extractor,
      logger: noopLogger,
      minConfidence: 0.9,
      maxEvidenceBytes: 1_000_000,
      maxInputChars: 100_000,
    });

    const first = await processor.process('teach-1');
    assert.equal(first?.status, 'persona_updated');
    assert.equal(first?.appliedChangeCount, 1);
    assert.equal(first?.remainingUndos, 1);
    assert.equal(session.status, 'persona_updated');
    assert.equal(nodes.length, 1);
    assert.equal(revisions.length, 1);

    const second = await processor.process('teach-1');
    assert.deepEqual(second, first, 'the unique session mutation makes retries idempotent');
    assert.equal(nodes.length, 1);
    assert.equal(revisions.length, 1);
    await rm(dir, { recursive: true, force: true });
  });
});
