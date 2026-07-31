import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DeepSeekPersonaLearningExtractor, parseModelJson } from '../../src/application/persona-learning/persona-learning.extractor';
import { textModel } from '../helpers/mock-model';

describe('DeepSeekPersonaLearningExtractor', () => {
  it('accepts schema-valid observations and removes semantic duplicates within one run', async () => {
    const extractor = new DeepSeekPersonaLearningExtractor(textModel(JSON.stringify({
      schemaVersion: 1,
      observations: [
        {
          kind: 'preference',
          scopeKey: 'reporting.weekly',
          ruleKey: 'weekly-report.bullets',
          claim: 'Use bullet-point summaries.',
          rationale: 'The manager explicitly asked for bullets.',
          evidenceStrength: 'explicit',
        },
        {
          kind: 'preference',
          scopeKey: 'reporting.weekly',
          ruleKey: 'weekly-report.bullets',
          claim: 'Use   bullet-point summaries.',
          rationale: 'Duplicate statement.',
          evidenceStrength: 'explicit',
        },
      ],
    })), 'deepseek-v4-flash');

    const result = await extractor.extract({
      companyId: 'company-1',
      departmentId: 'dept-1',
      managerId: 'manager-1',
      evidenceId: 'evidence-1',
      context: { userMessages: ['Use bullets.'], assistantResponse: 'Done.' },
      tools: [],
      existingCandidateClaims: [],
    });

    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0]?.evidenceStrength, 'explicit');
  });

  it('rejects malformed model output rather than writing an unconstrained candidate', async () => {
    const extractor = new DeepSeekPersonaLearningExtractor(textModel('{"observations":"not an array"}'), 'deepseek-v4-flash');
    await assert.rejects(
      extractor.extract({
        companyId: 'company-1',
        departmentId: 'dept-1',
        managerId: 'manager-1',
        evidenceId: 'evidence-1',
        context: { userMessages: ['Use bullets.'] },
        tools: [],
        existingCandidateClaims: [],
      }),
      /invalid JSON/,
    );
  });

  it('parses a fenced JSON response without accepting extra prose', () => {
    assert.deepEqual(parseModelJson('```json\n{"schemaVersion":1,"observations":[]}\n```'), {
      schemaVersion: 1,
      observations: [],
    });
  });
});
